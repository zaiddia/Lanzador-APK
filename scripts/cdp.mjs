#!/usr/bin/env node
/**
 * Cliente CDP ligero (sin dependencias; Node 22+ trae WebSocket).
 * Para automatizar publicaciones en el navegador tras iniciar sesión con QR: listar pestañas / navegar / ejecutar JS / capturas / subir archivos.
 *
 * Uso:
 *   node scripts/cdp.mjs list
 *   node scripts/cdp.mjs new <url>
 *   node scripts/cdp.mjs eval <target-match> "<js expression>"
 *   node scripts/cdp.mjs shot <target-match> <out.png>
 *   node scripts/cdp.mjs nav  <target-match> <url>
 *   node scripts/cdp.mjs upload <target-match> <css-selector> <file1> [file2...]
 *
 * <target-match> es una parte de la url o del título; si se omite se usa la primera pestaña tipo page.
 */
import fs from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;

function httpGet(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + pathname, { method }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listTargets() {
  return JSON.parse(await httpGet('/json/list')).filter((t) => t.type === 'page');
}

async function pickTarget(match) {
  const all = await listTargets();
  if (!match) return all[0];
  const t = all.find((x) => (x.url || '').includes(match) || (x.title || '').includes(match));
  if (!t) throw new Error(`No se encontró la pestaña: ${match}\nDisponibles:\n${all.map((x) => `  ${x.url}`).join('\n')}`);
  return t;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Tiempo de espera de CDP agotado: ${method}`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }
  async shot(out) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    return out;
  }
  async upload(selector, files) {
    const doc = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!nodeId) throw new Error(`No se encontró el campo de archivo: ${selector}`);
    await this.send('DOM.setFileInputFiles', { files, nodeId });
    return true;
  }
  close() {
    this.ws.close();
  }
}

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error('Falló la conexión WebSocket: ' + (e?.message || '')));
  });
  return new Cdp(ws);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'list') {
    for (const t of await listTargets()) console.log(`${t.id}\t${t.title}\t${t.url}`);
    return;
  }
  if (cmd === 'new') {
    const r = JSON.parse(await httpGet('/json/new?' + encodeURIComponent(args[0]), 'PUT'));
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === 'pick') {
    console.log(JSON.stringify(await pickTarget(args[0])));
    return;
  }
  const target = await pickTarget(args[0]);
  if (cmd === 'nav') {
    const c = await attach(target);
    await c.send('Page.navigate', { url: args[1] });
    c.close();
    console.log('navigated', args[1]);
    return;
  }
  if (cmd === 'eval') {
    const c = await attach(target);
    const value = await c.eval(args[1]);
    c.close();
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return;
  }
  if (cmd === 'shot') {
    const c = await attach(target);
    await sleep(300);
    await c.shot(args[1]);
    c.close();
    console.log('saved', args[1], fs.statSync(args[1]).size, 'bytes');
    return;
  }
  if (cmd === 'insert') {
    const c = await attach(target);
    let text = args[1] || '';
    if (fs.existsSync(text)) text = fs.readFileSync(text, 'utf8');
    await c.send('Input.insertText', { text });
    c.close();
    console.log('inserted', text.length, 'chars');
    return;
  }
  if (cmd === 'upload') {
    const c = await attach(target);
    await c.upload(args[1], args.slice(2).map((f) => f.replace(/\//g, '\\')));
    c.close();
    console.log('files set:', args.slice(2).length);
    return;
  }
  throw new Error(`Comando desconocido: ${cmd}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
