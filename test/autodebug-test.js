'use strict';
/**
 * Pruebas unitarias del núcleo de comprobación automática (src/core/autodebug.js)
 *
 * Funciones puras, sin depender de electron / adb / red: el CI puede ejecutarlas directamente.
 * Se protegen sobre todo dos límites:
 *   1) un fallo de detección nunca se convierte en «hay un problema» (no inventar avisos);
 *   2) si de verdad hay un problema hay que reportarlo, con una acción de reparación concreta.
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

const ROOT = path.join(__dirname, '..');
const ad = require(path.join(ROOT, 'src/core/autodebug'));

const codes = (issues) => issues.map((i) => i.code);

console.log('\n[Comprobación automática · una instantánea vacía no da falsos avisos]');
test('Una instantánea totalmente vacía no genera ningún problema', () => {
  const issues = ad.evaluate({});
  assert(issues.length === 0, `No debería haber problemas; real: ${JSON.stringify(codes(issues))}`);
});

test('Con solo la mitad del estado tampoco inventa avisos', () => {
  // Solo se sabe que «está en marcha»; nada más
  const issues = ad.evaluate({ runtime: { running: true } });
  assert(issues.length === 0, `No debería haber problemas; real: ${JSON.stringify(codes(issues))}`);
});

test('Si no se revisó el dispositivo no dice «no se ve el dispositivo»', () => {
  const issues = ad.evaluate({ runtime: { running: true }, device: { checked: false } });
  assert(!codes(issues).includes('device.missing'), 'No debería decir que falta el dispositivo');
});

console.log('\n[Comprobación automática · runtime]');
test('Si el último arranque falló se reporta, con el error real', () => {
  const issues = ad.evaluate({ runtime: { error: 'FATAL: cannot lock AVD' } });
  const it = issues.find((i) => i.code === 'runtime.bootFailed');
  assert(it, 'Debería reportar el fallo de arranque');
  assert(it.severity === 'error', 'Debería ser un problema grave');
  assert(it.detail.includes('cannot lock AVD'), 'Debería incluir la causa real');
  assert(it.fix === 'restartRuntime', 'Debería dar una acción de reparación concreta');
});

test('Solo avisa si el arranque se atasca más de 2 min y medio (recién arrancado no es problema)', () => {
  const soon = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 30000 } });
  assert(!codes(soon).includes('runtime.stuckBoot'), 'Recién arrancado no debería avisar');
  const stuck = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 200000 } });
  assert(codes(stuck).includes('runtime.stuckBoot'), 'Si se atasca mucho debería avisar');
});

test('Archivos de bloqueo que quedaron y procesos huérfanos dan un aviso cada uno', () => {
  const issues = ad.evaluate({ runtime: { locks: 2, orphans: 1 } });
  assert(codes(issues).includes('runtime.staleLocks'), 'Debería reportar bloqueos que quedaron');
  assert(codes(issues).includes('runtime.orphanProcesses'), 'Debería reportar procesos huérfanos');
});

test('Se detectan las instantáneas vacías', () => {
  const issues = ad.evaluate({ runtime: { snapshotStale: true } });
  assert(codes(issues).includes('runtime.saleSnapshot') === false, 'No debería haber un code mal escrito');
  assert(codes(issues).includes('runtime.staleSnapshot'), 'Debería reportar la instantánea dañada');
});

console.log('\n[Comprobación automática · conexión del dispositivo]');
test('unauthorized es un problema grave (Android mostró el diálogo de autorización y nadie lo pulsó)', () => {
  const issues = ad.evaluate({ device: { checked: true, state: 'unauthorized' } });
  const it = issues.find((i) => i.code === 'device.unauthorized');
  assert(it, 'Debería reportar sin autorizar');
  assert(it.severity === 'error', 'Debería ser un problema grave');
  assert(it.category === 'device', 'Debería ir en conexión del dispositivo');
});

test('offline y no-device se distinguen y tienen gravedad distinta', () => {
  const off = ad.evaluate({ device: { checked: true, state: 'offline' } });
  assert(codes(off).includes('device.offline'), 'Debería reportar offline');
  const none = ad.evaluate({ runtime: { running: true }, device: { checked: true, state: 'no-device' } });
  assert(codes(none).includes('device.missing'), 'Debería reportar que falta el dispositivo');
});

console.log('\n[Comprobación automática · almacenamiento]');
test('Menos de 2 GB de disco es grave; menos de 8 GB es un aviso', () => {
  const crit = ad.evaluate({ storage: { freeMB: 1024 } });
  const ci = crit.find((i) => i.code === 'storage.diskCritical');
  assert(ci && ci.severity === 'error', 'Por debajo de 2 GB debería ser grave');
  const warn = ad.evaluate({ storage: { freeMB: 5000 } });
  const wi = warn.find((i) => i.code === 'storage.diskLow');
  assert(wi && wi.severity === 'warn', 'Por debajo de 8 GB debería ser un aviso');
});

test('Si un disco diferencial frena la partición de datos se reporta tal cual', () => {
  const issues = ad.evaluate({ storage: { needsReset: true, configuredGB: 16, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataNeedsReset');
  assert(it, 'Debería reportar que la ampliación no se aplicó');
  assert(it.detail.includes('16') && it.detail.includes('6'), 'Debería incluir el valor configurado y el real');
});

test('Si el tamaño configurado es mayor que el real es grave', () => {
  const issues = ad.evaluate({ storage: { configuredGB: 24, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataMismatch');
  assert(it && it.severity === 'error', 'Debería ser un problema grave');
});

test('Se reporta si la carpeta compartida no es escribible', () => {
  const issues = ad.evaluate({ storage: { sharedOk: false, sharedPath: 'D:\\share' } });
  const it = issues.find((i) => i.code === 'storage.sharedBroken');
  assert(it, 'Debería reportar el problema de la carpeta compartida');
  assert(it.detail.includes('share'), 'Debería incluir la ruta de la carpeta');
});

console.log('\n[Comprobación automática · conflictos de configuración]');
test('Vertical forzada con pantalla horizontal: las orientaciones chocan', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'portrait', landscape: true } });
  assert(codes(issues).includes('settings.orientationConflict'), 'Debería reportar conflicto de orientación');
});

test('Horizontal forzada con pantalla vertical: las orientaciones chocan', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'landscape', landscape: false } });
  assert(codes(issues).includes('settings.orientationConflict'), 'Debería reportar conflicto de orientación');
});

test('Seguir a la app + cualquier orientación de pantalla no es conflicto', () => {
  const a = ad.evaluate({ settings: { orientationMode: 'auto', landscape: true } });
  const b = ad.evaluate({ settings: { orientationMode: 'auto', landscape: false } });
  assert(!codes(a).includes('settings.orientationConflict'), 'auto no debería reportar conflicto');
  assert(!codes(b).includes('settings.orientationConflict'), 'auto no debería reportar conflicto');
});

console.log('\n[Comprobación automática · red y registros]');
test('Si Android no tiene red se reporta, con una acción de reparación', () => {
  const issues = ad.evaluate({ network: { ok: false, reason: 'dns timeout' } });
  const it = issues.find((i) => i.code === 'network.guestDown');
  assert(it, 'Debería reportar que Android no tiene red');
  assert(it.fix === 'repairNetwork', 'Debería dar una acción de reparación');
});

test('Se cuentan las fuentes de descarga que no responden', () => {
  const issues = ad.evaluate({ network: { sources: [{ name: 'GitHub', ok: false }, { name: 'Gitee', ok: true }] } });
  const it = issues.find((i) => i.code === 'network.sourcesDown');
  assert(it, 'Debería reportar fuentes que no responden');
  assert(it.detail.includes('GitHub'), 'Debería indicar qué fuente');
  assert(!it.detail.includes('Gitee'), 'Las fuentes que funcionan no deben listarse');
});

test('Se extraen los errores del registro', () => {
  const issues = ad.evaluate({ logs: { errors: ['2026-01-01 FATAL: cannot lock AVD'] } });
  const it = issues.find((i) => i.code === 'logs.errors');
  assert(it, 'Debería reportar errores del registro');
  assert(it.detail.includes('cannot lock'), 'Debería incluir el texto original del error');
});

console.log('\n[Comprobación automática · resumen y diferencias]');
test('El resumen cuenta por gravedad y da el estado de salud', () => {
  const s = ad.summarize(ad.evaluate({
    runtime: { error: 'boom' },
    storage: { freeMB: 1024 },
    device: { checked: true, state: 'unauthorized' },
  }));
  assert(s.total === 3, `Debería haber 3 elementos; real: ${s.total}`);
  assert(s.errors === 3, `Debería haber 3 problemas graves; real: ${s.errors}`);
  assert(s.health === 'error', 'El estado de salud debería ser error');
  assert(s.byCategory.length === 6, 'El número de categorías debe ser 6');
});

test('Sin problemas el estado de salud es ok', () => {
  const s = ad.summarize([]);
  assert(s.total === 0 && s.health === 'ok', 'Debería estar vacío y sano');
});

test('De varios con el mismo code solo queda el último', () => {
  const list = ad.dedupe([
    { code: 'x', severity: 'warn', title: '旧的' },
    { code: 'x', severity: 'error', title: '新的' },
  ]);
  assert(list.length === 1, 'Debería quedar solo uno');
  assert(list[0].title === '新的', 'Debería conservar el último');
});

test('La diferencia distingue «nuevos» de «desaparecidos»', () => {
  const prev = [{ code: 'a', severity: 'error' }, { code: 'b', severity: 'warn' }];
  const next = [{ code: 'b', severity: 'warn' }, { code: 'c', severity: 'error' }];
  const d = ad.diff(prev, next);
  assert(d.added.length === 1 && d.added[0].code === 'c', 'Debería reconocer los problemas nuevos');
  assert(d.resolved.length === 1 && d.resolved[0].code === 'a', 'Debería reconocer los desaparecidos');
});

test('Un cambio de gravedad también cuenta como «nuevo» (pasar de warn a error debe avisarse)', () => {
  const d = ad.diff([{ code: 'a', severity: 'warn' }], [{ code: 'a', severity: 'error' }]);
  assert(d.added.length === 1, 'Al subir la gravedad debe volver a avisar');
});

console.log('\n[Comprobación automática · restricciones de estructura]');
test('Cada problema tiene categoría, gravedad y título', () => {
  const issues = ad.evaluate({
    runtime: { error: 'x', locks: 1, orphans: 1, snapshotStale: true },
    device: { checked: true, state: 'offline' },
    storage: { freeMB: 100, needsReset: true, sharedOk: false },
    settings: { orientationMode: 'portrait', landscape: true },
    network: { ok: false },
    logs: { errors: ['err'] },
  });
  assert(issues.length > 0, 'Debería haber varios problemas');
  for (const it of issues) {
    assert(it.code, 'Debe tener code');
    assert(ad.CATEGORY_IDS.includes(it.category), `La categoría debe ser válida: ${it.category}`);
    assert(['error', 'warn', 'info'].includes(it.severity), `La gravedad debe ser válida: ${it.severity}`);
    assert(it.title, 'Debe tener título');
    assert(typeof it.hint === 'string', 'Debe tener explicación');
  }
});

test('La tabla de categorías coincide en interfaz y proceso principal (DEBUG_CATS de la capa de renderizado)', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
  const m = appJs.match(/const DEBUG_CATS = \[([\s\S]*?)\];/);
  assert(m, 'app.js debería tener DEBUG_CATS');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  assert(ids.length === ad.CATEGORIES.length, `El número de categorías debería coincidir: interfaz ${ids.length} / proceso principal ${ad.CATEGORIES.length}`);
  for (const c of ad.CATEGORIES) {
    assert(ids.includes(c.id), `A la interfaz le falta la categoría ${c.id}`);
  }
});

console.log('\n[Comprobación automática · conexión con el proceso principal]');
test('El proceso principal registró los IPC de comprobación', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  for (const ch of ['autodebug:run', 'autodebug:state', 'autodebug:config', 'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart']) {
    assert(mainJs.includes(`'${ch}'`), `El proceso principal debería registrar ${ch}`);
  }
  assert(mainJs.includes('scheduleAutodebug()'), 'El proceso principal debería programar la comprobación periódica');
});

test('preload expone la interfaz de comprobación y deja pasar los eventos de estado', () => {
  const p = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
  for (const fn of ['autodebugRun', 'autodebugState', 'autodebugConfig', 'clearOrphans', 'clearSnapshot', 'restartRuntime']) {
    assert(p.includes(fn), `preload debería exponer ${fn}`);
  }
  assert(p.includes("'autodebug:state'"), 'preload debería dejar pasar el evento autodebug:state');
});

test('La configuración tiene el interruptor y el botón de la comprobación automática', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  for (const id of ['setAutodebugAuto', 'setAutodebugInterval', 'setAutodebugNotify', 'btnAutodebugRun', 'autodebugList']) {
    assert(html.includes(`id="${id}"`), `La configuración debería tener ${id}`);
  }
});

console.log(`\nResultado: ${passed} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
