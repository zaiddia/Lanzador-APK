'use strict';
/**
 * Pruebas en Node puro del funcionamiento independiente: sin Electron, sin emulador y sin internet.
 *
 * Protegen un límite del producto (restricción estricta desde 0.5.6):
 *   **LanzadorAPK, en cualquier equipo, con cualquier configuración y cualquier resto de configuración, solo ejecuta su runtime propio.**
 *
 * En concreto se vigilan tres cosas:
 *   1. en el código no hay ningún archivo de implementación de bases de terceros (MuMu / LDPlayer / BlueStacks / WSA / FydeOS);
 *   2. aunque settings.json diga mode=mumu / fydeos / attach, solo se obtiene builtin;
 *   3. en el paquete generado no puede haber binarios ni carpetas de emuladores de terceros.
 *
 * Ejecutar: node test/standalone-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findBundled, findForbiddenSource, assertStandalone } = require('../build/guard-standalone');
const backends = require('../src/core/backends');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lanzadorapk-${name}-`));
  return d;
}
function touch(dir, rel, bytes = 8) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

(() => {
  console.log('\n[Funcionamiento independiente · una sola base]');

  const store = require('../src/core/store');
  const settings = store.getSettings();

  test('El motor por defecto es el runtime propio', () => {
    assert.equal(settings.engine.mode, 'builtin', `mode por defecto=${settings.engine.mode}`);
  });

  test('En el registro solo está builtin, no hay segunda base', () => {
    assert.equal(backends.REGISTRY.length, 1, `El registro tiene ${backends.REGISTRY.length} bases`);
    assert.deepEqual(backends.describe().map((d) => d.id), ['builtin']);
  });

  test('Cualquier mode que quede solo crea builtin (mumu / fydeos / attach / cualquier valor)', () => {
    for (const mode of ['mumu', 'fydeos', 'attach', 'ldplayer', 'whatever', '']) {
      const made = backends.create({
        appRoot: ROOT, settings: { engine: { mode } }, store, log: () => {},
      });
      assert.equal(made.id, 'builtin', `mode=${mode} creó ${made.id}`);
      assert.equal(made.backend.constructor.id, 'builtin', 'El tipo de instancia no es BuiltinBackend');
    }
  });

  test('Pasar otro id explícito tampoco lo cambia (la ruta de respaldo ya no crea bases de terceros)', () => {
    const made = backends.create({
      appRoot: ROOT, settings: { engine: { mode: 'builtin' } }, store, log: () => {}, id: 'mumu',
    });
    assert.equal(made.id, 'builtin', '¡Se aceptó id=mumu explícito!');
  });

  test('La elección automática ya no busca runtimes externos', async () => {
    // Aserción síncrona: autoPick debe «devolver builtin directamente»; en el código no puede aparecer probe()
    const src = read('src', 'core', 'backends', 'index.js');
    assert(!/\.probe\(/.test(src), 'El registro todavía busca emuladores externos');
    assert(!/mumu|fydeos|ldplayer|bluestacks/i.test(src.replace(/[\s\S]*?const REGISTRY[\s\S]*?\];/, '')),
      'El registro todavía tiene bases de terceros');
  });

  console.log('\n[Funcionamiento independiente · código de bases de terceros eliminado]');

  test('En backends/ solo están base / builtin / index', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src', 'core', 'backends')).sort();
    assert.deepEqual(files, ['base.js', 'builtin.js', 'index.js'], `Real: ${files.join(', ')}`);
  });

  test('Ya no existen los módulos mumu / fydeos / mumu-compat / frame', () => {
    for (const rel of [
      ['src', 'core', 'backends', 'mumu.js'],
      ['src', 'core', 'backends', 'fydeos.js'],
      ['src', 'core', 'mumu-compat.js'],
      ['src', 'core', 'frame.js'],
    ]) {
      assert.equal(exists(...rel), false, `${rel.join('/')} todavía existe`);
    }
  });

  test('El motor no tiene ramas del tipo «base de terceros no disponible → respaldo»', () => {
    const src = read('src', 'core', 'engine.js');
    assert(!/_fallbackFrom/.test(src), 'Todavía queda la marca de respaldo de bases de terceros');
    assert(!/backend\.id !== 'builtin'/.test(src), 'Todavía hay lógica que se bifurca según el id de base');
    assert(!/engine\.mode === 'attach'/.test(src), 'Todavía hay una rama attach (conectar a un runtime existente)');
    assert(!/ATTACH_ENDPOINTS/.test(src), 'Todavía se buscan los puertos adb de emuladores externos');
  });

  test('La configuración no tiene la lista de modo de motor ni campos de MuMu / FydeOS', () => {
    const html = read('src', 'ui', 'index.html');
    assert(!/setEngineMode/.test(html), 'La configuración todavía tiene la lista de modo de motor');
    assert(!/value="mumu"|value="fydeos"|value="attach"/.test(html), 'La configuración todavía tiene opciones de terceros');
    assert(!/setMumuPath|setMumuMemGB|setMumuCores|setFydeosHost/.test(html), 'La configuración todavía tiene campos de terceros');
    assert(/id="setEngineLabel"/.test(html), 'A la configuración le falta la explicación de solo lectura del runtime');
  });

  test('La capa de persistencia reescribe en el lugar los campos mode / mumu* que quedan', () => {
    const src = read('src', 'core', 'store.js');
    assert(/s\.engine\.mode = 'builtin'/.test(src), 'getSettings no fuerza mode=builtin');
    assert(/mumuPath/.test(src) && /delete s\.engine\[k\]/.test(src), 'No se limpian los campos de terceros que quedan');
  });

  test('Las rutas candidatas de adb no incluyen el adb de emuladores de terceros', () => {
    const src = read('src', 'core', 'adb.js');
    const block = src.slice(src.indexOf('const COMMON_ADB_PATHS'), src.indexOf('];', src.indexOf('const COMMON_ADB_PATHS')));
    assert(!/mumu|ldplayer|bluestacks|hd-adb/i.test(block), 'Todavía se usa el adb de un emulador de terceros');
  });

  console.log('\n[Funcionamiento independiente · el paquete no puede llevar otros emuladores]');

  test('La guardia reconoce los binarios de MuMu', () => {
    const d = tmpDir('guard-hit');
    touch(d, 'runtime/MuMuManager.exe');
    const hits = findBundled(d);
    assert.equal(hits.length, 1, `Coincidencias: ${hits.length}`);
    assert.equal(hits[0].vendor, 'emulador MuMu');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia reconoce las carpetas de MuMu (nx_main / nx_device / nemu)', () => {
    for (const dirName of ['nx_main', 'nx_device', 'nemu']) {
      const d = tmpDir('guard-dir');
      fs.mkdirSync(path.join(d, dirName), { recursive: true });
      touch(d, path.join(dirName, 'whatever.bin'));
      assert.equal(findBundled(d).length, 1, `${dirName} no se bloqueó`);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('La guardia también reconoce LDPlayer / BlueStacks', () => {
    const d = tmpDir('guard-others');
    touch(d, 'runtime/LDPlayer.exe');
    touch(d, 'runtime/Bluestacks.exe');
    const vendors = new Set(findBundled(d).map((h) => h.vendor));
    assert.ok(vendors.has('emulador LDPlayer'), 'LDPlayer no se bloqueó');
    assert.ok(vendors.has('emulador BlueStacks'), 'BlueStacks no se bloqueó');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia no afecta por error a nuestro propio runtime', () => {
    const d = tmpDir('guard-src');
    touch(d, 'app/src/core/backends/builtin.js', 64);
    touch(d, 'app/src/core/resources.js', 64);
    assert.equal(findBundled(d).length, 0, '¡Tomó nuestro propio código como un emulador!');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia bloquea el código de adaptadores de bases de terceros (para que no vuelva)', () => {
    const d = tmpDir('guard-adapter');
    touch(d, 'app/src/core/backends/mumu.js', 64);
    touch(d, 'app/src/core/backends/fydeos.js', 64);
    touch(d, 'app/src/core/mumu-compat.js', 64);
    const hits = findForbiddenSource(d);
    assert.equal(hits.length, 3, `Coincidencias: ${hits.length} (deberían ser 3)`);
    const r = assertStandalone(d, { label: '测试', exit: false });
    assert.equal(r.ok, false, 'El código del adaptador no hizo fallar a la guardia');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('La guardia no toma un frame.js normal / js de la app como base de terceros', () => {
    const d = tmpDir('guard-other-js');
    touch(d, 'app/src/render/frame.js', 64);
    touch(d, 'app/src/core/backends/builtin.js', 64);
    assert.equal(findForbiddenSource(d).length, 0, 'frame.js / builtin.js fuera de core no deben marcarse por error');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('Una carpeta de runtime limpia no da error', () => {
    const d = tmpDir('guard-clean');
    touch(d, 'runtime/emulator/emulator.exe', 64);
    touch(d, 'runtime/platform-tools/adb.exe', 64);
    const r = assertStandalone(d, { label: '测试', exit: false });
    assert.equal(r.ok, true, JSON.stringify(r.hits));
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('Si la carpeta no existe se omite la comprobación en vez de fallar', () => {
    const r = assertStandalone(path.join(os.tmpdir(), 'lanzadorapk-not-exist-xyz'), { exit: false });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  console.log('\n[Funcionamiento independiente · la cadena de compilación usa la guardia]');

  test('El empaquetado portátil revisa resources', () => {
    const src = read('build', 'pack.js');
    assert(/assertStandalone\(path\.join\(OUT, 'resources'\)/.test(src), 'pack.js no usa la guardia');
  });

  test('El empaquetado MSIX revisa la carga app/', () => {
    const src = read('build', 'msix.js');
    assert(/assertStandalone\(appDir/.test(src), 'msix.js no usa la guardia');
  });

  test('El paquete solo lleva build/runtime (runtime de Google), sin carpetas de otros emuladores', () => {
    const yml = read('electron-builder.yml');
    const block = yml.slice(yml.indexOf('extraResources:'));
    const head = block.slice(0, block.indexOf('win:'));
    assert(!/mumu|ldplayer|bluestacks/i.test(head), '¡Apareció un emulador de terceros en extraResources!');
    assert(/build\/runtime/.test(head), 'extraResources no incluye el runtime');
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
