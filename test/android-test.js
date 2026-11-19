'use strict';
/**
 * Pruebas en Node puro de los ajustes del sistema Android (src/core/android.js): un cliente adb falso registra los comandos y devuelve salidas predefinidas,
 * sin emulador. Ejecutar: node test/android-test.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AndroidSettings, volumeCmd, parseVolume, volumePercent } = require('../src/core/android');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Aserción fallida');
}

/** Runtime falso: shell() devuelve en orden las salidas de replies y anota los scripts recibidos */
function fakeSettings(replies) {
  const scripts = [];
  const client = {
    async shell(script) {
      scripts.push(script);
      return replies.length ? replies.shift() : '';
    },
  };
  const runtime = { async ensure() { return { ok: true, client }; } };
  return { set: new AndroidSettings(runtime), scripts };
}

(async () => {
  console.log('\n[android.js volumen]');

  await test('parseVolume lee el nivel y el rango', () => {
    const v = parseVolume('[V] will get volume\nvolume is 5 in range [0..15]\n');
    assert(v && v.index === 5 && v.min === 0 && v.max === 15, JSON.stringify(v));
    assert(parseVolume('media: inaccessible or not found') === null, 'Una salida no reconocida debe devolver null');
    assert(parseVolume('') === null && parseVolume(undefined) === null, 'Una salida vacía debe devolver null');
  });

  await test('volumePercent convierte el nivel a porcentaje según el rango', () => {
    assert(volumePercent({ index: 0, min: 0, max: 15 }) === 0);
    assert(volumePercent({ index: 15, min: 0, max: 15 }) === 100);
    assert(volumePercent({ index: 5, min: 0, max: 15 }) === 33);
    assert(volumePercent({ index: 3, min: 0, max: 0 }) === 0, 'Con rango 0 no debe dividir entre 0');
    assert(volumePercent(null) === 0);
  });

  await test('El comando de volumen usa primero cmd media_session; en imágenes viejas recurre a media', () => {
    const c = volumeCmd('--set 7');
    assert(c.indexOf('cmd media_session volume --stream 3 --set 7') >= 0, c);
    assert(c.indexOf('|| media volume --stream 3 --set 7') > c.indexOf('cmd media_session'), c);
    assert(!/^media volume/.test(c), 'No debe usar solo la herramienta media, eliminada desde Android 11');
  });

  await test('setVolume convierte el porcentaje a nivel antes de aplicarlo (Android 11+)', async () => {
    const { set, scripts } = fakeSettings(['volume is 4 in range [0..15]\n', '']);
    const r = await set.setVolume(60);
    assert(scripts.length === 2, `Debe leer el rango antes de aplicar; real: ${scripts.length} líneas`);
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), scripts[0]);
    assert(scripts[1].includes('cmd media_session volume --stream 3 --set 9'), scripts[1]);
    assert(!scripts[1].includes('--set 60'), 'No debe tomar el porcentaje directamente como nivel');
    assert(r.ok && r.volume === 60, JSON.stringify(r));
  });

  await test('setVolume convierte con distintos rangos de nivel (0..25)', async () => {
    const { set, scripts } = fakeSettings(['volume is 10 in range [0..25]\n', '']);
    const r = await set.setVolume(100);
    assert(scripts[1].includes('--set 25'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('Sin rango legible convierte con el habitual 0..15 y limita a 0~100', async () => {
    const { set, scripts } = fakeSettings(['', '']);
    const r = await set.setVolume(250);
    assert(scripts[1].includes('--set 15'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('status() muestra el nivel convertido a porcentaje', async () => {
    const out = ['wifi=1', 'air=0', 'font=1.0', 'density=320', 'animw=1.0', 'sdk=34', 'vol=volume is 6 in range [0..15]'].join('\n');
    const { set, scripts } = fakeSettings([out]);
    const s = await set.status();
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), 'El estado debe leer el volumen con media_session');
    assert(s.volume === 40, `Debería ser 40 %; real: ${s.volume}`);
    assert(s.sdk === 34 && s.wifi === true, JSON.stringify(s));
  });

  // Verifica en un sh real el respaldo de comandos: en el PATH solo hay un `media` falso (simula una imagen antigua sin cmd)
  // y un `cmd` falso (simula Android 11+).
  if (process.platform !== 'win32') {
    await test('En sh: sin cmd recurre a media; con cmd ya no llama a media', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-vol-'));
      const log = path.join(dir, 'calls.log');
      const write = (name, body) => {
        fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
        fs.chmodSync(path.join(dir, name), 0o755);
      };
      write('media', 'echo "volume is 3 in range [0..15]"');
      const run = () => execFileSync('/bin/sh', ['-c', `${volumeCmd('--get')} 2>/dev/null`], {
        env: { PATH: dir },
        encoding: 'utf8',
      });
      assert(parseVolume(run()).index === 3, 'En imágenes viejas debe leer el volumen con media');
      write('cmd', 'echo "volume is 8 in range [0..15]"');
      fs.writeFileSync(log, '');
      assert(parseVolume(run()).index === 8, 'Con cmd debe leer el resultado de media_session');
      assert(!fs.readFileSync(log, 'utf8').includes('media volume'), 'Con cmd no debe volver a llamar a media');
    });
  }

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
