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
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'arm64 的 QEMU 二进制（只发 x86_64 镜像）'],
  // Atención: no se puede borrar la carpeta emulator/lib64/vulkan entera: vulkan-1.dll es el cargador de -gpu host;
  // sin él host falla y solo queda el renderizado por software (probado: en AMD 780M es imprescindible). Solo se borran los archivos grandes:
  ['emulator/lib64/vulkan/layers', 'Vulkan 校验层（host 渲染用不到，-20MB）'],
  ['emulator/lib64/vulkan/glslangValidator.exe', '着色器校验工具（运行时用不到，-7MB）'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'lavapipe 软件 Vulkan 后备（有系统显卡驱动时用不到，-53MB）'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'lavapipe 的 ICD 描述（-1KB）'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan（gles_angle 目录里有同款副本，-23MB）'],
  ['emulator/lib64/qt/translations', '模拟器界面的多语言包（只剩 38px 标题栏）'],
  // Atención: no se puede borrar emulator-check.exe: emulator -accel-check lo usa para detectar AEHD/WHPX;
  // sin él se considera «sin aceleración por hardware» y se vuelve a la emulación TCG (probado: el arranque pasa de 42 s a más de 10 minutos).
  ['emulator/qsn.exe', 'QEMU 快照通知助手（emulator.exe 无任何引用，已 strings 实证，-34MB）'],
  ['emulator/resources/Toren1BD_Main.png', 'VR 全景环境贴图（红果用不到，-3.7MB）'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR 全景装饰贴图（-3.5MB）'],
  ['emulator/resources/Toren1BD.obj', 'VR 全景 3D 模型（-3.5MB）'],
  ['emulator/resources/macroPreviews', '宏操作预览图（-2.7MB）'],
  ['emulator/resources/default360.mp4', '360° 全景默认视频（-2.4MB）'],
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
    throw new Error(`${root} 不是一个运行时目录（缺 emulator/emulator.exe）`);
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
        log(`  跳过 ${rel}：${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  删除 ${rel}（${(n / 1048576).toFixed(0)} MB）— ${why}`);
  }
  log(`${dryRun ? '可释放' : '已释放'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`瘦身目标：${root}（${aggressive ? '激进' : '安全'}档）`);
  slim(root, { aggressive, dryRun });
}
