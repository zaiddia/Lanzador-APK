'use strict';
/**
 * Sonda de incrustación de bases (para desarrollo, no va en la distribución)
 *
 * Objetivo: verificar en una ventana de Electron real si «la ventana de imagen de una base de terceros se puede incrustar»,
 * sin abrir la interfaz principal ni instalar apps, para probar rápido tras cada cambio.
 *
 * Por qué es una app de Electron mínima aparte (tools/embed-probe/):
 * electron.exe solo trata como app una «carpeta (con package.json)»; pasarle un .js directamente no lo ejecuta.
 *
 * Uso:
 *   set LANZADORAPK_BACKEND=mumu  &  node_modules\electron\dist\electron.exe tools\embed-probe
 *   Ojo: hay que quitar ELECTRON_RUN_AS_NODE (algunos entornos lo ponen en 1 y entonces electron funciona solo como node).
 *
 * Lo que hace:
 *   1. crea la instancia del backend por id y la arranca con ensure();
 *   2. espera a que la ventana esté lista (windowReady);
 *   3. la incrusta en una ventana anfitriona por la misma ruta que el código real (WinAgent.embed, con targets);
 *   4. guarda una captura en .probe/embed-probe-<id>.png y sale.
 */
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const backendId = process.env.LANZADORAPK_BACKEND || 'mumu';
const OUT_DIR = path.join(__dirname, '..', '..', '.probe');

function outDir() {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (_) { /* ignore */ }
  return OUT_DIR;
}

/** El resultado también se escribe en un archivo: el stdout del proceso principal de Electron no se puede capturar en muchas formas de inicio */
function log(m) {
  const line = `[probe] ${m}\n`;
  try { fs.appendFileSync(path.join(outDir(), 'probe.log'), line); } catch (_) { /* ignore */ }
  try { process.stdout.write(line); } catch (_) { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(appRoot) {
  try { fs.writeFileSync(path.join(outDir(), 'probe.log'), ''); } catch (_) { /* ignore */ }

  // Solo aquí se hace require de lo del lado de Electron: el archivo de entrada ya ejecutó app.whenReady()
  const backends = require(path.join(appRoot, 'src', 'core', 'backends'));
  const { WinAgent } = require(path.join(appRoot, 'src', 'core', 'agent'));

  const Cls = backends.byId(backendId);
  if (!Cls) { log(`未知后端 ${backendId}`); return; }
  const backend = new Cls(appRoot, { runtime: null, store: null, log });

  log(`probe ${backendId} …`);
  const probe = await backend.probe();
  log(`probe → ${JSON.stringify(probe)}`);
  if (!probe.found) { log('没有找到这个后端'); return; }

  log('ensure() …');
  const t0 = Date.now();
  const ens = await backend.ensure({ onLog: (m) => log(`  ${m}`) });
  log(`ensure → ok=${ens.ok} serial=${ens.serial} reused=${ens.reused} (${Date.now() - t0}ms)`);
  if (!ens.ok) { log(`失败：${ens.error}`); return; }

  const win = new BrowserWindow({
    width: 560,
    height: 1000,
    show: true,
    frame: false,
    backgroundColor: '#101014',
  });
  await win.loadURL('data:text/html,<html><body style="margin:0;background:%23101014"></body></html>');
  await sleep(900);

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([], process.pid).catch(() => null);
  log('agent ready');

  const ready = await backend.windowReady({}).catch((e) => ({ ok: false, reason: e.message }));
  log(`windowReady → ${JSON.stringify(ready)}`);
  await sleep(1500);

  const targets = await backend.windowTargets().catch(() => []);
  log(`targets → ${JSON.stringify(targets)}`);
  if (!targets.length) { log('拿不到窗口句柄，结束'); return; }

  const buf = win.getNativeWindowHandle();
  const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  const content = win.getContentBounds();
  const r = await agent.embed(Number(hwnd), {
    x: 0, y: 0, w: content.width, h: content.height,
  }, targets);
  log(`embed → ${JSON.stringify(r)}`);

  await sleep(2600);
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  const out = path.join(outDir(), `embed-probe-${backendId}.png`);
  fs.writeFileSync(out, png);
  log(`截图 → ${out} (${png.length} bytes)`);

  await agent.park().catch(() => {});
  agent.dispose();
  log('done');
}

module.exports = { run };
