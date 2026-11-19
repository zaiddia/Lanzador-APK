'use strict';
/**
 * Prueba de estructura de la navegación por categorías + búsqueda de la configuración (0.6.0)
 *
 * La configuración es la parte que el usuario más toca; si las categorías y los grupos no coinciden, aparece «una categoría que al abrirla está vacía».
 * Aquí se hacen aserciones sobre el código: cada grupo del HTML debe tener data-cat, los elementos de navegación deben coincidir con las categorías de los grupos,
 * y la tabla de categorías de la interfaz debe coincidir con el HTML.
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
const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');

/** Toma el fragmento HTML del cuerpo del panel de configuración (settingsBody) */
const bodyMatch = html.match(/<div class="modal-body" id="settingsBody">([\s\S]*?)\n    <\/div>\n    <\/div>\n    <footer/);
assert(bodyMatch, 'Debería poder ubicar el cuerpo del panel de configuración');

console.log('\n[Categorías de configuración · estructura]');
test('El panel de configuración tiene navegación por categorías y cuadro de búsqueda', () => {
  assert(html.includes('id="setNav"'), 'Debería haber un contenedor de navegación por categorías');
  assert(html.includes('id="setSearch"'), 'Debería haber un cuadro de búsqueda');
  assert(html.includes('id="btnClearSearch"'), 'Debería haber un botón para borrar la búsqueda');
  assert(html.includes('id="settingsBody"'), 'La zona de contenido debe tener un id estable (se usa para ubicar y desplazar)');
});

test('Los elementos de navegación cubren las 8 categorías', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  assert(navMatch, 'Debería haber nav');
  const items = navMatch[0].match(/data-cat="([a-z]+)"/g) || [];
  const ids = items.map((s) => s.replace(/data-cat="|"/g, ''));
  const expected = ['basic', 'display', 'input', 'perf', 'net', 'diag', 'files', 'about'];
  assert(ids.length === expected.length, `Debería haber ${expected.length} elementos de navegación; real: ${ids.length}`);
  for (const e of expected) {
    assert(ids.includes(e), `A la navegación le falta la categoría ${e}`);
  }
});

test('Cada grupo de configuración tiene categoría (ningún grupo se escapa)', () => {
  // Toma las etiquetas de apertura de todos los grupos de primer nivel del cuerpo de la configuración
  const groups = bodyMatch[1].match(/<(div class="group"|details class="advanced-group")[^>]*>/g) || [];
  assert(groups.length >= 15, `Debería haber al menos 15 grupos de configuración; real: ${groups.length}`);
  for (const g of groups) {
    assert(/data-cat="[a-z]+"/.test(g), `Grupos sin data-cat: ${g}`);
  }
});

test('Las categorías que usan los grupos están en la navegación (no aparece «la pulsé y está vacía»)', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const used = (bodyMatch[1].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const usedSet = Array.from(new Set(used));
  for (const u of usedSet) {
    assert(navIds.includes(u), `La categoría ${u} no tiene elemento de navegación`);
  }
  // Cada categoría tiene al menos un grupo; las categorías vacías deben quitarse de la navegación
  for (const n of navIds) {
    assert(used.includes(n), `La categoría ${n} no tiene ningún grupo; no debería estar en la navegación`);
  }
});

test('Los grupos clave están en categorías razonables', () => {
  const expect = [
    ['id="runtimeGroup"', 'basic'],
    ['id="perfGroup"', 'perf'],
    ['id="preflightGroup"', 'diag'],
    ['id="driverGroup"', 'diag'],
    ['id="autodebugGroup"', 'diag'],
    ['id="downloadGroup"', 'net'],
    ['id="updateGroup"', 'about'],
    ['id="aboutGroup"', 'about'],
  ];
  for (const [marker, cat] of expect) {
    const idx = html.indexOf(marker);
    assert(idx > 0, `No se encuentra ${marker}`);
    const tail = html.slice(idx, idx + 120);
    assert(tail.includes(`data-cat="${cat}"`), `${marker} debería ir en ${cat}`);
  }
});

test('La tabla de categorías de la interfaz corresponde uno a uno con la navegación', () => {
  const m = appJs.match(/const SETTINGS_CATS = \[([\s\S]*?)\];/);
  assert(m, 'app.js debería tener SETTINGS_CATS');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  assert(ids.length === navIds.length, `Categorías en la interfaz: ${ids.length}; en la navegación: ${navIds.length} ejemplos incluidos`);
  for (const n of navIds) {
    assert(ids.includes(n), `A la interfaz le falta la categoría ${n}`);
  }
});

console.log('\n[Categorías de configuración · comportamiento]');
test('Están implementados el cambio, el filtrado y la memoria', () => {
  assert(appJs.includes('function switchSettingsCat'), 'Debería haber una función para cambiar de categoría');
  assert(appJs.includes('function applySettingsFilter'), 'Debería haber una función de filtrado de visibilidad');
  assert(appJs.includes('function groupMatches'), 'Debería haber una función de coincidencia de búsqueda');
  assert(appJs.includes('function focusGroup'), 'Debería haber una función para ir a un grupo');
  assert(appJs.includes('lanzadorapk.settings.cat'), 'Debería recordar la última categoría visitada');
});

test('La búsqueda abarca todas las categorías (si no, se encuentra algo pero no se ve)', () => {
  // Al filtrar, la visibilidad la decide la coincidencia, no solo la categoría actual
  const fn = appJs.match(/function applySettingsFilter\(\) \{[\s\S]*?\n\}/);
  assert(fn, 'Debería poder ubicar applySettingsFilter');
  assert(/g\.hidden = q \? !hit : !inCat/.test(fn[0]), 'Al buscar debe mostrar según la coincidencia (en todas las categorías)');
});

test('Todos los accesos de salto usan focusGroup (sigue ubicando el grupo tras cambiar de categoría)', () => {
  assert(appJs.includes("focusGroup($('runtimeGroup'))"), 'El asistente de implementación debería ir al grupo del runtime');
  assert(appJs.includes("focusGroup($('perfGroup'))"), 'Los problemas de la partición de datos deberían ir al grupo de rendimiento');
  // El viejo posicionamiento directo con scrollIntoView ya debe haberse reemplazado por focusGroup
  const direct = appJs.match(/box\.scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\)/g) || [];
  assert(direct.length === 0, `Ya no debería haber ubicaciones con scrollIntoView directo (quedan ${direct.length} )`);
});

test('Los botones de reparación del panel de comprobación automática reutilizan fixIssue', () => {
  assert(appJs.includes('data-code="${esc(it.code)}"'), 'Cada elemento detectado debe llevar code para poder repararse');
  assert(appJs.includes('fixIssue(issue)'), 'Debería reutilizar el punto de entrada de reparación único');
});

console.log('\n[Categorías de configuración · estilos]');
test('Hay estilos para la navegación, la búsqueda y el panel de comprobación', () => {
  for (const sel of ['.set-nav', '.set-nav-item', '.set-search', '.dbg-list', '.dbg-item', '.modal-main']) {
    assert(css.includes(sel), `style.css debería tener ${sel}`);
  }
});

test('El diálogo es más ancho pero no se sale en pantallas pequeñas', () => {
  assert(/\.modal \{[^}]*width: 880px/.test(css), 'El diálogo debería medir 880px');
  assert(css.includes('max-width: calc(100vw - 48px)'), 'En pantallas pequeñas debería adaptarse');
});

console.log(`\nResultado: ${passed} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
