'use strict';
/**
 * Comparación de versiones. Va en un módulo aparte para evitar que updater ↔ sources se requieran mutuamente en un ciclo.
 */

/** Normaliza v0.3.2 / 0.3.2-preview / 1.0.0+build en un arreglo comparable */
function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x))
    .filter((x) => x !== '');
}

/** Devuelve 1 si a>b, -1 si a<b, 0 si son iguales */
function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Si una etiqueta de release tiene la forma de versión que usa Lanzador APK: vX.Y.Z (con sufijo opcional -beta / +build).
 * Protege contra etiquetas mal escritas como «v0.71» (por v0.7.1): se leerían como versión 0.71, más alta que cualquier 0.7.x,
 * y la app avisaría de una actualización para siempre y dejaría de ofrecer las versiones siguientes.
 */
function isReleaseTag(v) {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(v || '').trim());
}

/** Si un nombre de archivo lleva exactamente esta versión (0.7.1 → «…-v0.7.1-…» o «…-0.7.1-…», no «0.7.10»). */
function nameHasVersion(name, version) {
  const v = String(version || '').replace(/^v/i, '');
  if (!v) return false;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9.])v?${esc}(?![0-9]|\\.[0-9])`, 'i').test(String(name || ''));
}

module.exports = { parseVer, cmpVer, isReleaseTag, nameHasVersion };
