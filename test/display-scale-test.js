'use strict';
/**
 * Pruebas en Node puro de la corrección de la issue #99 «con escala distinta de 100 % se ve la mitad» (sin Electron/emulador).
 *
 * Causa: el modo de ventana independiente pasaba los píxeles lógicos DIP de Electron directamente al
 *       SetWindowPos de un proceso DPI-aware (que espera píxeles físicos); con escala 125 %/150 % la ventana quedaba a 2/3, desplazada
 *       y con clics desfasados. Corrección: antes de pasarlo a agent.layout se multiplica por scaleFactor con _physical().
 *
 * Cubre:
 *  - conversión de _physical con 100 %/125 %/150 %/175 % (incluye coordenadas negativas y redondeo)
 *  - con sf=1 / sin valor el rectángulo no cambia
 *  - _area() incluye el campo sf y sale de la misma fuente que area
 *  - a nivel de código: los tres layout del modo independiente pasan por _physical y la ruta de restauración no multiplica dos veces
 *
 * Ejecutar: node test/display-scale-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
// Solo se hace require del módulo de conversión sin dependencias: el CI usa ELECTRON_SKIP_BINARY_DOWNLOAD=1,
// y hacer require de appwin.js lanzaría un error por falta del binario de electron (justo el tropiezo inicial de esta prueba).
const { physicalRect } = require('../src/core/geometry');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

(() => {
  console.log('\n[issue #99 · conversión DIP → píxeles físicos]');

  test('Escala 100 %: el rectángulo se devuelve tal cual (el mismo objeto, sin coste)', () => {
    const r = { x: 100, y: 60, w: 1280, h: 720 };
    assert.equal(physicalRect(r, 1), r, 'Con sf=1 debe devolver el objeto original');
    assert.equal(physicalRect(r, 0), r, 'Sin sf tampoco cambia');
  });

  test('Escala 150 %: tamaño y coordenadas se amplían juntos, con redondeo', () => {
    assert.deepEqual(physicalRect({ x: 100, y: 60, w: 1280, h: 720 }, 1.5),
      { x: 150, y: 90, w: 1920, h: 1080 });
  });

  test('Escala 125 %: con decimales se redondea al entero más cercano', () => {
    assert.deepEqual(physicalRect({ x: 33, y: 41, w: 1001, h: 777 }, 1.25),
      { x: Math.round(33 * 1.25), y: Math.round(41 * 1.25), w: Math.round(1001 * 1.25), h: Math.round(777 * 1.25) });
  });

  test('Las coordenadas negativas (-8 por el borde gris) también se convierten en proporción, sin perder el signo', () => {
    assert.deepEqual(physicalRect({ x: -8, y: 30 - 8, w: 900, h: 500 }, 2),
      { x: -16, y: 44, w: 1800, h: 1000 });
  });

  test('Pantalla completa: workArea DIP × sf = resolución física', () => {
    // Con escala 150 %, una pantalla física de 1920×1080 tiene un workArea de unos 1280×693 DIP
    const phys = physicalRect({ x: 0, y: 0, w: 1280, h: 693 }, 1.5);
    assert.equal(phys.w, 1920);
    assert.equal(phys.h, Math.round(693 * 1.5)); // ≈ 1040, deja sitio para la barra de tareas
  });

  console.log('\n[A nivel de código · todos los layout del modo independiente usan la conversión]');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');

  test('appwin._physical delega en geometry.physicalRect, sin dependencias', () => {
    assert(/require\('\.\/geometry'\)/.test(src), 'appwin debería importar geometry');
    const start = src.indexOf('_physical(rect, sf) {');
    const body = src.slice(start, start + 200);
    assert(/physicalRect\(rect/.test(body), '_physical debe llamar a physicalRect (así se prueba la implementación real)');
  });

  test('_area() devuelve sf, tomado de la misma pantalla que area', () => {
    const fn = src.slice(src.indexOf('_area() {'), src.indexOf('_scale() {'));
    assert(/scaleFactor/.test(fn), '_area debe registrar scaleFactor');
    assert(/return \{[^}]*sf:/s.test(fn), 'El valor que devuelve _area debe incluir el campo sf');
  });

  test('El layout de openDetached pasa por _physical', () => {
    const start = src.indexOf('async openDetached(');
    const body = src.slice(start, src.indexOf('async embed(', start));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'En openDetached el rectángulo que se pasa a agent.layout debe pasar antes por _physical');
  });

  test('El layout de pantalla completa de toggleMaximize pasa por _physical', () => {
    const start = src.indexOf('async toggleMaximize()');
    const body = src.slice(start, src.indexOf('openDetachedLayoutOnly(area) {'));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'La pantalla completa en modo independiente también debe convertirse');
    // La ruta de restauración usa los píxeles físicos que devuelve probe; nunca se puede multiplicar otra vez
    assert(/agent\.layout\(this\._preFullscreenRect\)/.test(body),
      'Al restaurar con el rectángulo físico obtenido de probe no se puede convertir dos veces');
  });

  test('El layout de openDetachedLayoutOnly pasa por _physical', () => {
    const start = src.indexOf('openDetachedLayoutOnly(area) {');
    const body = src.slice(start, start + 600);
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'La ruta que restaura el tamaño por defecto también debe convertir');
  });

  test('En modo incrustado _rect() conserva su propia conversión sf (este cambio no la rompió)', () => {
    const start = src.indexOf('_rect() {');
    const body = src.slice(start, start + 500);
    assert(/this\._scale\(\)/.test(body) && /\* sf/.test(body),
      'La conversión física del modo incrustado debe conservarse');
  });

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
