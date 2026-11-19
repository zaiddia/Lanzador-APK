'use strict';
/**
 * Pruebas en Node puro de la asignación de recursos (memoria / CPU / almacenamiento): sin Electron y sin emulador.
 *
 * El valor de esta capa es que «aunque se llene mal no pasa nada»: si el usuario pone 32 GB de memoria o una partición de 128 GB,
 * antes de guardar hay que ajustarlo a lo que el anfitrión realmente puede dar; si no, el síntoma es pantalla negra al arrancar / instalación fallida a medias,
 * y el usuario no tiene forma de saber qué estuvo mal.
 *
 * Ejecutar: node test/resources-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  hostProfile, memoryLimits, clampMemoryMB, clampCores, memVerdict,
  diskRequiredMB, diskVerdict, diskLimits, clampDataGB, storageVerdict,
} = require('../src/core/resources');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const GB = 1024 * 1024 * 1024;

(() => {
  console.log('\n[Asignación de recursos · capacidad del anfitrión]');

  test('hostProfile acepta valores inyectados (las pruebas no tocan el equipo real)', () => {
    const h = hostProfile({ totalMB: 32768, cores: 16 });
    assert.equal(h.totalMB, 32768);
    assert.equal(h.cores, 16);
  });

  test('Sin valores, hostProfile no devuelve 0 núcleos / NaN', () => {
    const h = hostProfile({});
    assert.ok(h.cores >= 1);
    assert.ok(Number.isFinite(h.totalMB));
  });

  test('El tope de memoria deja un 25 % al anfitrión', () => {
    const lim = memoryLimits(32768);
    assert.equal(lim.maxMB, 24576, `Un anfitrión de 32 GB asigna como máximo 24 GB; real: ${lim.maxMB}`);
    assert.equal(lim.stepMB, 512);
    assert.equal(lim.minMB, 1024);
  });

  test('Si no se lee la memoria del anfitrión también da un tope conservador', () => {
    const lim = memoryLimits(0);
    assert.ok(lim.maxMB >= 4096 && lim.maxMB <= 16384);
  });

  console.log('\n[Asignación de recursos · ajuste de memoria]');

  test('0 significa automático y se devuelve 0 tal cual', () => {
    const r = clampMemoryMB(0, 32768);
    assert.equal(r.mb, 0);
    assert.equal(r.reason, 'auto');
  });

  test('3 GB se alinea a 512 MB y queda en 3072', () => {
    const r = clampMemoryMB(3000, 32768);
    assert.equal(r.mb, 3072);
    assert.equal(r.capped, true);
  });

  test('64 GB se baja al tope del anfitrión y se explica el motivo', () => {
    const r = clampMemoryMB(64 * 1024, 32768);
    assert.equal(r.mb, 24576);
    assert.equal(r.capped, true);
    assert.ok(/como máximo 24 GB/.test(r.reason), r.reason);
  });

  test('128 MB se sube al mínimo que arranca', () => {
    const r = clampMemoryMB(128, 32768);
    assert.equal(r.mb, 1024);
    assert.equal(r.capped, true);
  });

  test('En equipos con poca memoria (4 GB) no se le dan los 4 GB a Android', () => {
    const r = clampMemoryMB(4096, 4096);
    assert.equal(r.mb, 3072);
  });

  console.log('\n[Asignación de recursos · ajuste de CPU]');

  test('Un equipo de 16 núcleos asigna como máximo 15', () => {
    assert.equal(clampCores(16, 16).cores, 15);
  });

  test('Un equipo de un solo núcleo sigue dando 1', () => {
    assert.equal(clampCores(8, 1).cores, 1);
  });

  test('0 = automático', () => {
    assert.equal(clampCores(0, 8).cores, 0);
  });

  console.log('\n[Asignación de recursos · aviso de proporción de memoria]');

  test('Si se asigna demasiado avisa que Windows usará paginación', () => {
    const v = memVerdict(28672, 32768);
    assert.equal(v.level, 'insufficient');
    assert.ok(/paginar/.test(v.note), v.note);
  });

  test('En el rango normal no molesta al usuario', () => {
    assert.equal(memVerdict(8192, 32768).level, 'ok');
    assert.equal(memVerdict(8192, 32768).note, '');
  });

  test('Por debajo de 768 MB se considera que no arranca', () => {
    assert.equal(memVerdict(512, 32768).level, 'insufficient');
  });

  console.log('\n[Asignación de recursos · almacenamiento]');

  test('Un juego de 50 GB se estima × 1,8 + 2 GB de reserva', () => {
    const need = diskRequiredMB(50 * GB);
    assert.equal(need, Math.ceil(50 * 1024 * 1.8) + 2048);
  });

  test('El tope de la partición de datos es el 80 % del disco donde está', () => {
    assert.equal(diskLimits(100 * 1024).maxGB, 80);
  });

  test('Con solo 20 GB libres no se permite una partición de 64 GB', () => {
    const r = clampDataGB(64, 20 * 1024);
    assert.equal(r.gb, 16);
    assert.equal(r.capped, true);
    assert.ok(/solo tiene 20\.0 GB/.test(r.reason), r.reason);
  });

  test('Con disco de sobra se permite la partición de 64 GB', () => {
    const r = clampDataGB(64, 200 * 1024);
    assert.equal(r.gb, 64);
    assert.equal(r.capped, false);
  });

  test('Si no hay espacio, storageVerdict dice cuánto falta', () => {
    const v = storageVerdict(30 * 1024, 50 * GB);
    assert.equal(v.ok, false);
    assert.ok(v.shortMB > 0);
    assert.ok(/faltan/.test(v.note), v.note);
  });

  test('Si no se lee el espacio libre se omite la comprobación previa en vez de bloquear', () => {
    assert.equal(storageVerdict(0, 50 * GB).ok, true);
  });

  console.log('\n[Asignación de recursos · comprobación previa de disco]');

  test('diskVerdict deja pasar si hay espacio', () => {
    const v = diskVerdict(200 * 1024, 100 * 1024);
    assert.equal(v.ok, true);
    assert.equal(v.message, '');
  });

  test('diskVerdict dice cuánto falta si no hay espacio (indica el disco del runtime)', () => {
    const v = diskVerdict(10 * 1024, 60 * 1024);
    assert.equal(v.ok, false);
    assert.ok(/Espacio en disco insuficiente/.test(v.message), v.message);
    assert.ok(/disco del runtime de Lanzador APK/.test(v.message), v.message);
  });

  test('diskVerdict no bloquea si no se lee el espacio libre', () => {
    assert.equal(diskVerdict(0, 60 * 1024).ok, true);
  });

  test('El espacio previo para instaladores de ~50 GB se estima × 1,8 + 2 GB', () => {
    const need = diskRequiredMB(50 * GB);
    assert.ok(need > 85 * 1024 && need < 95 * 1024, `Se necesitan ${need} MB`);
  });

  console.log('\n[Asignación de recursos · conexiones]');

  const builtinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'builtin.js'), 'utf8');
  test('La base propia también ofrece resources()', () => {
    assert(/resources\(\) \{/.test(builtinSrc), 'A builtin le falta resources()');
  });

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  test('El proceso principal ajusta valores fuera de rango y expone el resumen de recursos', () => {
    assert(/sanitizeResourcePatch/.test(mainSrc), 'Al guardar la configuración no se ajustaron los valores de recursos');
    assert(/engine:resources/.test(mainSrc), 'Falta el IPC engine:resources');
    assert(/runtime:resetAndResize/.test(mainSrc), 'Falta el canal de restablecer + reconstruir con la nueva capacidad');
    assert(!/mumuMemoryGB|mumuCores/.test(mainSrc), 'El proceso principal todavía tiene la lógica de ajuste de memoria de bases de terceros');
  });

  const emulatorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
  test('Si el disco diferencial de quickboot impide ampliar en el lugar se reporta el error tal cual, sin fingir éxito', () => {
    assert(/_hasDataOverlay/.test(emulatorSrc), 'No se detectó el disco diferencial qcow2');
    assert(/needsReset: true/.test(emulatorSrc), 'El fallo de ampliación no marcó needsReset');
    assert(/fsGB/.test(emulatorSrc), 'dataInfo no expone el tamaño real del sistema de archivos');
  });

  const doctorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
  test('Los topes de memoria/núcleos del modo automático siguen al anfitrión; ya no 8 GB/8 núcleos fijos', () => {
    assert(/memoryLimits\(host\.totalMB\)/.test(doctorSrc), 'doctor no ajusta la memoria según el anfitrión');
    assert(!/1536, 8192/.test(doctorSrc), 'doctor todavía tiene fijo el tope de 8192');
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
