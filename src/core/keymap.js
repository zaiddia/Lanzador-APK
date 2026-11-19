'use strict';
/**
 * Asignación de teclas para juegos: capa de datos pura
 *
 * Asigna teclas del teclado a coordenadas de la pantalla táctil de Android. Cada entrada:
 *   { key: 'w', action: 'tap', x: 0.15, y: 0.85 }   // coordenadas relativas (0~1)
 *   { key: 'space', action: 'tap', x: 0.5, y: 0.9 }
 *   { key: 'j', action: 'swipe', x1: 0.7, y1: 0.5, x2: 0.3, y2: 0.5, duration: 100 }
 *
 * Las coordenadas son valores normalizados (0~1) respecto a la pantalla LCD; en ejecución se multiplican por el wm size real para obtener píxeles.
 *
 * Los perfiles predefinidos cubren los tipos de juego habituales:
 *   - fps: WASD mueve la zona del joystick + apuntar con el ratón (el ratón lo maneja Qt nativo; aquí solo el teclado)
 *   - rpg: WASD mover + J/K/L habilidades + Espacio confirmar
 *   - generic: flechas + Enter/Espacio
 */

const PRESETS = {
  fps: {
    label: 'FPS / disparos',
    desc: 'WASD controla el joystick virtual izquierdo, J disparar, K recargar, Espacio saltar',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.85, y: 0.75 },
      { key: 'k', action: 'tap', x: 0.92, y: 0.82 },
      { key: ' ', action: 'tap', x: 0.78, y: 0.82 },
    ],
  },
  rpg: {
    label: 'RPG / acción',
    desc: 'WASD mover, J atacar, K habilidad, L habilidad definitiva, Espacio confirmar/diálogo',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.82, y: 0.78 },
      { key: 'k', action: 'tap', x: 0.90, y: 0.78 },
      { key: 'l', action: 'tap', x: 0.86, y: 0.70 },
      { key: ' ', action: 'tap', x: 0.5, y: 0.92 },
    ],
  },
  generic: {
    label: 'General / casual',
    desc: 'Flechas para mover, Enter confirmar, Espacio cancelar/volver',
    mappings: [
      { key: 'ArrowUp', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'ArrowLeft', action: 'tap', x: 0.08, y: 0.82 },
      { key: 'ArrowDown', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'ArrowRight', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'Enter', action: 'tap', x: 0.5, y: 0.92 },
      { key: ' ', action: 'keyevent', code: 4 },  // BACK
    ],
  },
};

/**
 * Normaliza el nombre de tecla de Electron al formato de la tabla de asignación.
 * Valores de KeyboardEvent.key de Electron como 'w', 'W', 'ArrowUp', ' ', 'Enter', etc.
 */
function normalizeKey(key) {
  if (!key) return '';
  // Las letras sueltas siempre en minúscula
  if (key.length === 1 && /[A-Za-z]/.test(key)) return key.toLowerCase();
  return key;
}

/**
 * Busca la acción de una tecla en la tabla de asignación actual.
 * @param {Array} mappings arreglo de entradas de asignación
 * @param {string} key Electron KeyboardEvent.key
 * @returns {object|null} entrada coincidente
 */
function lookup(mappings, key) {
  const nk = normalizeKey(key);
  if (!nk || !Array.isArray(mappings)) return null;
  return mappings.find((m) => normalizeKey(m.key) === nk) || null;
}

/**
 * Convierte una entrada de asignación + el tamaño del LCD en un comando adb shell.
 * @param {object} mapping entrada de asignación
 * @param {number} width ancho del LCD (píxeles)
 * @param {number} height alto del LCD (píxeles)
 * @returns {string} comando adb shell (p. ej. 'input tap 192 612')
 */
function toCommand(mapping, width, height) {
  if (!mapping) return '';
  if (mapping.action === 'tap') {
    const x = Math.round(mapping.x * width);
    const y = Math.round(mapping.y * height);
    return `input tap ${x} ${y}`;
  }
  if (mapping.action === 'swipe') {
    const x1 = Math.round(mapping.x1 * width);
    const y1 = Math.round(mapping.y1 * height);
    const x2 = Math.round(mapping.x2 * width);
    const y2 = Math.round(mapping.y2 * height);
    const dur = mapping.duration || 100;
    return `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`;
  }
  if (mapping.action === 'keyevent') {
    return `input keyevent ${mapping.code}`;
  }
  return '';
}

module.exports = { PRESETS, normalizeKey, lookup, toCommand };
