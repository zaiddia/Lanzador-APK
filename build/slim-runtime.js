'use strict';
/**
 * Reducción del runtime: borra archivos del emulador que «nuestra forma de arrancar nunca carga».
 *
 * Se basa en los parámetros de arranque fijos de emulator.js:
 *   - solo imagen x86_64 (API30 AOSP)      → qemu-system-aarch64.exe no se usa
 *   - -gpu software (renderizado swiftshader) → los backends vulkan / gles_angle no se usan
 *   - la interfaz solo conserva una barra de título de 38 px → los idiomas de la interfaz del emulador y el panel WebEngine no se usan
 *
 * netsimd / netsim / nimble_bridge, que tienen que ver con la red, siempre se conservan:
 * llevan los datos de wifi / bluetooth; sin ellos las apps no tienen internet, es el mínimo para que funcione.
 *
 * Uso:
 *   node build/slim-runtime.js build/runtime          # nivel seguro (por defecto)
 *   node build/slim-runtime.js build/runtime --aggressive   # borra además QtWebEngine (-169 MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Nivel seguro: borra lo que de verdad nunca se carga (unos -190 MB).
 * Límites confirmados probando cada borrado por separado (importante, no agregar a la ligera):
 *   - Qt6WebEngineCoreAndroidEmu.dll es dependencia directa de emulator.exe (importación estática); sin ella no arranca → se conserva
 *   - lib64/gles_angle aporta vk_swiftshader, del que depende el renderizado swiftshader → se conserva
 *   - borrar lib64/vulkan solo vuelve al renderizado por software (probado: arranca y renderiza bien), aunque tampoco pesa mucho → se borra, ahorra 103 MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'binarios QEMU arm64 (solo se distribuyen imágenes x86_64)'],
  // Atención: no se puede borrar la carpeta emulator/lib64/vulkan entera: vulkan-1.dll es el cargador de -gpu host;
  // sin él host falla y solo queda el renderizado por software (probado: en AMD 780M es imprescindible). Solo se borran los archivos grandes:
  ['emulator/lib64/vulkan/layers', 'capas de validación de Vulkan (el renderizado host no las usa, -20MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'herramientas de validación de shaders (no se usan en ejecución, -7MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'respaldo Vulkan por software lavapipe (no se usa si hay controlador de GPU, -53MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'descripción ICD de lavapipe (-1KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (hay una copia igual en la carpeta gles_angle, -23MB)'],
  ['emulator/lib64/qt/translations', 'paquetes de idioma de la interfaz del emulador (solo queda la barra de título de 38px)'],
  // Atención: no se puede borrar emulator-check.exe: emulator -accel-check lo usa para detectar AEHD/WHPX;
  // sin él se considera «sin aceleración por hardware» y se vuelve a la emulación TCG (probado: el arranque pasa de 42 s a más de 10 minutos).
  ['emulator/qsn.exe', 'asistente de notificaciones de instantáneas de QEMU (emulator.exe no lo referencia, comprobado con strings, -34MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'texturas de entorno panorámico VR (no se usan, -3.7MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'texturas decorativas panorámicas VR (-3.5MB)'],
  ['emulator/resources/Toren1BD.obj', 'modelos 3D panorámicos VR (-3.5MB)'],
  ['emulator/resources/macroPreviews', 'imágenes de vista previa de macros (-2.7MB)'],
  ['emulator/resources/default360.mp4', 'video panorámico 360° por defecto (-2.4MB)'],
];

/** El nivel agresivo está vacío por ahora: WebEngine es dependencia directa y gles_angle lo necesita el renderizado por software; no se pueden borrar */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* Se ignora */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} no es una carpeta de runtime (falta emulator/emulator.exe)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  Se omite ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  Borrando ${rel} (${(n / 1048576).toFixed(0)} MB) — ${why}`);
  }
  log(`${dryRun ? 'se pueden liberar' : 'liberados'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Objetivo de reducción: ${root} (${aggressive ? 'agresivo' : 'seguro'} nivel)`);
  slim(root, { aggressive, dryRun });
}
