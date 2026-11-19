'use strict';
/**
 * Genera capturas para Microsoft Store (1920×1080, cumple el mínimo de 1366×768)
 *   node_modules/electron/dist/electron.exe build/store-shots.js
 *
 * Usa capturas reales de la interfaz que ya están en el repositorio (docs/images) y solo añade fondo y texto,
 * sin modificar la interfaz: la Store exige que las capturas reflejen la interfaz real.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'store-shots');
const W = 1920;
const H = 1080;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.disableHardwareAcceleration();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false,
    backgroundColor: '#0a0e13',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.setContentSize(W, H);
  await win.loadFile(path.join(__dirname, 'store-shots.html'));
  try { await win.webContents.executeJavaScript('document.fonts.ready.then(()=>true)'); } catch (_) {}
  await sleep(1200);

  const names = ['1-main', '2-window', '3-bundled'];
  for (let i = 0; i < names.length; i++) {
    const shot = String(i + 1);
    await win.webContents.executeJavaScript(
      `document.body.classList.remove('s2','s3');`
      + `if('${shot}'!=='1')document.body.classList.add('s${shot}');true;`
    );
    await sleep(700);
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
    const file = path.join(OUT, `${names[i]}.png`);
    fs.writeFileSync(file, buf);
    const s = nativeImage.createFromBuffer(buf).getSize();
    console.log(`  ${path.relative(ROOT, file).replace(/\\/g, '/')}  ${s.width}x${s.height}  ${(buf.length / 1024).toFixed(0)}KB`);
    if (s.width !== W || s.height !== H) console.log(`  [advertencia] se esperaba ${W}x${H}`);
  }
  console.log('Listo.');
  app.exit(0);
}).catch((e) => { console.error('Error:', e); app.exit(1); });
