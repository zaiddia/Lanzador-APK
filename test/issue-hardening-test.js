'use strict';
/**
 * Pruebas en Node puro del refuerzo a partir de las issues (sin emulador/red/registro).
 *
 * Cubre los 5 puntos aplicados en esta ronda a partir de las issues de GitHub:
 *  - #2 P0-1: nombre de paquete del APK sin validar → escritura en cualquier ruta / inyección de comandos adb
 *  - #2 P0-4: la descompresión de provision/updater no tenía protección contra zip-slip
 *  - #2 P1-1: si _fetchText superaba el límite la Promise nunca se resolvía
 *  - #51: la desinstalación con un clic de la versión instalada se tomaba como portátil (nombre del desinstalador inconsistente en dos lugares)
 *  - #98: la versión portátil no se reiniciaba tras descargar la actualización → bucle infinito (falso positivo al verificar la copia + carga borrada)
 *
 * Ejecutar: node test/issue-hardening-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { validPackageName, safeFilePart } = require('../src/core/pkgname');
const { resolveZipEntry } = require('../src/core/zip');
const store = require('../src/core/store');
const { findUninstaller, Updater } = require('../src/core/updater');
const { Provisioner } = require('../src/core/provision');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-hardening-'));

(async () => {
  console.log('\n[issue #2 P0-1 · validación del nombre de paquete]');
  test('Los nombres de paquete Android válidos pasan', () => {
    for (const p of ['com.github.tvbox.osc', 'com.tencent.mm', 'org.example.app_2']) {
      assert.equal(validPackageName(p), true, `${p} debería ser válido`);
    }
  });
  test('Se rechazan recorrido de rutas / letras de unidad / metacaracteres de shell / espacios', () => {
    for (const p of ['../evil', 'com..x', '.com.x', 'com/x', 'com\\x', 'C:evil', 'a;rm -rf', 'a|b',
      'a b', 'a$(id)', 'a`id`', '', 'com.x.', '1com.x', 'com.x-y']) {
      assert.equal(validPackageName(p), false, `${JSON.stringify(p)} debería rechazarse`);
    }
  });
  test('Los nombres de paquete inválidos se convierten en nombres de archivo seguros', () => {
    const safe = safeFilePart('../evil');
    assert.ok(!safe.includes('/') && !safe.includes('\\') && !safe.includes('..'), `Tras convertir no debe haber caracteres de ruta: ${safe}`);
    assert.equal(safeFilePart('com.ok.pkg'), 'com.ok.pkg');
  });
  test('Las rutas de iconos/APK de store no pueden salir de la carpeta de datos', () => {
    const icon = store.iconPath('../../Windows/System32/drivers/etc/hosts');
    const apk = store.apkPath('../../evil', '../../x');
    assert.ok(!icon.includes('..'), `La ruta del icono no debe contener ..: ${icon}`);
    assert.ok(!apk.includes('..'), `La ruta del APK no debe contener ..: ${apk}`);
    assert.match(path.basename(apk), /\.apk$/);
  });

  console.log('\n[issue #2 P0-4 · zip-slip]');
  test('Las rutas relativas normales pasan', () => {
    const root = path.join(TMP, 'zip-ok');
    assert.equal(resolveZipEntry(root, 'emulator/qemu.exe'), path.join(root, 'emulator', 'qemu.exe'));
    assert.equal(resolveZipEntry(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
  });
  test('Se rechazan ../ / rutas absolutas / letras de unidad / recorrido con barras invertidas / UNC', () => {
    const root = path.join(TMP, 'zip-root');
    for (const n of ['../evil', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x', 'C:/Windows/x',
      'a\\..\\..\\evil', '\\\\server\\share\\x', 'a/../b']) {
      assert.equal(resolveZipEntry(root, n), null, `${JSON.stringify(n)} debería rechazarse`);
    }
  });
  test('El código de provision y de updater usa la guardia contra zip-slip', () => {
    const prov = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    const upd = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'updater.js'), 'utf8');
    assert.ok(/resolveZipEntry\(/.test(prov), 'provision.extractZip debe validar los nombres de entrada');
    assert.ok(/resolveZipEntry\(/.test(upd), 'updater._extract debe validar los nombres de entrada');
  });

  console.log('\n[issue #2 P1-1 · _fetchText ya no se cuelga]');
  await atest('Al superar el límite la Promise se resuelve, ya no queda sin resolver para siempre', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(64 * 1024) });
      res.end(Buffer.alloc(64 * 1024, 0x61));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/index.xml`;
    try {
      const p = new Provisioner({});
      const out = await Promise.race([
        p._fetchText(url, 1024),
        new Promise((_, rej) => setTimeout(() => rej(new Error('_fetchText se colgó sin resolverse')), 5000)),
      ]);
      assert.equal(out, '', 'El contenido que supera el límite debe descartarse; no se puede tomar lo parcial como completo');
    } finally {
      srv.close();
    }
  });
  test('El código de _fetchText tiene un cerrojo de resolución única y un tiempo límite estricto', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    assert.ok(/let done = false/.test(src) && /const finish = \(\) =>/.test(src), 'Debe tener un cerrojo de resolución única');
    assert.ok(/setTimeout/.test(src), 'Debe tener un tiempo límite estricto de respaldo');
  });

  console.log('\n[issue #51 · detección del desinstalador]');
  test('El Uninstall X.exe de electron-builder se reconoce como versión instalada', () => {
    const dir = path.join(TMP, 'uninst-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Uninstall LanzadorAPK.exe'), 'x');
    assert.equal(findUninstaller(dir), 'Uninstall LanzadorAPK.exe');
  });
  test('El uninstaller.exe antiguo también se reconoce', () => {
    const dir = path.join(TMP, 'uninst-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'uninstaller.exe'), 'x');
    assert.equal(findUninstaller(dir), 'uninstaller.exe');
  });
  test('La versión portátil (sin desinstalador) devuelve null', () => {
    const dir = path.join(TMP, 'uninst-c');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findUninstaller(dir), null);
  });

  console.log('\n[issue #98 · bucle infinito de actualización sin reinicio]');
  await atest('Una carga lista puede recuperarse para continuar; con versión distinta o sin exe no sirve', async () => {
    const dataDir = path.join(TMP, 'upd-resume');
    const exe = path.join(dataDir, 'LanzadorAPK.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });

    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'LanzadorAPK.exe'), 'new');
    assert.equal(u.findResumableJob(), null, 'Sin marca de listo no debe reutilizarse');
    u._markPayloadReady(payload, '0.5.4');
    const job = u.findResumableJob();
    assert.ok(job && job.version === '0.5.4', 'Debería recuperar la tarea pendiente de 0.5.4');

    // Versión más vieja que la actual → no se reutiliza
    const cur = new Updater({ currentVersion: '0.5.4', exePath: exe, isPackaged: true, dataDir });
    assert.equal(cur.findResumableJob(), null, 'Una carga no inferior a la versión actual no puede continuarse');
    // La versión marcada no coincide → no se reutiliza
    fs.writeFileSync(u._readyFile(payload), JSON.stringify({ version: '0.5.2' }));
    assert.equal(u.findResumableJob(), null, 'Si la versión marcada no coincide no se puede reutilizar');
  });
  test('El script apply verifica el reemplazo por número de bytes, conserva la carga si falla y reinicia por dos rutas', () => {
    const dataDir = path.join(TMP, 'upd-apply');
    const exe = path.join(dataDir, 'LanzadorAPK.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'old');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'LanzadorAPK.exe'), 'new-version-bytes');
    const script = u.apply({ mode: 'zip', payload, version: '0.5.4' }, { spawn: false });
    assert.ok(/\(Get-Item \$target\)\.Length -eq \$expected/.test(script), 'Debe verificar el exe nuevo por número de bytes');
    assert.ok(/keeping payload for next launch/.test(script), 'Si la copia falla debe conservarse la carga para continuar');
    assert.ok(/Start-Process -FilePath/.test(script) && /cmd\.exe/.test(script), 'El reinicio debe tener una ruta de respaldo');
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Error:', e.stack || e.message);
  process.exit(1);
});
