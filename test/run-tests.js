'use strict';
/**
 * Pruebas unitarias en Node puro (sin depender de Electron / adb / red)
 * Ejecutar: npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

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

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('Puede analizar la estructura de un zip con el package.json del propio proyecto', () => {
  // Verifica el análisis con un zip mínimo construido en memoria (modo stored)
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello lanzadorapk');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // Tamaño total del directorio central
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // Desplazamiento del directorio central

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), 'Debería encontrar hello.txt');
  assert(zip.read('hello.txt').toString() === 'hello lanzadorapk', 'El contenido debería coincidir');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('El codificador PNG produce firma e IHDR válidos', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'Firma PNG');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, 'Longitud razonable');
});
test('El icono de la app puede dibujarse en cualquier tamaño', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `El ancho debería ser ${s}; real: ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// APK de prueba: primero el indicado en la variable de entorno LANZADORAPK_TEST_APK,
// si no, se prueban ubicaciones comunes de APK en el equipo (solo lectura, sin copiar)
function findFixture() {
  const candidates = [
    process.env.LANZADORAPK_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  (APK de prueba: ${fixture})`);
  test('quickCheck reconoce el encabezado PK', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('Obtiene nombre de paquete / versión / Activity de inicio', () => {
    assert(/^[\w.]+$/.test(meta.package), `Nombre de paquete anómalo: ${meta.package}`);
    assert(meta.versionName, 'Falta versionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `Activity de inicio anómala: ${meta.launchActivity}`);
  });
  test('Obtiene un icono utilizable', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, 'El icono está vacío o es muy pequeño');
    assert(meta.label, 'El nombre de la app está vacío');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('El nodo raíz AXML es manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('resources.arsc se puede analizar', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, 'Debería haber al menos un package');
    }
  });
} else {
  console.log('  (Omitida: no se encontró el APK de prueba; puedes indicar LANZADORAPK_TEST_APK)');
}

// El constructor de APK sintéticos está en test/lib/make-apk.js: cubre la pila de análisis aunque falten los APK reales,
// y run-tests / auto-test comparten la misma copia (para no tener dos ensamblados de bytes distintos).
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[APK sintético: cadena completa axml + apk]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('Semántica del espacio de nombres de attrValue: null = sin restricción; por defecto solo android', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: '测试' },
      ],
    };
    // Los atributos sin espacio de nombres (como package) solo se obtienen pasando null; es la condición clave de parseApk
    assert(attrValue(node, 'package', null) === 'com.a.b', 'package necesita ns=null');
    assert(attrValue(node, 'package') === null, 'Por defecto solo reconoce el espacio de nombres android');
    assert(attrValue(node, 'label') === '测试', 'Los atributos android usan el espacio de nombres por defecto');
    assert(attrValue(node, 'label', null) === '测试', 'Con ns=null debería encontrar los atributos android');
  });
}
{
  const tmp = path.join(os.tmpdir(), `lanzadorapk-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('Nombre de paquete: package en manifest es un atributo sin espacio de nombres', () => {
      assert(meta.package === 'com.example.test', `Real: ${meta.package}`);
    });
    test('Nombre de la app / versión / SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('La Activity de inicio se obtiene de intent-filter', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('Carpetas ABI y recursos de icono', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, 'El icono debería ser PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, 'El tamaño del archivo debería completarse');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

{
  const { detectOrientation } = require('../src/core/apk');
  const { ANDROID_NS } = require('../src/core/axml');
  const act = (name, ori) => ({
    name: 'activity',
    attrs: [
      { ns: ANDROID_NS, name: 'name', typed: name },
      ...(ori == null ? [] : [{ ns: ANDROID_NS, name: 'screenOrientation', typed: ori }]),
    ],
  });
  test('Orientación de pantalla: la orientación natural de la app se calcula a partir de lo que declaran sus Activity', () => {
    // El caso de «decenas de portrait + una pantalla de inicio sensor» → portrait
    const hongguo = [
      act('SplashActivity', 3), act('MainActivity', 1), act('ReaderActivity', 3),
      act('WebActivity', 1), act('DetailActivity', 1),
    ];
    assert(detectOrientation(hongguo, hongguo[0]) === 'portrait', 'Si la mayoría declara portrait debe ser vertical');
    // El caso de una sola Activity declarada landscape
    const modu = [act('MainActivity', 2)];
    assert(detectOrientation(modu, modu[0]) === 'landscape', 'Una sola Activity landscape debe ser horizontal');
    // Todo sensor / todo unspecified → no se puede decidir, se deja a la configuración
    const sensorOnly = [act('A', 3), act('B', 11), act('C', 0), act('D', 14)];
    assert(detectOrientation(sensorOnly, sensorOnly[0]) === null, 'Si todo sigue a la gravedad debe devolver null');
    assert(detectOrientation([act('A', null)], null) === null, 'Sin orientación declarada devuelve null');
    // La Activity de inicio pesa más: decide la primera pantalla que ve el usuario
    const launcherWins = [act('Launcher', 2), act('P1', 1), act('P2', 1), act('P3', 1)];
    assert(detectOrientation(launcherWins, launcherWins[0]) === 'landscape', 'La orientación de la Activity de inicio debe pesar más');
    // reversePortrait / userLandscape y similares también deben ir al lado correcto
    assert(detectOrientation([act('A', 7)], null) === 'portrait', 'reversePortrait cuenta como vertical');
    assert(detectOrientation([act('A', 12)], null) === 'landscape', 'userLandscape cuenta como horizontal');
  });
}

console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
process.exit(failed ? 1 : 0);
