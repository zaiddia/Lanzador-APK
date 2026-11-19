'use strict';
/**
 * Decisión de orientación de la pantalla (función pura, sin depender de Electron / adb / red; el CI puede hacer require directamente).
 *
 * Por qué está aparte: antes esta decisión estaba repartida en tres lugares de main.js (wantLandscapeFor,
 * el botón de rotación de la barra de título y el menú de rotación de la bandeja), y cada uno calculaba «la siguiente orientación» por su cuenta, con bases distintas
 * (unos miraban display.landscape, otros appWin.state.landscape). El resultado era que
 * al pulsar rotar una vez, el valor guardado en apps.json quedaba al revés que la orientación a la que se cambiaba de verdad,
 * y la próxima vez wantLandscapeFor lo volvía a invertir: el síntoma era «la app no hay forma de ponerla en horizontal».
 * Ahora todos los puntos de entrada usan este módulo: una sola base y un solo resultado.
 */

const ORIENTATION_MODES = ['auto', 'landscape', 'portrait'];

/**
 * Si una app debe usar la pantalla horizontal o vertical.
 *
 * Prioridad (de mayor a menor):
 *   1. el modo forzado de la configuración (landscape / portrait)
 *   2. la sustitución manual de cada app (orientationOverride, la escriben el botón de rotación / el menú contextual)
 *   3. la orientación natural leída del manifiesto del APK (orientation)
 *   4. la orientación actual de la pantalla (si declara seguir la gravedad, no se reinicia para nada)
 */
function resolveLandscape({ mode = 'auto', orientation = null, orientationOverride = null, panelLandscape = false } = {}) {
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  if (orientationOverride === 'landscape') return true;
  if (orientationOverride === 'portrait') return false;
  if (orientation === 'landscape') return true;
  if (orientation === 'portrait') return false;
  return !!panelLandscape;
}

/** Orientación contraria, para el botón de rotación: horizontal → vertical, vertical → horizontal */
function flipLandscape(current) {
  return !current;
}

/** Texto de la sustitución: true → 'landscape', false → 'portrait' (el formato que se guarda en apps.json) */
function overrideValue(landscape) {
  return landscape ? 'landscape' : 'portrait';
}

/** Lee la orientación del texto de la sustitución; un valor inválido devuelve null (= sin sustitución) */
function parseOverride(value) {
  if (value === 'landscape') return true;
  if (value === 'portrait') return false;
  return null;
}

/**
 * Valor por defecto del interruptor de «rotación automática» de la imagen.
 * La máquina virtual no tiene un sensor de gravedad real; antes se fijaba accelerometer_rotation 0 y en los ajustes del sistema
 * la «rotación automática» siempre aparecía apagada. Ahora el interruptor viene encendido por defecto (la orientación de la pantalla la siguen decidiendo
 * wm user-rotation lock + set-ignore-orientation-request, sin que los sensores la tuerzan),
 * así las apps que leen Settings.System.ACCELEROMETER_ROTATION ven «activado».
 * Devuelve la cadena 0/1 que se escribe en el invitado.
 */
function autoRotateSetting(settings) {
  const d = (settings && settings.display) || {};
  return d.autoRotate === false ? '0' : '1';
}

module.exports = {
  ORIENTATION_MODES,
  resolveLandscape,
  flipLandscape,
  overrideValue,
  parseOverride,
  autoRotateSetting,
};
