'use strict';
/**
 * Pruebas de lógica pura de la revisión del equipo / configuración automática: sin Electron, sin emulador y sin cambiar el sistema de verdad.
 *
 * Protegen dos cosas:
 *   1. la conclusión debe coincidir con lo que se le dice al usuario (si la BIOS no está activada se dice BIOS; la versión de la Store no puede elevarse y solo da el acceso);
 *   2. la configuración automática solo escribe ajustes «seguros» y los controladores generados deben pasar la validación.
 *
 * Ejecutar: node test/preflight-test.js
 */
const assert = require('assert/strict');
const path = require('path');

const preflight = require('../src/core/preflight');
const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const hwBase = () => ({
  platform: 'win32',
  arch: 'x64',
  osBuild: 22631,
  cpu: {
    name: 'AMD Ryzen 7 7840HS', cores: 8, threads: 16,
    vtSupported: true, vtFirmware: true, slat: true,
  },
  memory: { totalMB: 32768, freeMB: 8192 },
  gpu: {
    name: 'AMD Radeon 780M', vendor: 'amd', vramMB: 2048,
    driverVersion: '31.0.12027.9001', driverDate: '2024-05-01', status: 'OK',
  },
  virtualization: {
    hypervisorPresent: true,
    hypervisorPlatform: 'enabled',
    vmPlatform: 'enabled',
    hyperV: 'disabled',
    winHvApi: true,
    vmCompute: true,
    aehdInstalled: false,
    accelOk: true,
    accelKind: 'whpx',
  },
});

const clone = (o) => JSON.parse(JSON.stringify(o));

(() => {
  console.log('\n[Revisión del equipo · recursos recomendados]');

  test('32 GB / 16 hilos: da 8 GB + 4 núcleos', () => {
    const r = preflight.recommendResources({ totalMB: 32768, cores: 16, accelOk: true, vramMB: 2048 });
    assert.equal(r.memoryMB, 8192);
    assert.equal(r.cores, 4);
    assert.equal(r.renderSize, 'auto');
  });

  test('8 GB / 4 hilos: da 3 GB + 2 núcleos, sin pasar de la mitad del anfitrión', () => {
    const r = preflight.recommendResources({ totalMB: 8192, cores: 4, accelOk: true, vramMB: 1024 });
    assert.equal(r.memoryMB, 3072);
    assert.equal(r.cores, 2);
    assert.ok(r.memoryMB <= 8192 / 2);
  });

  test('Con 4 GB de memoria solo da 2 GB, para no ahogar a Windows', () => {
    const r = preflight.recommendResources({ totalMB: 4096, cores: 4, accelOk: false, vramMB: 256 });
    assert.equal(r.memoryMB, 2048);
    assert.equal(r.renderSize, '540x960', 'Sin aceleración debe bajar la resolución');
  });

  test('Sin aceleración → 540p; con poca memoria de video también → 540p', () => {
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: false, vramMB: 4096 }).renderSize, '540x960');
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: true, vramMB: 256 }).renderSize, '540x960');
  });

  console.log('\n[Revisión del equipo · backend de renderizado sugerido]');

  test('Sin aceleración siempre software (primero que haya imagen)', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: false, vramMB: 8192 }).gpuMode, 'software');
  });

  test('NVIDIA + aceleración → host; AMD/Intel → swangle', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: true, vramMB: 8192 }).gpuMode, 'host');
    assert.equal(preflight.recommendGpu({ vendor: 'amd', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
    assert.equal(preflight.recommendGpu({ vendor: 'intel', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
  });

  test('Si no se lee el modelo de GPU no adivina; deja auto', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'unknown', accelOk: true, vramMB: 0 }).gpuMode, 'auto');
  });

  console.log('\n[Revisión del equipo · escenarios]');

  test('Todo bien: level=good, sugiere host o swangle, sin forzar TCG', () => {
    const r = preflight.evaluate({ hw: hwBase(), settings: {} });
    assert.equal(r.level, 'good', r.summary);
    assert.equal(r.patch.engine.forceTcg, false);
    assert.equal(r.patch.engine.gpuMode, 'auto');
    assert.equal(r.recommended.gpuMode, 'swangle');
  });

  test('Virtualización desactivada en la BIOS: se marca bad y solo se da la guía manual «entrar a la BIOS», sin fingir que se arregla con un clic', () => {
    const hw = hwBase();
    hw.cpu.vtFirmware = false;
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'bad');
    const item = r.items.find((i) => i.key === 'vt-bios-off');
    assert.ok(item, 'Falta el aviso de la BIOS');
    assert.equal(item.action.kind, 'manual');
    assert.equal(r.patch.engine.forceTcg, true, 'Con la BIOS desactivada debe bloquearse la emulación por software');
  });

  test('CPU sin virtualización: explica que solo hay emulación por software, sin guía para la BIOS', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = false;
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'vt-unsupported'));
    assert.ok(!r.items.some((i) => i.key === 'vt-bios-off'));
  });

  test('Función de Windows desactivada + versión instalada: ofrece «activar con un clic (requiere administrador)»', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.ok(item);
    assert.equal(item.action.kind, 'elevate');
    assert.equal(item.action.id, 'virtualization');
    assert.ok(/Activar con un clic/.test(item.action.label));
  });

  test('La versión de la Store no puede elevarse: para el mismo problema solo abre la ventana «Características de Windows»', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'store' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.equal(item.action.kind, 'elevate');
    assert.ok(/Características de Windows/.test(item.action.label), item.action.label);
    assert.ok(!/con un clic/.test(item.action.label));
  });

  test('Sin aceleración + versión instalada: ofrece además «instalar AEHD»', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.hypervisorPlatform = 'disabled';
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const accel = r.items.find((i) => i.key === 'accel-off');
    assert.equal(accel.action.id, 'accel');
  });

  test('Cuando Hyper-V toma VT y WMI dice false no se puede concluir por error «no compatible»', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = 'unknown';
    hw.cpu.vtFirmware = true;
    hw.cpu.slat = 'unknown';
    hw.virtualization.accelOk = true;
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'good', r.summary);
    assert.ok(!r.items.some((i) => i.key === 'vt-unsupported'));
  });

  test('Memoria de video ilegible / GPU desconocida: da warn pero sin conclusión fatal', () => {
    const hw = hwBase();
    hw.gpu = { name: '', vendor: 'unknown', vramMB: 0, driverVersion: '', driverDate: '', status: '' };
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-unknown'));
    assert.equal(r.level, 'warn');
  });

  test('Avisa si el controlador es muy viejo (causa común de pantalla negra)', () => {
    const hw = hwBase();
    hw.gpu.driverDate = '2019-03-01';
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-driver-old'));
  });

  test('Poca memoria / sistema muy viejo se avisan por separado', () => {
    const hw = hwBase();
    hw.memory.totalMB = 4096;
    hw.osBuild = 18363;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'mem-low'));
    assert.ok(r.items.some((i) => i.key === 'os-old'));
  });

  console.log('\n[Revisión del equipo · límites de la configuración automática]');

  test('La configuración automática solo escribe ajustes seguros (no toca la partición de datos / el modo de resolución, etc.)', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    assert.deepEqual(Object.keys(r.patch.engine).sort(),
      ['autoMemory', 'cores', 'forceTcg', 'gpuMode', 'memoryMB', 'renderSize'].sort());
  });

  test('El controlador generado automáticamente pasa la validación y match queda ligado a este equipo', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.deepEqual(v.driver.match.gpuVendor, ['amd']);
    assert.equal(v.driver.effect.gpuMode, 'swangle');
    assert.equal(v.driver.effect.forceTcg, null, 'Con aceleración no debería escribir forceTcg');
  });

  test('Sin aceleración el controlador generado bloquea la emulación por software', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.equal(v.driver.effect.forceTcg, true);
    assert.equal(v.driver.effect.gpuMode, 'software');
  });

  test('Aunque la detección falle debe dar una conclusión (desconocido ≠ caída)', () => {
    const r = preflight.evaluate({ hw: { platform: 'win32' } });
    assert.ok(['warn', 'bad'].includes(r.level));
    assert.ok(r.items.length >= 3);
    assert.equal(typeof r.summary, 'string');
  });

  test('collect() es asíncrono (no bloquea la interfaz)', () => {
    assert.equal(preflight.collect.constructor.name, 'AsyncFunction');
  });

  test('La evaluación es una función pura: la misma entrada debe dar la misma configuración', () => {
    const a = preflight.evaluate({ hw: {}, settings: {} });
    const b = preflight.evaluate({ hw: {}, settings: {} });
    assert.deepEqual(a.patch, b.patch);
    assert.deepEqual(a.driver, b.driver);
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
