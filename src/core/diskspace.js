'use strict';
/**
 * Utilidades de espacio en disco, sin dependencias de Electron (se pueden probar en Node puro).
 *
 *  - uncompressedSize(file): tamaño real descomprimido de un .xz / .gz, leyendo solo el final del archivo
 *    (índice de xz / campo ISIZE de gzip). Sirve para comprobar el espacio ANTES de descomprimir la imagen
 *    del sistema (unos 3,3 GB): si el disco se llenaba a mitad, el usuario veía un error técnico (ENOSPC)
 *    que parecía un fallo del runtime.
 *  - isDiskFullError(e) / diskFullError(...): un único mensaje claro para «no queda espacio».
 *  - listDrives() / pickRoomierDrive(): en Windows, buscar otro disco con más espacio libre.
 */
const fs = require('fs');

/** Lee un entero de longitud variable de xz (7 bits por byte, little-endian). Devuelve [valor, siguientePos] o null. */
function readVarint(buf, pos) {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 9; i += 1) {
    if (pos >= buf.length) return null;
    const b = buf[pos];
    pos += 1;
    value += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [value, pos];
    mul *= 128;
  }
  return null;
}

function readTail(fd, size, len) {
  const n = Math.min(size, len);
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const r = fs.readSync(fd, buf, got, n - got, size - n + got);
    if (r <= 0) break;
    got += r;
  }
  return buf.subarray(0, got);
}

/** Tamaño descomprimido de un .xz leyendo el pie y el índice del último stream; 0 si no se puede. */
function xzUncompressedSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 32) return 0;
    // Relleno de stream (stream padding): ceros al final, en múltiplos de 4
    let end = size;
    const tail = readTail(fd, size, 4096);
    let k = tail.length;
    while (k >= 4 && tail.readUInt32LE(k - 4) === 0) { k -= 4; end -= 4; }
    if (end < 24) return 0;
    const footer = Buffer.alloc(12);
    fs.readSync(fd, footer, 0, 12, end - 12);
    if (footer[10] !== 0x59 || footer[11] !== 0x5a) return 0; // 'YZ'
    const backward = (footer.readUInt32LE(4) + 1) * 4;
    if (backward <= 0 || backward > 64 * 1024 * 1024 || backward > end - 24) return 0;
    const index = Buffer.alloc(backward);
    fs.readSync(fd, index, 0, backward, end - 12 - backward);
    if (index[0] !== 0x00) return 0;
    let r = readVarint(index, 1);
    if (!r) return 0;
    const count = r[0];
    let pos = r[1];
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      r = readVarint(index, pos); if (!r) return 0; pos = r[1];          // unpadded size
      r = readVarint(index, pos); if (!r) return 0; pos = r[1];          // uncompressed size
      total += r[0];
    }
    return total;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

/** Tamaño descomprimido de un .gz (campo ISIZE, módulo 4 GiB); 0 si no se puede. */
function gzUncompressedSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 18) return 0;
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    if (head[0] !== 0x1f || head[1] !== 0x8b) return 0;
    const t = readTail(fd, size, 4);
    let isize = t.readUInt32LE(0);
    // ISIZE es módulo 2^32: si da menos que el comprimido, la imagen pasó de 4 GiB
    while (isize < size) isize += 0x100000000;
    return isize;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

/**
 * Tamaño descomprimido estimado. Si no se puede leer el índice se usa una estimación prudente
 * (la imagen del sistema se comprime unas 3–5 veces); devuelve { bytes, exact }.
 */
function uncompressedSize(file) {
  const exact = /\.xz$/i.test(file) ? xzUncompressedSize(file) : (/\.gz$/i.test(file) ? gzUncompressedSize(file) : 0);
  if (exact > 0) return { bytes: exact, exact: true };
  let s = 0;
  try { s = fs.statSync(file).size; } catch (_) { s = 0; }
  return { bytes: s * 4, exact: false };
}

const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT', 'DISK_FULL']);

function isDiskFullError(e) {
  if (!e) return false;
  if (DISK_FULL_CODES.has(e.code)) return true;
  return /ENOSPC|no space left|not enough space|espacio insuficiente|disk (is )?full|There is not enough space/i.test(String(e.message || e));
}

const gb = (mb) => (Math.max(0, Number(mb) || 0) / 1024).toFixed(1);

/** Error con un mensaje que dice cuánto hace falta, cuánto hay y qué hacer. */
function diskFullError({ dir, needMB, freeMB, what = 'esta operación' }) {
  const drive = driveOf(dir);
  const parts = [`No hay espacio suficiente en ${drive || 'el disco'} para ${what}.`];
  if (needMB && freeMB) parts.push(`Hacen falta unos ${gb(needMB)} GB y solo quedan ${gb(freeMB)} GB libres.`);
  else if (needMB) parts.push(`Hacen falta unos ${gb(needMB)} GB libres.`);
  parts.push('Libera espacio, o en Configuración → Integración con el sistema cambia la «Carpeta de datos del runtime» '
    + 'y la «Carpeta de datos de Android» a un disco con más espacio, y vuelve a intentarlo.');
  const err = new Error(parts.join(' '));
  err.code = 'DISK_FULL';
  err.dir = dir;
  err.needMB = needMB || 0;
  err.freeMB = freeMB || 0;
  return err;
}

/** «C:» a partir de una ruta de Windows; '' si no se reconoce. */
function driveOf(dir) {
  const m = /^([a-zA-Z]):/.exec(String(dir || ''));
  return m ? `${m[1].toUpperCase()}:` : '';
}

/** Espacio libre (MB) de una carpeta o raíz; 0 si no se puede leer. */
function freeMBOf(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Math.floor((Number(st.bavail) * Number(st.bsize)) / 1048576);
  } catch (_) {
    return 0;
  }
}

/** Discos de Windows con letra (D: a Z: y también C:), con su espacio libre. En otros sistemas devuelve []. */
function listDrives({ platform = process.platform, freeOf = freeMBOf } = {}) {
  if (platform !== 'win32') return [];
  const out = [];
  for (let c = 67; c <= 90; c += 1) { // C..Z
    const root = `${String.fromCharCode(c)}:\\`;
    const free = freeOf(root);
    if (free > 0) out.push({ drive: `${String.fromCharCode(c)}:`, root, freeMB: free });
  }
  return out;
}

/**
 * Elige otro disco con bastante más espacio que el actual.
 * Solo propone un disco si el actual no alcanza `needMB` (+ margen) y el otro sí, con holgura.
 * @returns {{drive, root, freeMB} | null}
 */
function pickRoomierDrive({ currentDir, needMB, drives, marginMB = 5120 }) {
  const cur = driveOf(currentDir);
  const list = Array.isArray(drives) ? drives : [];
  const curFree = (list.find((d) => d.drive === cur) || {}).freeMB || 0;
  if (curFree && curFree >= needMB + marginMB) return null;
  const best = list
    .filter((d) => d.drive !== cur && d.freeMB >= needMB + marginMB)
    .sort((a, b) => b.freeMB - a.freeMB)[0];
  if (!best) return null;
  if (curFree && best.freeMB < curFree * 1.5) return null;
  return best;
}

module.exports = {
  uncompressedSize,
  xzUncompressedSize,
  gzUncompressedSize,
  isDiskFullError,
  diskFullError,
  driveOf,
  freeMBOf,
  listDrives,
  pickRoomierDrive,
};
