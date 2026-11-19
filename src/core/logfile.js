'use strict';
/**
 * Escritura ligera de registros + rotación.
 *
 * Antes app.log / emulator.log solo se añadían y crecían sin parar con el uso:
 * solo el registro del kernel de cada arranque del emulador son decenas de KB; con diez o más arranques al día y la salida
 * verbose de qemu, en unos meses son cientos de MB: así se iba comiendo el disco sin que nadie lo notara.
 * Aquí se rota por tamaño, conservando solo una copia .1.log; el límite lo controla «Límite de registros» en la configuración.
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // Si el nombre no termina en .log, bak sería igual al original: borrar y luego renombrar eliminaría el registro.
    // Este caso límite se omite explícitamente; mejor un registro algo más grande que perderlo.
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} file registro de destino
 * @param {string} line contenido de una línea (se agrega el salto de línea)
 * @param {number} [limitKB] tamaño a partir del cual se rota
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // Se comprueba una vez al iniciar el proceso y luego cada 200 líneas (statSync es barato, pero no hace falta en cada línea)
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Limpieza al iniciar: rota primero los registros demasiado grandes (sin mirar el contador) */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
