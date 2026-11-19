'use strict';
/**
 * Verificación de extremo a extremo de que «al abrir el programa solo se ve su interfaz»:
 *   1) se inicia un LanzadorAPK real con APPDATA aislado (--smoke sale solo normalmente a los 6,5 s);
 *   2) se pone un registro de app falso en el entorno aislado para activar el «precalentamiento al abrir»: el emulador arranca en frío en segundo plano;
 *   3) se vigilan todo el tiempo las ventanas visibles con el agente: no puede aparecer la principal del emulador / la consola de qemu / la de netsim;
 *   4) tras salir se vigila 8 s más: para confirmar que no «queda» una ventana negra de Android Emulator en el escritorio.
 *
 * Uso: node tools/check-quit-clean.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// El runtime y la carpeta de datos de Android pueden estar en otro disco; en las pruebas se apuntan con variables de entorno,
// para no volver a descargar cada vez 1,4 GB de runtime ni crear otro AVD vacío.
const ENGINE = path.resolve(process.env.LANZADORAPK_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.LANZADORAPK_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const sandbox = path.join(require('os').tmpdir(), `apk-quit-${Date.now()}`);
  const appData = path.join(sandbox, 'lanzadorapk');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'apps.json'), JSON.stringify({
    apps: [{ package: 'com.example.demo', label: 'Demo', installedAt: Date.now() }],
  }));
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR },
    engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);
  console.log('agent ready, port=', agent.port);

  // En este entorno está puesto globalmente ELECTRON_RUN_AS_NODE=1 (Electron se comporta como Node puro);
  // hay que eliminarlo por completo: una cadena vacía sigue contando como «definido» y no arranca.
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = spawn(ELECTRON, ['.', '--smoke', path.join(sandbox, 'smoke.png')], {
    cwd: ROOT,
    env,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });

  let leaked = 0;
  let exitedAt = 0;
  for (let i = 0; i < 70; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const hit = ((r && r.list) || []).filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] 可见的异常窗口:`, JSON.stringify(hit));
    }
    if (!exitedAt && proc.exitCode !== null) {
      exitedAt = i;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] LanzadorAPK 已退出，继续观察 8 秒…`);
    }
    if (exitedAt && i - exitedAt >= 16) break;
  }

  const after = ((await agent.call({ cmd: 'windows' }, 5000).catch(() => null)) || {}).list || [];
  const left = after.filter(bad);
  console.log('退出后仍在桌面上的异常窗口:', JSON.stringify(left));
  console.log('');
  const ok = leaked === 0 && left.length === 0;
  console.log(`结果：${ok ? '通过（全程零可见窗口）' : '失败'}`);
  if (out) console.log('--- app 输出 ---\n' + out.trim().split('\n').slice(-6).join('\n'));

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  // El AVD del entorno aislado ocupa varios GB; se borra al terminar (falla si el emulador aún usa los archivos; se ignora)
  try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
