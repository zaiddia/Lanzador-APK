'use strict';
/**
 * Arma el runtime integrado de la «versión completa»:
 *   node build/fetch-runtime.js <carpeta de salida>
 * Genera <carpeta de salida>/runtime/:
 *   emulator/ + platform-tools/ + aehd/ + system-images/android-34/google_apis_playstore/x86_64/
 * Todo se descarga y verifica por los canales oficiales del Provisioner, igual que la versión en línea.
 */
const path = require('path');
const fs = require('fs');

const outRoot = path.resolve(process.argv[2] || '');
if (!outRoot) {
  console.error('usage: node build/fetch-runtime.js <output-runtime-dir>');
  process.exit(1);
}
fs.mkdirSync(outRoot, { recursive: true });

// El Provisioner toma la carpeta raíz de settings.runtime.dir:
// APPDATA apunta a una carpeta aparte para no ensuciar la configuración real del usuario
process.env.APPDATA = path.join(outRoot, '_appdata');
const store = require('../src/core/store');
store.saveSettings({ runtime: { dir: outRoot } });

const { Provisioner } = require('../src/core/provision');
const prov = new Provisioner(path.resolve(__dirname, '..'));

const log = (p) => console.log(`[${p.stage}] ${p.message} ${p.percent != null ? p.percent + '%' : ''}`);

(async () => {
  await prov.installAehd(log);
  await prov.installAdb(log);
  await prov.installEmulator(log);
  await prov.installPlayImage(log);

  const ok =
    fs.existsSync(path.join(outRoot, 'emulator', 'emulator.exe')) &&
    fs.existsSync(path.join(outRoot, 'platform-tools', 'adb.exe')) &&
    fs.existsSync(path.join(outRoot, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'));
  if (!ok) throw new Error('Falló la verificación tras ensamblar el runtime');

  // Reducción tipo contenedor: solo se conservan el QEMU x86_64 y los componentes necesarios para ejecutar sin ventana.
  // Los qemu-system-*.exe que no son x86_64 (unos 400 MB), QtWebEngine, netsim, etc. no sirven con -no-window.
  const layers = require('../src/core/layers');
  const pruned = layers.prune(outRoot, { apply: true, aggressive: true });
  const before = layers.analyze(outRoot).total + pruned.saved;
  console.log(`slim: ${(pruned.saved / 1048576).toFixed(0)} MB removed, `
    + `${(before / 1073741824).toFixed(2)} GB -> ${(pruned.after / 1073741824).toFixed(2)} GB`);

  fs.rmSync(path.join(outRoot, '_appdata'), { recursive: true, force: true });
  fs.rmSync(path.join(outRoot, '_tmp'), { recursive: true, force: true });
  console.log('runtime-ready:', outRoot);
})().catch((e) => {
  console.error('fetch-runtime failed:', e.message);
  process.exit(1);
});
