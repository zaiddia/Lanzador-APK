'use strict';
/**
 * Empaquetado portátil: genera dist/LanzadorAPK-win64-portable/
 *   LanzadorAPK.exe (electron.exe renombrado + icono y recursos de versión) + resources/app (código de la app)
 * No necesita instalador; se descomprime y se usa.
 *
 * Con --full (o LANZADORAPK_PACK_FULL=1) genera la «versión completa»:
 *   copia además build/runtime a resources/runtime; se descomprime y funciona sin descargar nada en el primer arranque.
 *   La carpeta de salida por defecto es dist/LanzadorAPK-v<versión>-win64-full y no sobrescribe la versión ligera.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertStandalone } = require('./guard-standalone');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const FULL = process.argv.includes('--full') || process.env.LANZADORAPK_PACK_FULL === '1';
// Permite indicar la carpeta de salida (por si la de destino la ocupa una instancia en ejecución: compilar en otro lugar y luego reemplazar)
let OUT = process.env.LANZADORAPK_PACK_OUT
  ? path.resolve(process.env.LANZADORAPK_PACK_OUT)
  : path.join(ROOT, 'dist', FULL ? `LanzadorAPK-v${PKG.version}-win64-full` : 'LanzadorAPK-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

// En Windows, fs.cpSync al copiar un árbol con «muchos archivos pequeños + imágenes grandes» a veces da
// EINPROGRESS (Node lo reporta mal como "not enough space on the disk", aunque queden cientos de GB).
// Se usa una recursión simple con copyFileSync archivo por archivo: un poco más lenta, pero cada archivo es una llamada independiente,
// no la interrumpen carreras a nivel de árbol y no se cuelga en shells administrados como robocopy.
function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copy(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log(FULL ? '打包完整版（含运行时）→' : '打包便携版 →', OUT);
// Si el destino existe no se borra entero: algunos entornos bloquean borrados masivos y si el empaquetado falla a mitad se pierde
// la última versión útil. Se renombra la carpeta antigua para conservarla y se compila desde cero; si está en uso se cambia de carpeta.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('旧版本已保留 →', backup);
  } catch (_) {
    // Algunos entornos (antivirus / indexador / Explorador) retienen el identificador de la carpeta mucho tiempo,
    // y renombrarla da EBUSY; entonces se usa una carpeta con número de versión: el resultado sirve igual y no choca de nombre.
    OUT = path.join(ROOT, 'dist', `LanzadorAPK-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('旧目录被占用，改输出到 →', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Runtime de Electron
console.log('复制 Electron 运行时…');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Reducción de idiomas: Electron trae 55 idiomas (41 MB en total) y la interfaz solo usa español.
//     Solo se conservan es / es-419 / en-US; el resto se borra (-39 MB, un 15 % menos de paquete).
const KEEP_LOCALES = new Set(['es.pak', 'es-419.pak', 'en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* Si no existe la carpeta locales no pasa nada */ }

// 1.2 Archivos que nadie abre: registros de cambios, símbolos de depuración, algunos pak inútiles (0,1–9 MB cada uno)
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Librerías que se pueden quitar:
//     d3dcompiler_47.dll compila el HLSL de ANGLE a instrucciones de GPU, pero desde Windows 8.1
//     System32 trae una DLL con el mismo nombre; si LoadLibrary no encuentra la del paquete usa la del sistema.
//     Probado: sin ella la interfaz, los iconos y las fuentes se ven igual (sin diferencias en las capturas --smoke). Ahorra 2,1 MB comprimido.
//     Atención: vk_swiftshader.dll / vulkan-1.dll no se pueden borrar: si el controlador de GPU no sirve, Chromium
//     los usa como respaldo por software; sin ellos la pantalla queda en blanco.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* Ya no existía */ }
}

// 2. La app
// assets/ (si existe) contiene recursos que se distribuyen con la app.
console.log('复制应用…');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'assets', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 2.1 Dependencias de producción (módulos nativos): copiar solo src/ no basta; también hay que llevar las dependencias npm de ejecución.
// Caso típico: @napi-rs/lzma descomprime system.img.xz / vendor.img.xz,
// está en dependencies de package.json y el pack.js anterior nunca copiaba node_modules.
// El resultado era «instalada pero al abrir una app no pasa nada»: al descomprimir la imagen salía Cannot find module '@napi-rs/lzma',
// el runtime no arrancaba y las cuatro combinaciones de parámetros terminaban en boot-failed. Así se produjo la regresión grave de 0.5.9.
// Los paquetes con ámbito (@scope/name) se copian con todo el ámbito, porque los binarios nativos
// suelen estar como optionalDependency en el mismo ámbito (p. ej. @napi-rs/lzma-win32-x64-msvc).
const prodDeps = Object.keys((require(path.join(ROOT, 'package.json')).dependencies) || {});
if (prodDeps.length) {
  console.log(`复制生产依赖（${prodDeps.length}）：${prodDeps.join(', ')}`);
  const destModules = path.join(appDir, 'node_modules');
  for (const dep of prodDeps) {
    if (dep.startsWith('@')) {
      const scope = dep.split('/')[0];
      const scopeSrc = path.join(ROOT, 'node_modules', scope);
      if (fs.existsSync(scopeSrc)) copy(scopeSrc, path.join(destModules, scope));
    } else {
      const depSrc = path.join(ROOT, 'node_modules', dep);
      if (fs.existsSync(depSrc)) copy(depSrc, path.join(destModules, dep));
    }
  }
}

// 3. Carpetas opcionales
// De engine/ solo se distribuye la documentación; los componentes grandes del runtime (emulator, system-images,
// platform-tools, avd) los descarga la app desde la fuente oficial en el primer arranque y no van en el instalador.
// tools/ son scripts de comprobación para desarrollo (ventanas negras, velocidad); el usuario no los usa y ya no se distribuyen.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    copy(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

// 3.5 Versión completa: incluye también el runtime (emulator + platform-tools + imagen del sistema)
if (FULL) {
  const runtime = path.join(ROOT, 'build', 'runtime');
  const runtimeExe = path.join(runtime, 'emulator', 'emulator.exe');
  if (!fs.existsSync(runtimeExe)) {
    console.error('\n[!] 找不到 build/runtime/emulator/emulator.exe。');
    console.error('    先跑 node build/prepare-runtime.js（npm run runtime）生成运行时，再打完整版。\n');
    process.exit(1);
  }
  console.log('内置运行时（约 1 GB，需要一会儿）…');
  // La carpeta del runtime puede tener restos de desarrollo: userdata.img.broken (de una descompresión fallida),
  // *.part (descompresión interrumpida), *.new (temporal de una recompresión). Ocupan espacio y no sirven,
  // e incluso podrían meter una imagen dañada en la versión publicada; se omiten, no se copian.
  // Antes de empaquetar se verifica que los .img.xz estén completos: un xz truncado solo falla a mitad de la descompresión
  // ("failed to fill whole buffer"), y para entonces el usuario ya instaló el programa; el síntoma es
  // «instalado pero ninguna app abre». A la 0.5.9 la afectó un system.img.xz truncado
  // (495 MB que solo daban 1366 MB de los 2958 MB esperados). Un flujo xz completo siempre termina con un pie
  // y en los últimos 8 bytes aparece "YZ"; si no está, no se terminó de escribir.
  const walkXz = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkXz(p); continue; }
      if (!/\.img\.xz$/i.test(e.name)) continue;
      const size = fs.statSync(p).size;
      const fd = fs.openSync(p, 'r');
      let tail;
      try {
        const n = Math.min(8, size);
        tail = Buffer.alloc(n);
        fs.readSync(fd, tail, 0, n, size - n);
      } finally { fs.closeSync(fd); }
      if (!tail.includes(Buffer.from('YZ'))) {
        console.error(`\n[!] 镜像不完整（缺 xz footer，多半是下载被截断）：${p}`);
        console.error(`    大小 ${(size / 1048576).toFixed(1)} MB。请重新获取该镜像后再打包。\n`);
        process.exit(1);
      }
    }
  };
  walkXz(runtime);
  // Ojo: .pynew es el temporal de recompresión (versión python) y, como .new, debe excluirse.
  const JUNK = /(\.broken|\.part|\.new|\.pynew|\.tmp|\.bak)$/i;
  const copyRuntime = (src, dest) => {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        if (JUNK.test(entry)) continue;
        copyRuntime(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  };
  copyRuntime(runtime, path.join(OUT, 'resources', 'runtime'));
}

// 3.6 Vigilante de independencia: el resultado no puede contener MuMu / LDPlayer / BlueStacks u otros emuladores de terceros.
// Si hay coincidencia la compilación falla: estos problemas solo aparecen «en el equipo de otro» y localmente nunca se detectan.
assertStandalone(path.join(OUT, 'resources'), { label: '便携版 resources' });

// 4. Renombrar el ejecutable principal
const exePath = path.join(OUT, 'LanzadorAPK.exe');
fs.renameSync(path.join(OUT, 'electron.exe'), exePath);

/**
 * Escribe el icono y los recursos de versión en LanzadorAPK.exe.
 *
 * Por qué es necesario: un exe solo renombrado sigue siendo Electron por dentro:
 * FileDescription=Electron, ProductName=Electron, CompanyName=GitHub, Inc.,
 * versión 33.4.11 y el icono de Electron. Así el Explorador, los anclajes de la barra de tareas,
 * las propiedades de los accesos directos y el antivirus/información del sistema muestran «Electron» y el icono por defecto,
 * y el usuario ve «el icono por defecto».
 *
 * rcedit es la misma herramienta que usan electron-builder / electron-winstaller;
 * aquí se usa la copia de node_modules, sin necesidad de internet.
 */
function embedExeMeta(exe) {
  const rcedit = [
    path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  ].find((p) => fs.existsSync(p));
  if (!rcedit) {
    console.warn('  [!] 找不到 rcedit.exe，exe 图标/版本信息保持 Electron 默认值');
    return false;
  }
  const ico = path.join(ROOT, 'src', 'ui', 'assets', 'appicon.ico');
  if (!fs.existsSync(ico)) {
    console.warn(`  [!] 找不到 ${ico}，跳过图标写入`);
    return false;
  }
  const args = [
    exe,
    '--set-icon', ico,
    // Versión de archivo de cuatro partes (igual que MSIX); la versión de producto usa tres
    '--set-file-version', `${PKG.version}.0`,
    '--set-product-version', PKG.version,
    '--set-version-string', 'ProductName', 'LanzadorAPK',
    '--set-version-string', 'FileDescription', 'LanzadorAPK — Ejecutor de apps Android',
    '--set-version-string', 'CompanyName', PKG.author || 'zaiddia',
    '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 LanzadorAPK',
    '--set-version-string', 'OriginalFilename', 'LanzadorAPK.exe',
    '--set-version-string', 'InternalName', 'LanzadorAPK',
  ];
  try {
    execFileSync(rcedit, args, { stdio: 'pipe', windowsHide: true });
    console.log(`  exe 图标/版本已写入（${PKG.version}，FileDescription=LanzadorAPK — Ejecutor de apps Android）`);
    return true;
  } catch (e) {
    console.warn(`  [!] rcedit 失败：${e.message}`);
    return false;
  }
}
embedExeMeta(exePath);

// 5. Información de versión
const pkg = PKG;
const fullNote = FULL ? '完整版（内置运行时，装完不联网）' : '轻量版（首次启动下载运行时）';
fs.writeFileSync(path.join(OUT, 'VERSION.txt'),
  `LanzadorAPK ${pkg.version}\n${fullNote}\n构建时间：${new Date().toLocaleString('es')}\n`);

// 6. Informe de tamaño: se imprime en cada empaquetado para que no vuelva a crecer sin darnos cuenta
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `完成。整包 ${totalMB.toFixed(0)} MB（语言包省了 ${(localeSaved / 1048576).toFixed(0)} MB，`
  + `冗余运行库省了 ${(pruneSaved / 1048576).toFixed(1)} MB）。`,
);
console.log('压缩：node build/zip.js ' + path.relative(ROOT, OUT) + ' <输出.zip>');
console.log(`运行 ${path.join(OUT, 'LanzadorAPK.exe')} 即可使用。`);
if (!FULL) console.log('想要「一次下载、装完不联网」的完整版：node build/pack.js --full');
