'use strict';
/**
 * Barra de controles flotante para el modo de ventana independiente (el modo por defecto).
 *
 * Problema: en ese modo la imagen de Android está en la ventana nativa del emulador, que es una ventana Qt sin marco
 * (su barra lateral propia se oculta porque trae botones peligrosos como «apagar» y «cerrar el emulador»).
 * El usuario se quedaba sin botones para volver, ir al inicio, ver las apps abiertas o cerrar la app.
 *
 * Solución: una barra vertical pequeña, pegada al costado de la ventana del emulador, con:
 * Atrás · Inicio · Apps abiertas | Captura | Girar · Pantalla completa | Minimizar · Cerrar la app.
 *  - No toma el foco (focusable:false): pulsar un botón no quita el teclado a la app Android.
 *  - Sigue a la ventana del emulador (el agente informa su posición cada ~200 ms) y solo se ve cuando
 *    el emulador está a la vista (con el foco, o sin otra ventana encima); si otro programa lo tapa, la barra se oculta.
 *  - Si no hay sitio a la derecha (pantalla completa, ventana pegada al borde), va a la izquierda o, si tampoco, encima
 *    del borde derecho de la imagen.
 * Los botones usan los mismos canales IPC que la barra de título del modo incrustado (shell:*), así que el comportamiento es idéntico.
 */

const BAR_W = 46;
const BTN = 38;
const GAP = 6;

/** Alto de la barra según los botones (8) y separadores (3, de 9 px cada uno) */
function barHeight() {
  return 8 + 8 * BTN + 3 * 9 + 8 + 2;
}

/**
 * Dónde poner la barra (todo en píxeles lógicos DIP).
 * @param {{x,y,width,height}} rect ventana del emulador
 * @param {{x,y,width,height}} work área de trabajo de la pantalla donde está
 * @returns {{x,y,width,height,side:'right'|'left'|'inside'}}
 */
function placeBar(rect, work, w = BAR_W, h = barHeight()) {
  const top = Math.max(work.y + 4, Math.min(rect.y + 32, work.y + work.height - h - 4));
  const right = rect.x + rect.width + GAP;
  if (right + w <= work.x + work.width) return { x: right, y: top, width: w, height: h, side: 'right' };
  const left = rect.x - GAP - w;
  if (left >= work.x) return { x: left, y: top, width: w, height: h, side: 'left' };
  return { x: Math.max(work.x, rect.x + rect.width - w - 10), y: top, width: w, height: h, side: 'inside' };
}

class ControlBar {
  /**
   * @param {object} o
   * @param {object} o.agent  WinAgent (track / minimize)
   * @param {() => boolean} [o.enabled]  interruptor de Configuración
   * @param {string} o.preload  ruta del preload
   * @param {string} o.page     ruta de controlbar.html
   * @param {object} [o.electron] sustituto del módulo electron (pruebas)
   * @param {string} [o.platform]
   */
  constructor({ agent, enabled, preload, page, electron = null, platform = process.platform, log = null }) {
    // Registro (app.log) de los cambios de estado: si la barra no aparece en un equipo, el registro dice por qué
    this.log = typeof log === 'function' ? log : () => {};
    this._state = '';
    this._electron = electron;
    this.platform = platform;
    this.agent = agent;
    this.enabled = typeof enabled === 'function' ? enabled : () => true;
    this.preload = preload;
    this.page = page;
    this.win = null;
    this._timer = null;
    this._busy = false;
    this._last = '';
    this._misses = 0;
  }

  get active() { return !!(this.win && !this.win.isDestroyed()); }

  attach(label) {
    if (this.platform !== 'win32' || !this.agent || !this.enabled()) return false;
    const { BrowserWindow } = this._el();
    if (!this.active) {
      this.win = new BrowserWindow({
        width: BAR_W,
        height: barHeight(),
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        alwaysOnTop: true,
        hasShadow: false,
        // Sin transparencia: con la aceleración por hardware desactivada (así arranca la app) algunas máquinas no dibujan
        // ventanas transparentes y la barra quedaba invisible. El fondo es el mismo color de la barra.
        backgroundColor: '#16181c',
        title: 'Controles de Lanzador APK',
        webPreferences: {
          preload: this.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
      this.win.setAlwaysOnTop(true, 'floating');
      this.win.loadFile(this.page);
      this.win.on('closed', () => { this.win = null; });
    }
    this.label = label || '';
    this._state = '';
    this.log(`controlbar: attach (${this.label})`);
    this._last = '';
    this._misses = 0;
    this._schedule(120);
    return true;
  }

  detach() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) { try { w.destroy(); } catch (_) { /* ignore */ } }
  }

  _el() { return this._electron || require('electron'); }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      return Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
    } catch (_) {
      return 0;
    }
  }

  _schedule(ms) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._tick().catch(() => {}); }, ms);
  }

  async _tick() {
    this._timer = null;
    if (!this.active) return;
    if (!this.enabled()) { this._hide('desactivada'); this._schedule(1000); return; }
    if (this._busy) { this._schedule(200); return; }
    this._busy = true;
    let t = null;
    let err = '';
    try { t = await this.agent.track(this._hwnd()); } catch (e) { t = null; err = e.message; } finally { this._busy = false; }
    if (!this.active) return;
    const usable = t && t.ok && t.emu && t.visible && !t.iconic && t.w > 120 && t.h > 120;
    // Se muestra si el emulador tiene el foco, o si al menos está a la vista sin otra ventana encima
    // (al abrir desde un acceso directo Windows no deja que el emulador tome el foco hasta que el usuario hace clic).
    const inView = usable && (t.fg || t.covered === false);
    if (!inView) {
      let why = 'otra ventana encima del emulador';
      if (!t || !t.ok) why = `sin respuesta del agente${err ? ` (${err})` : (t && t.error ? ` (${t.error})` : '')}`;
      else if (!t.emu) why = 'no se encuentra la ventana del emulador';
      else if (!t.visible) why = 'ventana del emulador oculta';
      else if (t.iconic) why = 'ventana minimizada';
      else if (!(t.w > 120 && t.h > 120)) why = `ventana demasiado pequeña (${t.w}x${t.h})`;
      this._hide(why);
      // Sin ventana del emulador durante mucho rato (se reinicia el runtime, cambio de orientación): se sigue mirando, pero más despacio
      this._misses = usable ? 0 : this._misses + 1;
      this._schedule(this._misses > 20 ? 900 : 350);
      return;
    }
    this._misses = 0;
    try {
      const { screen } = this._el();
      // El agente da píxeles físicos; la barra (Electron) usa píxeles lógicos: con escalado 125/150 % hay que convertir
      const phys = { x: t.x, y: t.y, width: t.w, height: t.h };
      const dip = typeof screen.screenToDipRect === 'function' ? screen.screenToDipRect(null, phys) : phys;
      const work = screen.getDisplayMatching(dip).workArea;
      const p = placeBar(dip, work);
      // setBounds solo acepta enteros (con escalado 125/150 % la conversión deja decimales)
      const b = { x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.width), height: Math.round(p.height) };
      const key = `${b.x},${b.y},${b.width},${b.height}`;
      if (key !== this._last) {
        this.win.setBounds(b);
        this._last = key;
        try { this.win.webContents.send('controlbar:side', p.side); } catch (_) { /* ignore */ }
      }
      if (!this.win.isVisible()) this.win.showInactive();
      this._setState(`visible (${p.side}, ${b.x},${b.y})`);
    } catch (e) { this._setState(`error al colocar: ${e.message}`); }
    this._schedule(200);
  }

  _hide(why = '') {
    try { if (this.active && this.win.isVisible()) this.win.hide(); } catch (_) { /* ignore */ }
    this._setState(`oculta: ${why}`);
  }

  /** Solo registra cuando cambia el estado (no en cada ronda de 200 ms) */
  _setState(st) {
    if (st === this._state) return;
    this._state = st;
    this.log(`controlbar: ${st}`);
  }
}

module.exports = { ControlBar, placeBar, barHeight, BAR_W };
