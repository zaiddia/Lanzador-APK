'use strict';
/**
 * Viste la ventana Qt de Android Emulator como «una app, una ventana nativa».
 *
 * Por qué no se proyecta: sin ventana SurfaceFlinger no emite VSYNC (probado: screenrecord da 2 fotogramas en 3 s),
 * y la proyección por software va a tirones y consume CPU. El emulador con ventana ya tiene 60 fps nativos + ratón y teclado nativos;
 * aquí solo se hacen unas pocas operaciones Win32 (cambiar título / icono / tamaño / pantalla completa), con costo casi nulo.
 *
 * PowerShell viene con Windows; el script es ASCII puro y los títulos con caracteres no ASCII llegan en JSON UTF-8,
 * para evitar caracteres corruptos cuando Windows PowerShell 5.1 lee .ps1 como ANSI.
 * Cualquier fallo degrada en silencio: la ventana sigue funcionando, solo que sin cambio de nombre/pantalla completa.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'windowctl.ps1');
const TIMEOUT = 8000;

function parseOut(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** @param {object} params { pid, action, title, icon, bounds } */
function call(params) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(SCRIPT) || !params || params.pid === undefined) {
      resolve(null);
      return;
    }
    const json = path.join(os.tmpdir(),
      `lanzadorapk-wctl-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
      fs.writeFileSync(json, JSON.stringify(params), 'utf8');
    } catch (_) { resolve(null); return; }

    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, json,
    ], { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 64 }, (err, stdout) => {
      try { fs.unlinkSync(json); } catch (_) { /* ignore */ }
      if (err) { resolve(null); return; }
      const r = parseOut(stdout);
      resolve(r.OK === '1' ? r : null);
    });
  });
}

/** Lee la posición actual de la ventana, para «recordar el tamaño de ventana de cada app» */
async function getBounds(pid) {
  const r = await call({ pid, action: 'get' });
  if (!r || !Number(r.W) || !Number(r.H)) return null;
  return {
    x: Number(r.X) || 0, y: Number(r.Y) || 0,
    w: Number(r.W), h: Number(r.H),
    maximized: r.MAX === '1',
  };
}

/**
 * Hace que la ventana del runtime se presente como la app actual.
 * @param {object} o { pid, label, icon, mode:'window'|'fullscreen', bounds, screen }
 */
async function present(o) {
  const { pid, label, icon, mode, bounds, screen } = o || {};
  // pid=0 es una entrada válida: al reutilizar un emulador lanzado por otro proceso no hay identificador, y el script busca la ventana por nombre de proceso
  if (pid === undefined || pid === null) return null;
  return call({
    pid,
    action: mode === 'fullscreen' ? 'fullscreen' : 'window',
    title: label || '',
    icon: icon && fs.existsSync(icon) ? icon : '',
    bounds: bounds || null,
    screen: mode === 'fullscreen' ? (screen || null) : null,
  });
}

async function focus(pid) { return call({ pid, action: 'focus' }); }

/** Avisa al Explorador para que actualice iconos/accesos directos, así los nuevos iconos del escritorio aparecen sin pulsar F5 */
async function refreshShell() { return call({ pid: 0, action: 'refresh' }); }

module.exports = { call, getBounds, present, focus, refreshShell, SCRIPT };
