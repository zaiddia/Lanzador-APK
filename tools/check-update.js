'use strict';
/**
 * Autocomprobación de la cadena de actualización (no hace falta publicar una versión nueva ni toca la instalación actual).
 *
 * 1) si se puede leer el último release de GitHub y elegir el recurso correcto para la forma actual;
 * 2) la lógica de comparación de versiones;
 * 3) que el script de «descomprimir + sobrescribir + reiniciar» de verdad funcione: se crea una carpeta de instalación falsa y el script la sobrescribe.
 *
 * Uso: node tools/check-update.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Updater, cmpVer } = require('../src/core/updater');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => console.log(`${c ? '✓' : '✗'} ${m}`);

(async () => {
  let pass = true;
  const check = (c, m) => { ok(c, m); if (!c) pass = false; };

  // ---- 1. Comparación de versiones ----
  check(cmpVer('v0.3.2', '0.3.1') === 1, 'v0.3.2 > 0.3.1');
  check(cmpVer('0.3.1', 'v0.3.1') === 0, 'El prefijo v no afecta la igualdad');
  check(cmpVer('v0.10.0', '0.9.9') === 1, '0.10.0 > 0.9.9 (comparación numérica, no de texto)');
  check(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 < 1.0.1');

  // ---- 2. GitHub release ----
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-upd-'));
  const install = path.join(sandbox, 'install');
  fs.mkdirSync(install, { recursive: true });

  const u = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'LanzadorAPK.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  let info = null;
  try {
    info = await u.check();
    check(!!info && !!info.version, `Última versión leída: ${info && info.tag}`);
    check(info.hasUpdate === true, 'Versión actual 0.0.0 → hay actualización');
    check(!!info.asset && /\.(zip|exe)$/i.test(info.asset.name), `La forma portátil eligió el recurso ${info.asset && info.asset.name}`);
  } catch (e) {
    check(false, `Falló la comprobación en GitHub: ${e.message}`);
  }

  // La forma instalada (con desinstalador) debe elegir Setup.exe
  fs.writeFileSync(path.join(install, 'Uninstall LanzadorAPK.exe'), 'stub');
  const u2 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'LanzadorAPK.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  check(u2.flavor === 'setup', 'Reconocida como versión instalada (existe Uninstall LanzadorAPK.exe)');

  // ---- 3. El script de sobrescritura de verdad funciona ----
  const payload = path.join(sandbox, 'payload');
  fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'LanzadorAPK.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload, 'resources', 'app', 'main.js'), 'new-main');
  fs.writeFileSync(path.join(install, 'LanzadorAPK.exe'), 'old-exe');

  // Se usa un proceso que sale de inmediato como el «proceso viejo al que se espera»
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], { stdio: 'ignore' });

  const script = u.apply(
    { mode: 'zip', payload, version: '9.9.9' },
    { waitPid: decoy.pid, spawn: false },
  );
  check(/Copy-Item/.test(script) && /Wait-Process/.test(script), 'El script incluye la espera del proceso y la sobrescritura');

  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // No se hace Start-Process de LanzadorAPK.exe (es un exe falso); solo se verifica la copia
  const body = script.replace(/if \(Test-Path[^\r\n]*relaunched' \}/, "'skipped relaunch'");
  const b64 = Buffer.from(body, 'utf16le').toString('base64');
  try {
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      stdio: 'ignore', timeout: 60000, windowsHide: true,
    });
  } catch (e) {
    check(false, `Falló la ejecución del script de sobrescritura: ${e.message}`);
  }
  await sleep(600);
  const newExe = fs.readFileSync(path.join(install, 'LanzadorAPK.exe'), 'utf8');
  const newMain = fs.readFileSync(path.join(install, 'resources', 'app', 'main.js'), 'utf8');
  check(newExe === 'new-exe', 'El LanzadorAPK.exe de la carpeta de instalación fue reemplazado');
  check(newMain === 'new-main', 'Los archivos de las subcarpetas también se reemplazaron');

  // ---- 4. apply() de verdad lanza un proceso que reemplaza (cadena asíncrona, sin red) ----
  const install2 = path.join(sandbox, 'install2');
  const payload2 = path.join(sandbox, 'payload2');
  fs.mkdirSync(install2, { recursive: true });
  fs.mkdirSync(payload2, { recursive: true });
  fs.writeFileSync(path.join(install2, 'LanzadorAPK.exe'), 'old-exe');
  fs.writeFileSync(path.join(install2, 'marker.txt'), 'old');
  fs.writeFileSync(path.join(payload2, 'LanzadorAPK.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload2, 'marker.txt'), 'new');

  const u3 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install2, 'LanzadorAPK.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  const decoy2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { stdio: 'ignore' });
  u3.apply({ mode: 'zip', payload: payload2, version: '9.9.8' }, { waitPid: decoy2.pid });
  let asyncOk = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      if (fs.readFileSync(path.join(install2, 'marker.txt'), 'utf8') === 'new') { asyncOk = true; break; }
    } catch (_) { /* Aún reemplazando */ }
  }
  check(asyncOk, 'apply() completó el reemplazo en un proceso en segundo plano (la cadena asíncrona funciona)');

  try { decoy.kill(); } catch (_) { /* ignore */ }
  try { decoy2.kill(); } catch (_) { /* ignore */ }
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log('');
  console.log(pass ? 'Resultado: correcto' : 'Resultado: hay fallos');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
