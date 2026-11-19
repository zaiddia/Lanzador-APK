'use strict';
/**
 * Pruebas en Node puro de la validación de rangos del descargador (sin red real/emulador).
 * Cubre la validación de Content-Range y la corrección de reanudación con 416 aportadas en #92:
 *   - validRange compara uno a uno inicio/fin, tamaño total y Content-Length;
 *   - con una sola conexión, ante un 416 se descarta el fragmento dañado y se descarga todo de nuevo;
 *   - la descarga por bloques/multifuente rechaza rangos que no coinciden y no mete bytes dañados en el archivo final.
 * Ejecutar: node test/range-validation-test.js
 */
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { download, downloadParallel, downloadMulti, validRange } = require('../src/core/download');

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

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

(async () => {
  console.log('\n[download.js validación de Content-Range]');

  test('validRange acepta respuestas que coinciden por completo', () => {
    const res = { headers: { 'content-range': 'bytes 100-199/500', 'content-length': '100' } };
    assert.equal(validRange(res, 100, 199, 500), true);
  });
  test('validRange tolera que falte Content-Length', () => {
    const res = { headers: { 'content-range': 'bytes 100-199/500' } };
    assert.equal(validRange(res, 100, 199, 500), true);
  });
  test('validRange rechaza inicio/fin/tamaño total/longitud erróneos', () => {
    const hdr = (cr, len) => ({ headers: { 'content-range': cr, 'content-length': len } });
    assert.equal(validRange(hdr('bytes 101-199/500', '99'), 100, 199, 500), false, 'El inicio no coincide');
    assert.equal(validRange(hdr('bytes 100-198/500', '99'), 100, 199, 500), false, 'El fin no coincide');
    assert.equal(validRange(hdr('bytes 100-199/400', '100'), 100, 199, 500), false, 'El tamaño total no coincide');
    assert.equal(validRange(hdr('bytes 100-199/500', '99'), 100, 199, 500), false, 'La longitud no coincide');
    assert.equal(validRange(hdr('', '100'), 100, 199, 500), false, 'Falta Content-Range');
    assert.equal(validRange(hdr('bytes 0-3/8', '4'), 0, 3, 8), true);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-range-'));
  try {
    // /416: con Range responde 416; sin Range responde el "good" completo
    // /bad: la prueba bytes=0-0 recibe encabezados válidos; el resto siempre recibe bytes 0-3/8 (no coincide con lo pedido)
    const server = await serve((req, res) => {
      const r = req.headers.range;
      if (req.url === '/416') {
        if (r) { res.writeHead(416, { 'Content-Range': 'bytes */4' }); res.end(); }
        else { res.writeHead(200, { 'Content-Length': '4' }); res.end('good'); }
      } else if (req.url === '/ok') {
        if (r === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/8', 'Content-Length': '1' }); res.end('a'); }
        else if (r) {
          const m = /bytes=(\d+)-(\d+)/.exec(r);
          const s = Number(m[1]); const e = Number(m[2]); const body = 'abcdefgh'.slice(s, e + 1);
          res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/8`, 'Content-Length': String(body.length) });
          res.end(body);
        } else { res.writeHead(200, { 'Content-Length': '8' }); res.end('abcdefgh'); }
      } else {
        if (r === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/8', 'Content-Length': '1' }); res.end('a'); }
        else { res.writeHead(206, { 'Content-Range': 'bytes 0-3/8', 'Content-Length': '4' }); res.end('abcd'); }
      }
    });
    const base = baseOf(server);
    try {
      await atest('416 con una sola conexión: descarta el fragmento dañado y vuelve a descargar todo', async () => {
        const out = path.join(dir, 'one');
        fs.writeFileSync(out, 'corrupt data');
        await download(`${base}/416`, out);
        assert.equal(fs.readFileSync(out, 'utf8'), 'good');
      });

      await atest('Con una sola conexión se rechaza un 206 con rango que no coincide', async () => {
        const out = path.join(dir, 'resume');
        fs.writeFileSync(out, 'xxxx'); // Hace que la petición lleve Range: bytes=4-
        await assert.rejects(download(`${base}/bad`, out), /rango/);
      });

      await atest('downloadParallel rechaza rangos que no coinciden y no deja archivos a medias', async () => {
        const out = path.join(dir, 'two');
        await assert.rejects(
          downloadParallel(`${base}/bad`, out, { connections: 2, minChunk: 2, retries: 1 }),
          /rango/,
        );
        assert.equal(fs.existsSync(out), false, 'Tras fallar, el archivo de destino debería limpiarse');
      });

      await atest('downloadMulti rechaza rangos que no coinciden', async () => {
        const out = path.join(dir, 'three');
        await assert.rejects(
          downloadMulti([`${base}/bad1`, `${base}/bad2`], out, { connections: 2, minChunk: 2, retries: 1 }),
          /rango/,
        );
      });

      await atest('Con rangos válidos la descarga sigue funcionando (sin regresión)', async () => {
        const out = path.join(dir, 'ok');
        const r = await download(`${base}/ok`, out, { retries: 1 });
        assert.equal(fs.readFileSync(out, 'utf8'), 'abcdefgh');
        assert.equal(r.size, 8);
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
