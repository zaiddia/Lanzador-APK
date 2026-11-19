'use strict';
/**
 * Verificación de extremo a extremo de que «al abrir una app Android solo aparece la ventana de esa app»:
 *   1) se inicia un LanzadorAPK real con APPDATA aislado y `--apk` instala un APK de prueba (lanza el emulador);
 *   2) luego `--launch <paquete>` abre la app;
 *   3) se enumeran todo el tiempo las ventanas visibles de primer nivel: la ventana principal del emulador (Android Emulator - …) y las de consola de qemu / netsimd
 *      no pueden aparecer; la ventana de la app sí debe aparecer (señal de que la incrustación funcionó y la imagen está en la ventana).
 *
 * Uso: node tools/check-launch-clean.js [apkPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Como las otras dos pruebas de ventanas, admite indicar desde fuera el runtime/carpeta de datos (el runtime del usuario suele estar en D:)
const ENGINE = path.resolve(process.env.LANZADORAPK_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.LANZADORAPK_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`No se encuentra el APK de prueba: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'lanzadorapk');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // ---- 1) Instalación ----
  console.log('— Instalando el APK (la primera vez arranca el emulador en frío, unos 40~90 s)…');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* Aún no se ha escrito */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `Instalación terminada: ${pkg || '(tiempo agotado)'}`);
  // Hay que esperar a que la primera instancia **salga de verdad** antes de lanzar la segunda: si el bloqueo de instancia única sigue, la segunda sale al instante,
  // y el síntoma es «la ventana nunca aparece», no un fallo de arranque (pasó en pruebas y costó mucho encontrarlo).
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\nResultado: fallido (no se instaló la app; se omite el resto)');
    process.exit(1);
  }

  // ---- 2) Abrir la app ----
  console.log('— Abriendo la app…');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // Arranque en frío 23 s + inicio de la app ~17 s; se dejan 120 s de margen; antes, con 60 s, daba falsos errores en equipos lentos
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)} s] ventanas anómalas visibles:`, JSON.stringify(hit));
    }
    // Ventana de la app = una ventana normal con título que no es del emulador ni de consola
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/LanzadorAPK|WorkBuddy|Microsoft|Program Manager|设置|Configuración|Settings|Edge|输入体验|Experiencia de entrada/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)} s] apareció la ventana de la app`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `Las ventanas del emulador/consola nunca fueron visibles (total ${leaked} veces)`);
  check(sawAppWin, `Apareció la ventana de la app (la imagen quedó incrustada en la ventana, no en una ventana aparte del emulador)`);
  console.log('  Títulos de ventanas visibles:', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('--- final de app.log ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('(no hay app.log)'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  El entorno aislado se conserva en: ${sandbox}`);
  }
  console.log('');
  console.log(`Resultado: ${pass ? 'correctas' : 'fallidas'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
