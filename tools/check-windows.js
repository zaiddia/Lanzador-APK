'use strict';
/**
 * Verificación de ventanas: lanza emulator igual que el proceso principal y confirma que «no aparece ni una ventana de más en el escritorio».
 *
 * Se vigilan dos tipos de ventanas:
 *   1. "Android Emulator - lanzadorapk5554" (QWindowIcon, la ventana principal del emulador)
 *      — normalmente solo aparece tras la incrustación, como hija de nuestra ventana; nunca se ve en el escritorio;
 *   2. ventanas negras de consola (ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS de conhost)
 *      — qemu y netsimd abren una cada uno, con la ruta del exe lanzado como título.
 *
 * Uso: node tools/check-windows.js [runtimeRoot]
 *   runtimeRoot por defecto es engine/ del repositorio (el runtime descargado localmente); también se puede pasar el
 *   resources/runtime de la carpeta de instalación.
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

// Carpeta del runtime: argumento de línea de comandos > variable de entorno > engine/ del repositorio
const ROOT = path.resolve(process.argv[2] || process.env.LANZADORAPK_RUNTIME || path.join(__dirname, '..', 'engine'));
const EMU = path.join(ROOT, 'emulator', 'emulator.exe');
// El AVD puede estar en otro disco (runtime.avdDir en la configuración), algo común entre usuarios; aquí también se puede indicar explícitamente
const AVD_HOME = process.env.LANZADORAPK_AVD_HOME
  || path.join(process.env.APPDATA || '', 'lanzadorapk', 'avd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  console.log('agent ready, port=', agent.port);

  const windows = async () => {
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    return (r && r.list) || [];
  };

  // El agente solo toca ventanas creadas por «procesos de la carpeta del runtime»: primero se declara el alcance; si no, no oculta nada
  await agent.scope([ROOT]);
  await agent.bootHide();
  console.log('常驻压制已开启');

  const proc = spawn(EMU, [
    '-avd', 'lanzadorapk', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'lanzadorapk', '-no-snapshot-load',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  let leaked = 0;
  const ticks = Math.max(24, Number(process.env.CHECK_SECONDS || 0) * 2 || 24);
  for (let i = 0; i < ticks; i += 1) {
    await sleep(500);
    const list = await windows();
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] 可见的异常窗口:`, JSON.stringify(hit));
    }
  }

  const probe = await agent.probe().catch(() => null);
  console.log('probe（隐藏窗口也应当能被找到）:', JSON.stringify(probe));

  const left = (await windows()).filter(bad);
  console.log('结束时仍在桌面上的异常窗口:', JSON.stringify(left));

  const okProbe = !!(probe && Number(probe.emu) !== 0);
  // Se permite que «apareciera pero se suprimiera en menos de 400 ms»; al final debe ser 0
  const ok = left.length === 0 && okProbe;
  console.log('');
  console.log(`结果：${ok ? '通过' : '失败'}（过程中可见异常窗口累计 ${leaked} 次，结束时 ${left.length} 个）`);

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
