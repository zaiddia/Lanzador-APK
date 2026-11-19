'use strict';
/**
 * Pruebas en Node puro de la extensión de controladores (parches de compatibilidad): sin Electron, sin emulador y sin internet.
 *
 * Aquí se protege el límite de que «por raro que sea el JSON del usuario, solo puede cambiar parámetros de la lista permitida, no puede ejecutar código en el equipo
 * ni borrar datos», además del comportamiento de coincidencia / combinación / importar y exportar.
 *
 * Ejecutar: node test/drivers-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lanzadorapk-drv-${name}-`));
}

const HOST = {
  platform: 'win32',
  arch: 'x64',
  totalMB: 16384,
  cores: 8,
  gpuVendor: 'amd',
  gpuName: 'AMD Radeon 780M',
  cpuVendor: 'amd',
  osBuild: 22631,
  accel: 'whpx',
  emulatorVersion: '36.4.9',
};

const base = () => ({
  format: drivers.DRIVER_FORMAT,
  id: 'test-driver',
  name: '测试驱动',
  version: '1.0.0',
  match: { any: true },
  effect: { gpuMode: 'swangle' },
});

(() => {
  console.log('\n[Controladores · validación]');

  test('Todos los ejemplos incluidos pasan la validación (si no, el usuario copiaría algo erróneo)', () => {
    const dir = path.join(ROOT, 'src', 'drivers');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    assert.ok(files.length >= 3, `Solo hay ${files.length} ejemplos incluidos`);
    for (const f of files) {
      const r = drivers.validateDriver(readJSON(path.join(dir, f)), { file: f });
      assert.equal(r.ok, true, `${f}: ${r.errors.join('；')}`);
    }
  });

  test('Un format incorrecto se rechaza directamente', () => {
    const d = { ...base(), format: 'something-else' };
    const r = drivers.validateDriver(d);
    assert.equal(r.ok, false);
    assert.ok(/format/.test(r.errors.join('')));
  });

  test('Un id con recorrido de rutas / espacios se rechaza (al importar el id se usa como nombre de archivo)', () => {
    for (const id of ['../evil', 'a b', 'x', 'name/../../etc/passwd']) {
      const r = drivers.validateDriver({ ...base(), id });
      assert.equal(r.ok, false, `id=${id} ¡pasó la validación!`);
    }
  });

  test('Un nombre de clave mal escrito en match da error, en vez de no aplicarse en silencio', () => {
    const r = drivers.validateDriver({ ...base(), match: { gpu: 'amd' } });
    assert.equal(r.ok, false);
    assert.ok(/match\.gpu/.test(r.errors.join('')));
  });

  test('Un campo mal escrito en effect da error', () => {
    const r = drivers.validateDriver({ ...base(), effect: { gpu: 'swangle' } });
    assert.equal(r.ok, false);
    assert.ok(/effect\.gpu/.test(r.errors.join('')));
  });

  console.log('\n[Controladores · lista permitida (no borrar datos / no ejecutar código)]');

  test('Se rechaza -wipe-data (borraría las apps y partidas del usuario)', () => {
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } });
    assert.equal(r.ok, false);
    assert.ok(/no permite -wipe-data/.test(r.errors.join('')), r.errors.join('；'));
  });

  test('Se rechazan -partition-size / -datadir / -sysdir', () => {
    for (const a of ['-partition-size=8192', '-datadir=D:/x', '-sysdir=D:/y']) {
      const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: [a] } });
      assert.equal(r.ok, false, `${a} ¡pasó la validación!`);
    }
  });

  test('-gpu solo acepta backends conocidos', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=host'] } }).ok, true);
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=../evil'] } });
    assert.equal(r.ok, false);
  });

  test('config.ini solo permite claves de la lista (no las que cambian la partición de datos / ubicación)', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle' } } }).ok, true);
    for (const k of ['disk.dataPartition.size', 'image.sysdir.1', 'hw.ramSize', 'hw.cpu.arch']) {
      const r = drivers.validateDriver({ ...base(), effect: { configIni: { [k]: '1' } } });
      assert.equal(r.ok, false, `${k} ¡pasó la validación!`);
    }
  });

  test('Los valores de config.ini / env no pueden tener saltos de línea (evita inyectar líneas nuevas)', () => {
    const a = drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle\nhw.ramSize=99999' } } });
    assert.equal(a.ok, false);
    const b = drivers.validateDriver({ ...base(), effect: { env: { ANDROID_X: 'a\nb' } } });
    assert.equal(b.ok, false);
  });

  test('env solo permite los prefijos ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { env: { ANDROID_EMU_BACKEND: 'x' } } }).ok, true);
    for (const k of ['PATH', 'SystemRoot', 'NODE_OPTIONS', 'LD_PRELOAD']) {
      const r = drivers.validateDriver({ ...base(), effect: { env: { [k]: 'x' } } });
      assert.equal(r.ok, false, `${k} ¡pasó la validación!`);
    }
  });

  test('El módulo de controladores no tiene eval / new Function / require dinámico de archivos del usuario', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'drivers.js'), 'utf8');
    assert(!/\beval\s*\(/.test(src), 'Apareció eval');
    assert(!/new\s+Function\s*\(/.test(src), 'Apareció new Function');
    assert(!/require\s*\(\s*(raw|d\.|driver)/.test(src), 'Apareció un require según el contenido del controlador');
  });

  console.log('\n[Controladores · coincidencia]');

  test('gpuVendor coincide / no coincide', () => {
    assert.equal(drivers.matchHost({ gpuVendor: ['amd'] }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuVendor: ['nvidia'] }, HOST).ok, false);
  });

  test('gpuName usa regex (sin distinguir mayúsculas)', () => {
    assert.equal(drivers.matchHost({ gpuName: 'radeon\\s+780m' }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuName: 'geforce' }, HOST).ok, false);
  });

  test('Memoria / núcleos / versión del sistema coinciden por rango', () => {
    assert.equal(drivers.matchHost({ totalMB: { min: 8192 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ totalMB: { max: 8192 } }, HOST).ok, false);
    assert.equal(drivers.matchHost({ cores: { min: 8 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 22000 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 30000 } }, HOST).ok, false);
  });

  test('La versión de emulator se compara como número, no como texto (36.4.9 < 36.4.10)', () => {
    const host = { ...HOST, emulatorVersion: '36.4.9' };
    assert.equal(drivers.matchHost({ emulatorVersion: { max: '36.4.10' } }, host).ok, true);
    assert.equal(drivers.matchHost({ emulatorVersion: { min: '36.4.10' } }, host).ok, false);
  });

  test('Coincidencia de accel: los equipos sin aceleración por hardware solo usan parches tcg', () => {
    const noHv = { ...HOST, accel: 'none' };
    assert.equal(drivers.matchHost({ accel: ['none'] }, noHv).ok, true);
    assert.equal(drivers.matchHost({ accel: ['none'] }, HOST).ok, false);
  });

  test('Con match vacío / sin coincidencia no hay «coincidencia por defecto»', () => {
    assert.equal(drivers.matchHost({}, HOST).ok, false);
    assert.equal(drivers.matchHost(null, HOST).ok, false);
  });

  console.log('\n[Controladores · combinación e interruptores]');

  test('Los ejemplos incluidos no se aplican por defecto (enabled:false); se aplican solo si el usuario los activa en la interfaz', () => {
    const d = { ...drivers.validateDriver(readJSON(path.join(ROOT, 'src', 'drivers', 'example-amd-igpu-swangle.json'))).driver };
    const off = drivers.resolve({ drivers: [d], host: HOST });
    assert.equal(off.applied.length, 0, '¡Los ejemplos incluidos se aplicaron por defecto!');
    const on = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: true } });
    assert.equal(on.applied.length, 1);
    assert.equal(on.effect.gpuMode, 'swangle');
  });

  test('state=false se impone al enabled:true del archivo', () => {
    const d = drivers.validateDriver({ ...base(), enabled: true }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: false } });
    assert.equal(r.applied.length, 0);
  });

  test('El de mayor priority se aplica después (sobrescribe gpuMode / parámetros del mismo nombre anteriores)', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', priority: 0, effect: { gpuMode: 'software', emulatorArgs: ['-gpu=software'] } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', priority: 10, effect: { gpuMode: 'swangle', emulatorArgs: ['-gpu=swangle'] } }).driver;
    const r = drivers.resolve({ drivers: [b, a], host: HOST });
    assert.equal(r.effect.gpuMode, 'swangle');
    const gpus = r.effect.args.filter((x) => x.flag === '-gpu');
    assert.equal(gpus.length, 1, 'El mismo parámetro se agregó dos veces');
    assert.equal(gpus[0].value, 'swangle');
  });

  test('ini / env se combinan en vez de sobrescribirse como objetos enteros', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', effect: { configIni: { 'hw.gpu.mode': 'swangle' }, env: { ANDROID_AA: '1' } } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', effect: { configIni: { 'hw.keyboard': 'no' }, env: { ANDROID_BB: '2' } } }).driver;
    const r = drivers.resolve({ drivers: [a, b], host: HOST });
    assert.deepEqual(r.effect.ini, { 'hw.gpu.mode': 'swangle', 'hw.keyboard': 'no' });
    assert.deepEqual(r.effect.env, { ANDROID_AA: '1', ANDROID_BB: '2' });
  });

  test('notes incluye el nombre del controlador, para que la interfaz diga quién lo cambió', () => {
    const d = drivers.validateDriver({ ...base(), name: '老显卡补丁', effect: { notes: ['关掉硬件渲染'] } }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST });
    assert.deepEqual(r.effect.notes, ['老显卡补丁: 关掉硬件渲染']);
  });

  console.log('\n[Controladores · lectura / importar / exportar]');

  test('Un archivo dañado solo registra el error y no afecta a los demás controladores de la carpeta', () => {
    const dir = tmpDir('load');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(base()));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 1);
    assert.equal(r.errors.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Los archivos de más de 256 KB no se leen como controladores', () => {
    const dir = tmpDir('big');
    fs.writeFileSync(path.join(dir, 'big.json'), `{"pad":"${'x'.repeat(300 * 1024)}"}`);
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 0);
    assert.ok(/demasiado grande/.test(JSON.stringify(r.errors)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Importar: tras validar se guarda como <id>.json según el id (el nombre de archivo no viene de lo que escribe el usuario)', () => {
    const src = tmpDir('src');
    const dst = tmpDir('dst');
    const f = path.join(src, '随便叫什么.json');
    fs.writeFileSync(f, JSON.stringify(base()));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(path.basename(r.file), 'test-driver.json');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('Importar: si la validación falla no se guarda en disco', () => {
    const src = tmpDir('src2');
    const dst = tmpDir('dst2');
    const f = path.join(src, 'bad.json');
    fs.writeFileSync(f, JSON.stringify({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } }));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, false);
    assert.equal(fs.readdirSync(dst).length, 0, '¡Se guardó un controlador dañado!');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('La plantilla del equipo exportada debe ser un controlador válido', () => {
    const tpl = drivers.templateFromHost(HOST);
    const r = drivers.validateDriver(tpl);
    assert.equal(r.ok, true, r.errors.join('；'));
    assert.deepEqual(r.driver.match.gpuVendor, ['amd']);
  });

  console.log('\n[Controladores · conexión con la cadena de arranque]');

  test('buildArgs / env / config.ini usan los efectos de los controladores', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(ROOT);
    emu._driverEffect = {
      gpuMode: 'swangle',
      forceTcg: true,
      args: [{ flag: '-feature', value: 'Vulkan' }, { flag: '-gpu', value: 'host' }],
      ini: { 'hw.gpu.mode': 'swangle', 'hw.audioInput': 'yes' },
      env: { ANDROID_EMU_TEST: '1' },
      notes: [],
    };
    const args = emu.buildArgs({ gpu: 'host', accel: 'auto', memoryMB: 4096, cores: 4 });
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at('-gpu'), 'swangle', 'El controlador no sustituyó -gpu');
    assert.equal(at('-accel'), 'off', 'forceTcg no se convirtió en -accel off');
    assert.equal(args.filter((a) => a === '-gpu').length, 1, '-gpu aparece dos veces (no se omitió el del controlador)');
    assert.equal(at('-feature'), 'Vulkan');
    const env = emu.env(ROOT, { accel: 'off' });
    assert.equal(env.ANDROID_EMU_TEST, '1');
    const ini = emu._iniWithDrivers('hw.gpu.mode=host\nhw.keyboard=yes\n');
    assert(/hw\.gpu\.mode=swangle/.test(ini), 'ini no se sobrescribió');
    assert(/hw\.audioInput=yes/.test(ini), 'La clave nueva de ini no se agregó');
    assert.equal((ini.match(/hw\.gpu\.mode=/g) || []).length, 1, 'ini tiene claves repetidas');
    emu._driverEffect = null;
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
