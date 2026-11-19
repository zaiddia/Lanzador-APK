'use strict';
/**
 * Conversión geométrica pura (sin dependencias; se puede probar con require en CI/Node sin Electron).
 *
 * Las coordenadas de screen / BrowserWindow de Electron siempre son DIP (píxeles independientes del dispositivo); el agente de ventanas
 * agent.ps1 declara arriba conciencia de DPI per-monitor v2, y el SetWindowPos de Win32 que llama recibe
 * píxeles físicos. Mezclarlos con escalado de 125 % / 150 % produce «la ventana se ve a medias / corrida a una esquina /
 * clics desplazados» (issue #99). El _rect() del modo incrustado ya multiplicaba por scaleFactor; aquí se extrae esa
 * misma conversión para reutilizarla en el modo de ventana independiente y probarla por separado.
 */

/**
 * Convierte un rectángulo DIP a píxeles físicos.
 * @param {{x:number,y:number,w:number,h:number}} rect rectángulo en píxeles lógicos DIP
 * @param {number} [scaleFactor] factor de escala; con 1 / sin indicar se devuelve tal cual (el mismo objeto, sin costo)
 * @returns {{x:number,y:number,w:number,h:number}} rectángulo en píxeles físicos
 */
function physicalRect(rect, scaleFactor) {
  const k = Number(scaleFactor) || 1;
  if (!rect || k === 1) return rect;
  return {
    x: Math.round(rect.x * k),
    y: Math.round(rect.y * k),
    w: Math.round(rect.w * k),
    h: Math.round(rect.h * k),
  };
}

module.exports = { physicalRect };
