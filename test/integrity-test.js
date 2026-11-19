'use strict';
/* Integrity checks for downloads (SHA-256 for releases, SHA-1 for Google SDK). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseDigest, parseSums, verifyFile, sdkChecksums } = require('../src/core/integrity');

let passed = 0;
let failed = 0;
const results = [];
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✓ ${name}`); } catch (e) { failed += 1; results.push(`  ✗ ${name}\n    ${e.message}`); }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'));
  const file = path.join(tmp, 'a.bin');
  const data = Buffer.from('hola mundo');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const sha1 = crypto.createHash('sha1').update(data).digest('hex');

  await test('parseDigest acepta el formato de la API de GitHub', () => {
    assert(parseDigest(`sha256:${sha256.toUpperCase()}`) === sha256);
    assert(parseDigest('md5:abc') === '' && parseDigest(null) === '');
  });

  await test('parseSums lee la salida de sha256sum (con y sin *)', () => {
    const m = parseSums(`${sha256}  App-v1-Setup.exe\r\n${sha256} *App-v1-portable.zip\nbasura\n`);
    assert(m.get('App-v1-Setup.exe') === sha256 && m.get('App-v1-portable.zip') === sha256 && m.size === 2);
  });

  await test('verifyFile acepta el archivo correcto', async () => {
    fs.writeFileSync(file, data);
    assert(await verifyFile(file, sha256, 'sha256'));
    assert(await verifyFile(file, sha1, 'sha1'));
  });

  await test('verifyFile rechaza y borra un archivo alterado', async () => {
    fs.writeFileSync(file, Buffer.from('hola mundo!'));
    let err = null;
    try { await verifyFile(file, sha256, 'sha256', 'paquete'); } catch (e) { err = e; }
    assert(err && err.code === 'INTEGRITY', 'debería fallar');
    assert(!fs.existsSync(file), 'el archivo alterado debe eliminarse');
  });

  await test('verifyFile rechaza una suma mal formada', async () => {
    fs.writeFileSync(file, data);
    let err = null;
    try { await verifyFile(file, 'xyz', 'sha256'); } catch (e) { err = e; }
    assert(err, 'debería fallar');
  });

  await test('sdkChecksums extrae SHA-1 por URL del XML de Google', () => {
    const xml = `<remotePackage path="emulator"><archives><archive><complete><size>123</size>
      <checksum type="sha1">${sha1}</checksum><url>emulator-windows_x64-1.zip</url></complete><host-os>windows</host-os></archive>
      <archive><complete><size>9</size><checksum>${'b'.repeat(40)}</checksum><url>emulator-linux-1.zip</url></complete></archive></archives></remotePackage>`;
    const m = sdkChecksums(xml, (u) => `https://dl.google.com/android/repository/${u}`);
    const w = m.get('https://dl.google.com/android/repository/emulator-windows_x64-1.zip');
    assert(w && w.sha1 === sha1 && w.size === 123);
    assert(m.size === 2);
  });

  await test('El actualizador no instala automáticamente sin SHA-256', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({ currentVersion: '0.0.1', exePath: path.join(tmp, 'App.exe'), dataDir: tmp, settings: {} });
    u.sources.latest = async () => ({
      version: '9.9.9', tag: 'v9.9.9', name: 'v9.9.9', notes: '', htmlUrl: '', publishedAt: '',
      assets: [{ name: 'X-v9.9.9-win64-portable.zip', size: 10, url: 'https://github.com/x', urls: ['https://github.com/x'] }],
      sources: [], unreachable: [],
    });
    const info = await u.check();
    assert(info.hasUpdate && !info.canAutoApply && !info.verified, 'sin suma no debe auto-aplicarse');
    let err = null;
    try { await u.prepare(info); } catch (e) { err = e; }
    assert(err && /SHA-256/.test(err.message), 'prepare debe negarse');
  });

  console.log('\n[integridad de descargas]');
  console.log(results.join('\n'));
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
