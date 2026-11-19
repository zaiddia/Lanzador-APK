'use strict';
/**
 * Parte de cálculo puro del ajuste de pantalla (probable, sin depender de Electron / adb).
 *  - pantalla completa: la resolución de Android se ajusta al área de trabajo del monitor y el contenido la llena;
 *  - ventana: mantiene el preajuste vertical; al arrastrar la ventana Qt escala solo, y el tamaño se guarda en los metadatos de la app.
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

function defaultBounds(area) {
  const h = Math.round((area.h || 1080) * 0.84);
  const w = Math.round(h * 9 / 16);
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round((area.y || 0) + ((area.h || 1080) - h) / 2),
    w, h,
  };
}

/**
 * Pantalla completa = llenar la altura de la pantalla y centrar horizontalmente.
 * La proporción de la ventana del emulador queda fijada por el LCD al arrancar (9:16); un SW_MAXIMIZE directo solo da
 * una ventana pegada a la izquierda con el mismo ancho; calculando la altura para llenar y centrando, visualmente
 * «la app ocupa la pantalla» y la imagen no se deforma.
 */
function fullscreenBounds(portrait, area) {
  const p = portraitSize(portrait);
  const ratio = p.w / p.h;
  const h = Math.max(320, Math.round(area.h || 1080));
  const w = Math.max(240, Math.round(h * ratio));
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round(area.y || 0),
    w, h,
  };
}

/**
 * Resolución del lado de Android: ambos modos mantienen el preajuste vertical.
 * Motivo: la proporción de la ventana del emulador queda fijada al arrancar por el tamaño del LCD (probado: tras cambiar a 1920x1080
 * la ventana solo acepta 9:16 y la imagen queda con bordes negros o deformada). Por eso «pantalla completa» = maximizar la ventana
 * para llenar la pantalla, «ventana» = vertical que se puede estirar libremente; ambos comparten la misma resolución de Android,
 * al cambiar no hace falta reiniciar el runtime y la app no se vuelve a diseñar.
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor };
