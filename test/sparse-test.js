'use strict';
/* Partición de datos dispersa: cuándo compactar y (solo en Windows, p. ej. en el CI) que el contenido no cambia. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sparse = require('../src/core/sparse');

let passed = 0;
let failed = 0;
const out = [];
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
async function test(name, fn) {
  try { await fn(); passed += 1; out.push(`  ✓ ${name}`); } catch (e) { failed += 1; out.push(`  ✗ ${name}\n    ${e.message}`); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-sparse-'));

function bigFile(name, mb) {
  const f = path.join(TMP, name);
  const fd = fs.openSync(f, 'w');
  fs.ftruncateSync(fd, mb * 1024 * 1024);
  fs.closeSync(fd);
  return f;
}

(async () => {
  await test('plan: primera vez compacta desde el principio; imágenes pequeñas no', async () => {
    const big = bigFile('a.img', 600);
    const p = sparse.plan(big, null);
    assert(p.run && p.start === 0, JSON.stringify(p));
    const small = bigFile('b.img', 10);
    assert(!sparse.plan(small, null).run, 'una imagen pequeña no vale la pena');
    assert(!sparse.plan(path.join(TMP, 'no-existe.img'), null).run, 'sin archivo no hay nada que hacer');
  });

  await test('plan: si quedó a medias continúa donde iba', async () => {
    const f = path.join(TMP, 'a.img');
    const st = fs.statSync(f);
    const p = sparse.plan(f, { size: st.size, done: false, next: 300 * 1048576, at: Date.now() });
    assert(p.run && p.start === 300 * 1048576, JSON.stringify(p));
  });

  await test('plan: ya compactada y sin cambios → no repite; con cambios solo una vez al día', async () => {
    const f = path.join(TMP, 'a.img');
    const st = fs.statSync(f);
    assert(!sparse.plan(f, { size: st.size, mtimeMs: st.mtimeMs, done: true, next: 0, at: Date.now() }).run, 'sin cambios no repite');
    const changed = { size: st.size, mtimeMs: st.mtimeMs - 60000, done: true, next: 0 };
    assert(!sparse.plan(f, { ...changed, at: Date.now() - 3600 * 1000 }).run, 'cambió hace poco: espera al día siguiente');
    const p = sparse.plan(f, { ...changed, at: Date.now() - 25 * 3600 * 1000 });
    assert(p.run && p.start === 0, JSON.stringify(p));
  });

  await test('fuera de Windows no hace nada (ni lanza PowerShell)', async () => {
    const f = path.join(TMP, 'a.img');
    assert(sparse.flag(f, { platform: 'linux' }).skipped, 'flag');
    assert((await sparse.compact(f, { platform: 'linux' })).skipped, 'compact');
  });

  await test('parseLine tolera salida rara de PowerShell', async () => {
    assert(sparse.parseLine('basura\n{"ok":true,"done":true}\n').ok === true, 'última línea JSON');
    assert(sparse.parseLine('').ok === false, 'vacío');
  });

  await test('el script es ASCII puro (PowerShell 5.1 lo leería mal si no)', async () => {
    const s = fs.readFileSync(sparse.SCRIPT, 'utf8');
    assert([...s].every((c) => c.charCodeAt(0) < 128), 'sparse.ps1 tiene caracteres no ASCII');
  });

  if (process.platform === 'win32') {
    await test('Windows: compactar no cambia el contenido y no ocupa más disco que antes', async () => {
      const f = path.join(TMP, 'w.img');
      const size = 24 * 1024 * 1024;
      const buf = Buffer.alloc(size, 0);
      buf.fill(7, 0, 4096);                         // datos al principio
      buf.fill(9, 12 * 1048576, 12 * 1048576 + 10); // datos en medio
      buf.fill(5, size - 3, size);                   // datos al final
      fs.writeFileSync(f, buf);
      const r = await sparse.compact(f, { maxSeconds: 30 });
      assert(r.ok && r.done, JSON.stringify(r));
      assert(r.after <= r.before, `en disco: ${r.before} → ${r.after}`);
      assert(r.after < r.before, `debería liberar los bloques en cero: ${r.before} → ${r.after}`);
      assert(Buffer.compare(fs.readFileSync(f), buf) === 0, 'el contenido cambió');
    });

    await test('Windows: no toca un archivo que otro proceso tiene abierto', async () => {
      const f = path.join(TMP, 'w.img');
      const fd = fs.openSync(f, 'r+');
      try {
        const r = await sparse.compact(f, { maxSeconds: 10 });
        assert(r.ok === false, JSON.stringify(r));
      } finally { fs.closeSync(fd); }
    });
  }

  console.log('\n[partición de datos dispersa]');
  console.log(out.join('\n'));
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
