'use strict';
/**
 * Asignación de botones del ratón (cálculo puro, sin depender de Electron / adb, fácil de probar)
 *
 * En la ventana de la app va incrustada la subventana Qt de Android Emulator, cuyo comportamiento nativo es:
 *   clic izquierdo = toque con el dedo (justo «confirmar», no hace falta intervenir)
 *   clic derecho = también un toque (provoca toques accidentales; hay que interceptarlo y convertirlo en «atrás»)
 *   rueda = deslizar con un dedo, pero Qt envía un evento táctil por cada paso y la imagen tiembla
 *
 * Por eso LanzadorAPK solo instala, con la «ventana de la app en primer plano», un gancho de bajo nivel en un hilo propio
 * que intercepta el clic derecho y la rueda; la rueda se agrupa por ventana de tiempo y se traduce en un `input swipe`,
 * suave y sin lanzar un proceso adb por cada giro.
 */

const WHEEL_NOTCH = 120;

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clampInt(v, lo, hi) { return Math.round(clamp(v, lo, hi)); }

/**
 * Lee la configuración y obtiene los interruptores que necesita el gancho.
 * Si la configuración vieja no tiene estas claves, se migra como «clic derecho = atrás + rueda suave, botones laterales apagados».
 */
function pointerOptions(settings = {}) {
  const e = (settings && settings.engine) || {};
  const rightBack = e.mouseRightBack !== false;
  const wheel = e.mouseWheelMode === 'native' || e.mouseWheelMode === 'off'
    ? e.mouseWheelMode : 'smooth';
  const side = !!e.mouseSideButtons;
  return { rightBack, wheel, side, enabled: rightBack || wheel === 'smooth' || side };
}

/** Reduce configuraciones de cualquier origen a la combinación 0/1 que el agente usa directamente */
function hookOptions(raw = {}) {
  let v = raw;
  // Compatibilidad con la forma booleana antigua: true = solo activa la asignación de botones laterales
  if (typeof v === 'boolean') v = { enabled: v, rightBack: false, wheel: 'off', side: v };
  if (typeof v === 'function') v = v();
  if (!v || typeof v !== 'object') v = {};
  const rightBack = !!v.rightBack;
  const wheel = v.wheel === 'smooth' || v.wheel === true;
  const side = !!v.side;
  const enabled = 'enabled' in v ? !!v.enabled : (rightBack || wheel || side);
  return {
    enabled,
    rightBack: enabled && rightBack,
    wheel: enabled && wheel,
    side: enabled && side,
  };
}

/** Solo se permiten en adb shell los comandos input que armamos internamente, evitando inyección de comandos */
const INPUT_RE = /^input (?:keyevent \d{1,3}|swipe -?\d+ -?\d+ -?\d+ -?\d+ \d{1,4}|tap -?\d+ -?\d+)$/;
function isInputCommand(cmd) { return INPUT_RE.test(String(cmd || '')); }

/**
 * Traduce un lote de desplazamientos de rueda en un solo gesto de deslizar.
 * @param {object} o { dx, dy, nx, ny, width, height }: nx/ny es la posición normalizada del cursor dentro del LCD
 * @returns {{x1:number,y1:number,x2:number,y2:number,duration:number}|null}
 */
function wheelToSwipe({ dx = 0, dy = 0, nx = 0.5, ny = 0.5, width = 900, height = 1600 } = {}) {
  const w = clampInt(width, 240, 4096);
  const h = clampInt(height, 320, 4096);
  const vertical = Math.abs(Number(dy) || 0) >= Math.abs(Number(dx) || 0);
  const delta = vertical ? (Number(dy) || 0) : (Number(dx) || 0);
  if (!delta) return null;

  // Un paso de rueda = deslizar ~30 % del ancho; giros rápidos seguidos se unen en un deslizamiento más largo (máximo 78 % del ancho)
  const steps = clamp(Math.abs(delta) / WHEEL_NOTCH, 0.6, 6);
  const axis = vertical ? h : w;
  const span = clamp(Math.round(axis * 0.30 * steps), 80, Math.round(axis * 0.78));
  const half = Math.round(span / 2);
  const cx = clampInt(clamp(nx, 0, 1) * w, 8, w - 8);
  const cy = clampInt(clamp(ny, 0, 1) * h, 8, h - 8);

  let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
  if (vertical) {
    // dy > 0 (rueda hacia arriba/alejándose) → el dedo desliza hacia abajo y el contenido sube hacia el principio
    const dir = delta > 0 ? 1 : -1;
    y1 = clampInt(cy - half * dir, 1, h - 1);
    y2 = clampInt(cy + half * dir, 1, h - 1);
  } else {
    // dx > 0 (rueda horizontal a la derecha) → el dedo desliza hacia la izquierda
    const dir = delta > 0 ? -1 : 1;
    x1 = clampInt(cx - half * dir, 1, w - 1);
    x2 = clampInt(cx + half * dir, 1, w - 1);
  }
  const duration = clampInt(100 + 22 * steps, 100, 240);
  return { x1, y1, x2, y2, duration };
}

function swipeToCommand(swipe) {
  if (!swipe) return '';
  return `input swipe ${swipe.x1} ${swipe.y1} ${swipe.x2} ${swipe.y2} ${swipe.duration}`;
}

/**
 * Agrupador de rueda: todos los giros dentro de una ventana de tiempo producen un solo comando de deslizar.
 * La inyección es asíncrona (input swipe en adb shell tarda lo que dura el gesto); mientras tanto se sigue acumulando
 * y al terminar se envía otro, para que los comandos no se encolen en la shell y el desplazamiento no se vuelva cada vez más lento.
 */
class WheelRouter {
  constructor({ inject, getSize, flushMs = 80 } = {}) {
    this.inject = inject || (() => Promise.resolve());
    this.getSize = getSize || (() => ({ width: 900, height: 1600 }));
    this.flushMs = flushMs;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    this._timer = null;
    this._busy = false;
    this._closed = false;
  }

  push(ev = {}) {
    if (this._closed) return;
    const dx = Number(ev.dx) || 0;
    const dy = Number(ev.dy) || 0;
    if (!dx && !dy) return;
    this._acc.dx += dx;
    this._acc.dy += dy;
    this._acc.nx = clamp(ev.nx, 0, 1);
    this._acc.ny = clamp(ev.ny, 0, 1);
    this._schedule();
  }

  _schedule() {
    if (this._closed || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, this.flushMs);
    if (this._timer.unref) this._timer.unref();
  }

  _take() {
    const b = this._acc;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    return (b.dx || b.dy) ? b : null;
  }

  async flush() { return this._flush(); }

  async _flush() {
    if (this._closed || this._busy) return;
    const batch = this._take();
    if (!batch) return;
    this._busy = true;
    try {
      const size = await this.getSize();
      const cmd = swipeToCommand(wheelToSwipe({ ...batch, width: size.width, height: size.height }));
      if (cmd && isInputCommand(cmd)) await this.inject(cmd);
    } catch (_) { /* Un fallo de la inyección de entrada no puede afectar el gancho del ratón */ }
    finally {
      this._busy = false;
      if (!this._closed && (this._acc.dx || this._acc.dy)) this._schedule();
    }
  }

  dispose() {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
  }
}

module.exports = {
  WHEEL_NOTCH, clamp, pointerOptions, hookOptions,
  isInputCommand, wheelToSwipe, swipeToCommand, WheelRouter,
};
