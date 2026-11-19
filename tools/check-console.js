'use strict';
/**
 * Verificación de ventanas negras: lanza emulator igual que el proceso principal y comprueba si el agente de ventanas suprime la «ventana negra de consola».
 *
 * Deducirlo solo del código no es fiable: la ventana de consola pertenece a conhost.exe y su pid no coincide en nada con emulator;
 * solo cuenta enumerar de verdad las ventanas visibles.
 *
 * Uso: node tools/check-console.js [appRoot]
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const INSTALL = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'lanzadorapk');
const EMU = path.join(INSTALL, 'resources', 'runtime', 'emulator', 'emulator.exe');
const AVD_HOME = path.join(process.env.APPDATA || '', 'lanzadorapk', 'avd');
const ROOT = path.join(INSTALL, 'resources', 'runtime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ROOT]);
  console.log('agent ready, port=', agent.port);

  const list = async () => {
    const r = await agent.call({ cmd: 'consoles' }, 4000);
    return (r && r.list) || [];
  };

  const before = await list();
  console.log('Ventanas de consola visibles antes de iniciar:', JSON.stringify(before));

  // Igual que el proceso principal: detached + windowsHide + pipe
  const proc = spawn(EMU, [
    '-avd', 'lanzadorapk', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'lanzadorapk',
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

  let sawConsole = 0;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const l = await list();
    const ours = l.filter((w) => w.ours);
    if (ours.length > sawConsole) {
      sawConsole = ours.length;
      console.log(`[${(i + 1) * 0.5} s] apareció una ventana negra:`, JSON.stringify(ours));
    }
  }
  const afterSpawn = (await list()).filter((w) => w.ours);
  console.log('Ventanas negras aún en pantalla sin supresión:', JSON.stringify(afterSpawn));

  console.log('--- activando bootHide ---');
  const r = await agent.bootHide();
  console.log('bootHide:', JSON.stringify(r));
  await sleep(1500);
  const afterHide = (await list()).filter((w) => w.ours);
  console.log('Ventanas negras que quedan tras suprimir:', JSON.stringify(afterHide));

  console.log('');
  console.log(afterHide.length === 0
    ? `Resultado: correcto (durante el inicio aparecieron ${sawConsole} ventanas negras; tras suprimir ninguna es visible)`
    : 'Resultado: fallido (aún hay ventanas negras visibles)');

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(afterHide.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
