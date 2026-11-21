'use strict';
/**
 * Archivos dispersos (sparse) en Windows para la partición de datos de Android.
 *
 * Por qué: userdata-qemu.img es una imagen de disco de 4–16 GB. qemu-img la agranda en NTFS y Windows reserva
 * todo el tamaño aunque casi todo sean ceros: en el primer inicio «desaparecían» 6–16 GB del disco.
 *  - flag(): marca el archivo como disperso ANTES de agrandarlo (así agrandarlo no ocupa disco).
 *  - compact(): marca disperso y devuelve al disco cada bloque de 1 MB que está todo en ceros. Solo toca bytes que ya
 *    son cero (FSCTL_SET_ZERO_DATA), así que el contenido de la imagen no cambia; abre el archivo en exclusiva,
 *    de modo que si el emulador lo está usando no hace nada.
 * Fuera de Windows no hace nada (ext4/APFS ya manejan los huecos solos).
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'sparse.ps1');

function parseLine(out) {
  const line = String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch (_) { return { ok: false, error: line.slice(0, 200) || 'sin respuesta' }; }
}

function psArgs(file, mode, start, maxSeconds) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-Path', file, '-Mode', mode, '-Start', String(Math.max(0, Math.floor(start || 0))), '-MaxSeconds', String(maxSeconds)];
}

/** Marca el archivo como disperso (síncrono, ~1–2 s). Devuelve {ok} y nunca lanza. */
function flag(file, { platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, skipped: true };
  try {
    const r = spawnSync('powershell.exe', psArgs(file, 'flag', 0, 10), { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    return parseLine(r.stdout);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Libera los bloques en cero (asíncrono, con tope de tiempo; se puede continuar desde `start`). Nunca lanza. */
function compact(file, { start = 0, maxSeconds = 60, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve({ ok: false, skipped: true });
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell.exe', psArgs(file, 'punch', start, maxSeconds), { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    const kill = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, (maxSeconds + 30) * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, error: e.message }); });
    child.on('close', () => { clearTimeout(kill); resolve(parseLine(out)); });
  });
}

/**
 * Decide si hay que (re)compactar la imagen, según la marca guardada junto a ella.
 *  - nunca compactada / compactación a medias → sí (continúa desde donde quedó)
 *  - compactada, pero Android escribió desde entonces (cambió la fecha) y pasó más de un día → sí, desde el principio
 */
function plan(file, marker, { now = Date.now() } = {}) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return { run: false }; }
  if (st.size < 512 * 1024 * 1024) return { run: false }; // imágenes pequeñas: no vale la pena
  const m = marker || {};
  if (m.size === st.size && !m.done && m.next > 0) return { run: true, start: m.next };
  if (m.size === st.size && m.done && Math.abs((m.mtimeMs || 0) - st.mtimeMs) < 2000) return { run: false };
  if (m.done && now - (m.at || 0) < 24 * 3600 * 1000) return { run: false };
  return { run: true, start: 0 };
}

module.exports = { flag, compact, plan, parseLine, SCRIPT };
