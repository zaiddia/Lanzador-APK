'use strict';
/* Espacio en disco: tamaño descomprimido de .xz/.gz, mensajes de «sin espacio», elección de otro disco
   y respeto de la «Carpeta de datos de Android». Node puro, sin Electron ni emulador. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-disk-'));
process.env.APPDATA = TMP;
const ds = require('../src/core/diskspace');
const { avdHomeFor } = require('../src/core/provision');

let passed = 0;
let failed = 0;
const out = [];
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function test(name, fn) {
  try { fn(); passed += 1; out.push(`  ✓ ${name}`); } catch (e) { failed += 1; out.push(`  ✗ ${name}\n    ${e.message}`); }
}
function varint(n) {
  const b = [];
  do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n);
  return b;
}
/** .xz sintético: solo lo que lee el analizador (índice + pie), suficiente para la prueba */
function fakeXz(file, sizes, padding = 0) {
  let idx = [0x00, ...varint(sizes.length)];
  for (const s of sizes) idx.push(...varint(1000), ...varint(s));
  while (idx.length % 4) idx.push(0);
  idx.push(0, 0, 0, 0); // CRC32 (no se verifica)
  const footer = Buffer.alloc(12);
  footer.writeUInt32LE(idx.length / 4 - 1, 4);
  footer[10] = 0x59; footer[11] = 0x5a;
  const head = Buffer.alloc(64, 0xaa);
  head.write('\u00fd7zXZ\u0000', 0, 'latin1');
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(idx), footer, Buffer.alloc(padding)]));
}

test('xz: suma el tamaño descomprimido de todos los bloques del índice (también > 4 GiB)', () => {
  const f = path.join(TMP, 'a.img.xz');
  fakeXz(f, [3 * 1024 ** 3, 2 * 1024 ** 3]);
  const r = ds.uncompressedSize(f);
  assert(r.exact && r.bytes === 5 * 1024 ** 3, JSON.stringify(r));
});

test('xz: tolera el relleno de stream (ceros al final)', () => {
  const f = path.join(TMP, 'b.img.xz');
  fakeXz(f, [123456789], 8);
  assert(ds.xzUncompressedSize(f) === 123456789, String(ds.xzUncompressedSize(f)));
});

test('xz real (si hay xz en el equipo): coincide con el tamaño original', () => {
  const raw = Buffer.alloc(3 * 1024 * 1024, 7);
  const f = path.join(TMP, 'real.img');
  fs.writeFileSync(f, raw);
  try { execFileSync('xz', ['-k', '-1', '-f', f], { stdio: 'ignore' }); } catch (_) { return; } // sin xz se omite
  assert(ds.xzUncompressedSize(`${f}.xz`) === raw.length, String(ds.xzUncompressedSize(`${f}.xz`)));
});

test('gz: usa ISIZE del final del archivo', () => {
  const raw = Buffer.alloc(2 * 1024 * 1024, 3);
  const f = path.join(TMP, 'c.img.gz');
  fs.writeFileSync(f, zlib.gzipSync(raw));
  const r = ds.uncompressedSize(f);
  assert(r.exact && r.bytes === raw.length, JSON.stringify(r));
});

test('archivo dañado: estimación prudente (4 veces el comprimido), sin lanzar error', () => {
  const f = path.join(TMP, 'd.img.xz');
  fs.writeFileSync(f, Buffer.alloc(1000, 1));
  const r = ds.uncompressedSize(f);
  assert(!r.exact && r.bytes === 4000, JSON.stringify(r));
});

test('isDiskFullError reconoce ENOSPC y mensajes equivalentes', () => {
  const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC';
  assert(ds.isDiskFullError(e));
  assert(ds.isDiskFullError(new Error('There is not enough space on the disk.')));
  assert(!ds.isDiskFullError(new Error('ECONNRESET')));
});

test('diskFullError dice cuánto falta, cuánto hay y dónde cambiarlo', () => {
  const e = ds.diskFullError({ dir: 'C:\\Users\\x\\AppData', needMB: 4096, freeMB: 1024, what: 'descomprimir la imagen' });
  assert(e.code === 'DISK_FULL', e.code);
  assert(/C:/.test(e.message) && /4\.0 GB/.test(e.message) && /1\.0 GB/.test(e.message), e.message);
  assert(/Integración con el sistema/.test(e.message), e.message);
});

test('pickRoomierDrive propone otro disco solo si el actual no alcanza y el otro sí', () => {
  const drives = [{ drive: 'C:', root: 'C:\\', freeMB: 6000 }, { drive: 'D:', root: 'D:\\', freeMB: 200000 }, { drive: 'E:', root: 'E:\\', freeMB: 9000 }];
  const best = ds.pickRoomierDrive({ currentDir: 'C:\\Users\\x', needMB: 16384, drives });
  assert(best && best.drive === 'D:', JSON.stringify(best));
  const roomy = [{ drive: 'C:', root: 'C:\\', freeMB: 500000 }, { drive: 'D:', root: 'D:\\', freeMB: 900000 }];
  assert(ds.pickRoomierDrive({ currentDir: 'C:\\Users\\x', needMB: 16384, drives: roomy }) === null, 'con C: de sobra no debe preguntar');
  const small = [{ drive: 'C:', root: 'C:\\', freeMB: 3000 }, { drive: 'D:', root: 'D:\\', freeMB: 12000 }];
  assert(ds.pickRoomierDrive({ currentDir: 'C:\\Users\\x', needMB: 16384, drives: small }) === null, 'un disco que tampoco alcanza no sirve');
  assert(ds.listDrives({ platform: 'linux' }).length === 0, 'fuera de Windows no hay letras de unidad');
});

test('Carpeta de datos de Android: la elegida por el usuario se respeta aunque el runtime esté en %APPDATA%', () => {
  const root = path.join(TMP, 'rt');
  const explicitAvd = path.join(TMP, 'D-android-data');
  const home = avdHomeFor({ root, insideData: true, explicitAvd, writable: explicitAvd });
  assert(home === explicitAvd, home);
  assert(avdHomeFor({ root, insideData: true, explicitAvd: '', writable: path.join(TMP, 'avd') }) === path.join(root, 'avd'), 'sin elección sigue igual que antes');
});

test('Carpeta de datos de Android: si ya hay apps en la ubicación anterior y la nueva está vacía, no se «pierden»', () => {
  const root = path.join(TMP, 'rt2');
  fs.mkdirSync(path.join(root, 'avd', 'lanzadorapk.avd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'avd', 'lanzadorapk.avd', 'config.ini'), 'x');
  const explicitAvd = path.join(TMP, 'D-empty');
  assert(avdHomeFor({ root, insideData: true, explicitAvd, writable: explicitAvd }) === path.join(root, 'avd'), 'debe seguir con el AVD existente');
  fs.mkdirSync(path.join(explicitAvd, 'lanzadorapk.avd'), { recursive: true });
  fs.writeFileSync(path.join(explicitAvd, 'lanzadorapk.avd', 'config.ini'), 'x');
  assert(avdHomeFor({ root, insideData: true, explicitAvd, writable: explicitAvd }) === explicitAvd, 'tras mover la carpeta usa la nueva');
});

// ---- materializeImages: comprobación previa de espacio y borrado de la copia comprimida ----
const store = require('../src/core/store');
const doctor = require('../src/core/doctor');
const { Provisioner } = require('../src/core/provision');
function makeRuntime(name, { marker }) {
  const root = path.join(TMP, name);
  const dir = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024)));
  fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
  if (marker) fs.writeFileSync(path.join(root, '.runtime-pack.json'), '{}');
  store.saveSettings({ runtime: { dir: root } });
  return { root, dir, prov: new Provisioner(TMP) };
}
const pending = [];
function atest(name, fn) { pending.push([name, fn]); }

atest('sin espacio suficiente: error DISK_FULL claro antes de descomprimir (sin dejar archivos a medias)', async () => {
  const { dir, prov } = makeRuntime('rt-full', { marker: true });
  const orig = doctor.freeDiskMB;
  doctor.freeDiskMB = () => 100; // solo 100 MB libres
  try {
    let err = null;
    await prov.materializeImages().catch((e) => { err = e; });
    assert(err && err.code === 'DISK_FULL', err ? err.message : 'no lanzó error');
    assert(/descomprimir la imagen del sistema/.test(err.message), err.message);
    assert(!fs.existsSync(path.join(dir, 'system.img')) && !fs.existsSync(path.join(dir, 'system.img.part')), 'no debe quedar imagen a medias');
    assert(fs.existsSync(path.join(dir, 'system.img.gz')), 'la copia comprimida debe seguir');
  } finally { doctor.freeDiskMB = orig; }
});

atest('runtime descargado: tras descomprimir se borra la copia comprimida (libera espacio)', async () => {
  const { dir, prov } = makeRuntime('rt-pack', { marker: true });
  const n = await prov.materializeImages();
  assert(n === 1, `descomprimidas: ${n}`);
  assert(fs.statSync(path.join(dir, 'system.img')).size === 40 * 1024 * 1024, 'tamaño de la imagen');
  assert(!fs.existsSync(path.join(dir, 'system.img.gz')), 'la copia comprimida debería borrarse');
  assert(await prov.materializeImages() === 0, 'la segunda vez no hay nada que hacer');
});

atest('runtime incluido en el instalador (sin marca): la copia comprimida se conserva', async () => {
  const { dir, prov } = makeRuntime('rt-bundled', { marker: false });
  await prov.materializeImages();
  assert(fs.existsSync(path.join(dir, 'system.img')), 'debe descomprimir');
  assert(fs.existsSync(path.join(dir, 'system.img.gz')), 'en el instalador completo no se borra');
});

(async () => {
  for (const [n, fn] of pending) {
    try { await fn(); passed += 1; out.push(`  ✓ ${n}`); } catch (e) { failed += 1; out.push(`  ✗ ${n}\n    ${e.message}`); }
  }
console.log('\n[espacio en disco]');
console.log(out.join('\n'));
console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(failed ? 1 : 0);
})();
