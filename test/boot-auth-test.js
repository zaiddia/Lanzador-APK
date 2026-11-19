'use strict';
/**
 * Pruebas en Node puro de la autorización de arranque / verificación de instalación (sin emulador real ni red).
 *
 * Cubren la corrección de raíz de dos fallos reales de la 0.5.3:
 *  1) la instantánea se tomaba con el diálogo «Permitir depuración USB» sin confirmar → cada restauración daba device unauthorized →
 *     la detección esperaba 240 s × 4 y se diagnosticaba mal como problema de GPU. Corrección: detectar unauthorized, invalidar la instantánea y arrancar en frío,
 *     y solo guardar instantáneas con el sistema sano.
 *  2) PackageManager decía installed=true pero los archivos de /data/app se habían perdido por la incoherencia instantánea/datos →
 *     am start fallaba. Corrección: isInstalled comprueba que cada archivo APK exista de verdad.
 *
 * Ejecutar: node test/boot-auth-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  AdbClient, parseDeviceState, isUnauthorizedError, parsePmPaths,
} = require('../src/core/adb');

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

const adbDevices = (line) => `List of devices attached\n${line}\n`;

(async () => {
  console.log('\n[Análisis del estado de dispositivos adb]');
  test('unauthorized y authorized deben poder distinguirse (get-state no los distingue)', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tunauthorized'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tdevice'), 'emulator-5554'), 'device');
  });
  test('offline / no permissions / sin dispositivo deben reportarse tal cual', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\toffline'), 'emulator-5554'), 'offline');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tno permissions'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices(''), 'emulator-5554'), 'no-device');
  });
  test('Solo cuenta la línea de estado de este serial; otros dispositivos no interfieren', () => {
    const out = adbDevices('emulator-5556\tdevice\nemulator-5554\tunauthorized');
    assert.equal(parseDeviceState(out, 'emulator-5554'), 'unauthorized');
  });
  test('El texto de error coincide con unauthorized (incluido el aviso oficial ADB_VENDOR_KEYS)', () => {
    assert.equal(isUnauthorizedError('error: device unauthorized.'), true);
    assert.equal(isUnauthorizedError("This adb server's $ADB_VENDOR_KEYS is not set. error: device unauthorized"), true);
    assert.equal(isUnauthorizedError('error: device offline'), false);
    assert.equal(isUnauthorizedError('error: no devices/emulators found'), false);
  });

  console.log('\n[Análisis de pm path + verificación real de archivos]');
  test('pm path con varias partes (split APK) debe analizarse entero', () => {
    const out = 'package:/data/app/~~x/com.foo-1/base.apk\npackage:/data/app/~~x/com.foo-1/split_arm64.apk\n';
    assert.deepEqual(parsePmPaths(out), [
      '/data/app/~~x/com.foo-1/base.apk',
      '/data/app/~~x/com.foo-1/split_arm64.apk',
    ]);
  });
  test('Salida vacía de pm path = no instalado', () => {
    assert.deepEqual(parsePmPaths(''), []);
    assert.deepEqual(parsePmPaths('Error: package not found'), []);
  });

  await atest('PM dice instalado pero el archivo APK ya no está → isInstalled devuelve false', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      // Comando de verificación de archivos: el archivo se perdió, no hay eco PRESENT
      return '';
    };
    assert.equal(await c.isInstalled('com.foo'), false);
  });
  await atest('El archivo APK existe de verdad → isInstalled devuelve true', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      return '__LANZADORAPK_PRESENT__';
    };
    assert.equal(await c.isInstalled('com.foo'), true);
  });
  await atest('Si falta una de varias partes → se considera no instalado (no puede iniciarse)', async () => {
    const c = Object.create(AdbClient.prototype);
    const seen = [];
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) {
        return 'package:/data/app/~~x/com.foo/base.apk\npackage:/data/app/~~x/com.foo/split.apk';
      }
      seen.push(cmd);
      return ''; // Fallan los dos [ -s ]
    };
    assert.equal(await c.isInstalled('com.foo'), false);
    assert.ok(seen.some((s) => s.includes('/data/app/~~x/com.foo/split.apk')), 'El comando de verificación debe cubrir cada parte');
  });

  console.log('\n[Guardia del guardado de instantáneas]');
  await atest('adb unauthorized → no se guarda la instantánea', async () => {
    const emu = Object.create(require('../src/core/emulator').EmulatorEngine.prototype);
    emu.port = 5554; // serial es un getter: emulator-${port}
    emu._log = [];   // log() agrega elementos aquí
    emu._adbGuestHealthy = async () => false;
    const ok = await emu._saveViaAdb('adb');
    assert.equal(ok, false, 'Sin buena salud no se permite guardar');
  });
  await atest('A nivel de código: la ruta de guardado de instantáneas debe pasar primero por la guardia de salud', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    const fn = src.slice(src.indexOf('async _saveViaAdb('), src.indexOf('async _saveViaAdb(') + 1800);
    assert.ok(/_adbGuestHealthy/.test(fn), '_saveViaAdb debe comprobar primero la salud del invitado');
    const stopFn = src.slice(src.indexOf('async stop('), src.indexOf('async stop(') + 6000);
    assert.ok(/_adbGuestHealthy/.test(stopFn), 'stop() también debe comprobar la salud antes de apagar');
    assert.ok(/invalidateSnapshot\(\)/.test(stopFn), 'Un apagado sin buena salud debe invalidar la instantánea');
  });
  await atest('A nivel de código: la detección del arranque debe reconocer unauthorized y autocorregirse con arranque en frío', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    const boot = src.slice(src.indexOf('async bootEmulator('), src.indexOf('async bootEmulator(') + 10000);
    assert.ok(/isUnauthorizedError/.test(boot), 'La detección debe reconocer unauthorized por el texto de error');
    assert.ok(/deviceState\(\)/.test(boot), 'La detección debe confirmar con la columna state de devices');
    assert.ok(/invalidateSnapshot\(\)/.test(boot), 'Si se atasca en la autorización hay que invalidar la instantánea vieja');
    assert.ok(/_coldBoot = true/.test(boot), 'Hay que forzar el arranque en frío para volver a inyectar la clave pública de adb');
    assert.ok(/ADB_UNAUTHORIZED/.test(boot), 'Debe dar un diagnóstico preciso, sin confundirlo con un problema de GPU');
  });
  await atest('El servidor adb inyecta ADB_VENDOR_KEYS para alinear las claves de host e invitado', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    assert.ok(/ADB_VENDOR_KEYS/.test(src), 'Debe indicarse explícitamente la carpeta de la clave pública de adb');
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Error:', e.stack || e.message);
  process.exit(1);
});
