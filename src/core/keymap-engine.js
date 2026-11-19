'use strict';
/**
 * Motor de asignación de teclas en ejecución
 *
 * Con la ventana de la app en primer plano, intercepta eventos de teclado → busca la tabla de asignación de la app actual → los convierte en comandos adb input.
 * Funciona junto a pointer.js (gancho de ratón): el ratón va por Qt nativo + gancho de clic derecho/rueda,
 * el teclado va por aquí. No interfieren entre sí.
 *
 * Restricciones de diseño:
 *  - módulo Node puro, sin depender de BrowserWindow de Electron (fácil de probar);
 *  - los comandos adb se envían con el callback inyectado `execInput(cmd)`, desacoplado de AdbClient;
 *  - cada comando tiene un intervalo mínimo (por defecto 50 ms), para que pulsaciones rápidas no colapsen la adb shell;
 *  - las tablas de asignación se guardan por nombre de paquete y cambian solas al cambiar de app.
 */

const { lookup, toCommand } = require('./keymap');

class KeymapEngine {
  /**
   * @param {object} opts
   * @param {Function} opts.execInput  (cmd) => Promise — envía el comando adb shell input
   * @param {Function} opts.getSize    () => {width, height} — tamaño actual del LCD
   * @param {number}   [opts.minInterval=50]  intervalo mínimo entre dos comandos (ms)
   */
  constructor({ execInput, getSize, minInterval = 50 } = {}) {
    this._exec = execInput || (() => Promise.resolve());
    this._getSize = getSize || (() => ({ width: 720, height: 1280 }));
    this._minInterval = minInterval;
    this._lastExec = 0;
    this._enabled = false;
    // pkg → mappings[]
    this._maps = new Map();
  }

  /** Fija la tabla de asignación de una app */
  setMap(pkg, mappings) {
    if (!pkg) return;
    if (!mappings || !mappings.length) { this._maps.delete(pkg); return; }
    this._maps.set(pkg, mappings);
  }

  /** Obtiene la tabla de asignación de una app */
  getMap(pkg) { return this._maps.get(pkg) || []; }

  /** Activar/desactivar */
  enable(on) { this._enabled = !!on; }
  get enabled() { return this._enabled; }

  /**
   * Procesa un evento de teclado.
   * @param {string} key Electron KeyboardEvent.key
   * @param {string} pkg nombre de paquete de la app en primer plano
   * @returns {Promise<boolean>} si se consumió la tecla (true = asignada y enviada)
   */
  async handleKey(key, pkg) {
    if (!this._enabled || !pkg) return false;
    const mappings = this._maps.get(pkg);
    if (!mappings || !mappings.length) return false;
    const hit = lookup(mappings, key);
    if (!hit) return false;
    const { width, height } = this._getSize();
    const cmd = toCommand(hit, width, height);
    if (!cmd) return false;
    // Límite de frecuencia: evita que pulsaciones rápidas colapsen la adb shell
    const now = Date.now();
    const wait = Math.max(0, this._minInterval - (now - this._lastExec));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastExec = Date.now();
    try { await this._exec(cmd); } catch (_) { /* Un fallo de la inyección de entrada no afecta el juego */ }
    return true;
  }
}

module.exports = { KeymapEngine };
