'use strict';
/**
 * Agente de ventanas de Windows: se comunica con el proceso persistente de src/core/win/agent.ps1.
 *
 * Por qué no se lanza un PowerShell cada vez: al arrastrar la ventana el tamaño cambia muy seguido,
 * y lanzar un powershell.exe cuesta 150–300 ms; el arrastre iría a tirones.
 * Aquí se inicia una sola vez y luego se usa TCP por loopback local (un JSON por línea); cada viaje tarda <2 ms.
 *
 * Opcionalmente el agente se encarga del gancho de ratón WH_MOUSE_LL: clic derecho = atrás / rueda = deslizar / botones laterales = adelante/atrás.
 * Ese gancho es global e interviene en cada evento de ratón del sistema, por eso solo se instala con la «ventana de la app en primer plano»
 * y al menos una asignación activa, y se quita al perder el foco; el callback solo procesa los 7 mensajes que nos interesan.
 * Ver setHook(on, opts).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** Inicia el agente y espera a que conecte por TCP (idempotente) */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('El agente de ventanas no está disponible')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('El agente de ventanas se cerró');
        if (wasReady) this.emit('exit');
        fail(new Error('No se pudo iniciar el agente de ventanas'));
      });
      setTimeout(() => { if (!settled) fail(new Error('El agente de ventanas tardó demasiado en iniciar')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Se perdió la conexión con el agente de ventanas');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // Los eventos traen datos (dx/dy/nx/ny de la rueda); los oyentes antiguos ignoran los parámetros extra
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Envía un comando y espera la respuesta */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('El agente de ventanas no está conectado');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`El agente de ventanas superó el tiempo de espera: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- Métodos de conveniencia ----------------

  /**
   * Declara «qué carpetas tienen procesos que son nuestros».
   * Hay que llamarlo antes de bootHide / embed: el agente de ventanas solo puede tocar ventanas creadas por esos procesos.
   * Si no se indica (o se pasa vacío), el agente no toca ninguna ventana: mejor que se escape alguna ventana negra
   * que ocultar o incrustar ventanas de otras apps Qt (WeChat 4.x es Qt6, MuMu, reproductores de música).
   * @param {string[]} dirs carpeta raíz del runtime / carpeta engine incluida en el paquete
   * @param {number} [appPid] pid del proceso principal: el agente solo puede incrustar ventanas dentro de las ventanas de este proceso,
   *        y con eso decide si «la ventana actual del evento de ratón es nuestra» (evita que se reutilice un identificador reciclado)
   */
  async scope(dirs, appPid) {
    /**
     * Las carpetas deben resolverse a su **ruta real** antes de pasarlas al agente.
     *
     * El agente decide a quién pertenece una ventana por el «prefijo de la ruta del ejecutable del proceso», y en Windows
     * `Process.MainModule.FileName` devuelve la ruta real, con junctions / enlaces simbólicos resueltos.
     * Si LanzadorAPK se inicia desde una junction de carpeta (por ejemplo dist\LanzadorAPK-win64-portable
     * enlazada a build\_packout\...), al agente le llega la ruta del enlace y el prefijo no coincide →
     * el agente cree que «no es nuestro proceso» → no encuentra la ventana del emulador (emu:0 en el registro) →
     * falla la toma de la ventana nativa → vuelve al modo incrustado y el usuario ve la ventana contenedora con botón de rotación.
     * Se conservan las dos rutas: la real para la coincidencia y la original por compatibilidad con los pocos entornos que devuelven la ruta del enlace.
     */
    const raw = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const list = [];
    for (const d of raw) {
      try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(d) : fs.realpathSync(d);
        if (real) list.push(real);
      } catch (_) { /* Si la carpeta no existe solo se deja la ruta original */ }
      list.push(d);
    }
    const uniq = [...new Set(list.filter(Boolean))];
    const req = { cmd: 'scope', dirs: uniq.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /**
   * Incrusta la ventana de la imagen en la ventana anfitriona y la coloca en x,y,w,h (coordenadas del área cliente del anfitrión).
   *
   * @param {number|string} hostHwnd identificador de la ventana anfitriona
   * @param {object} rect { x, y, w, h, clipTop }
   * @param {string[]} [targets] identificadores candidatos («0x…») que reporta un backend de terceros.
   *        Sin indicar = comportamiento anterior: el agente busca por ámbito de proceso la ventana del emulador integrado.
   *        Indicado = solo se incrusta uno de estos identificadores (la ventana de imagen de MuMu / otro emulador).
   */
  async embed(hostHwnd, rect, targets = null) {
    const req = {
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    };
    if (Array.isArray(targets) && targets.length) {
      req.target = targets.map((t) => String(t)).join(',');
    }
    return this.call(req, 6000);
  }

  /** Cuántos de los identificadores candidatos siguen existiendo (control de «listo» para backends de terceros) */
  async windowReady(targets = []) {
    if (!Array.isArray(targets) || !targets.length) return { ok: false, alive: 0 };
    return this.call({ cmd: 'winready', target: targets.join(',') }, 3000)
      .catch(() => ({ ok: false, alive: 0 }));
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // La ventana Qt del emulador tiene un marco EMU_PAD mayor que el LCD; la hacemos desbordar hacia arriba/izquierda para sacar ese marco
      // del área cliente; la franja que desborda sobre la barra de título se recorta (si no, al pulsar los botones de la barra aparece un borde negro).
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** Avisa al agente que entre en modo de baja latencia: reduce mucho la frecuencia de escaneo de ventanas y deja la CPU para el renderizado de Android */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  /** @param {boolean} keep true = cambia a modo de ventana independiente (no ocultar la ventana del emulador y conservar el identificador) */
  async detach(keep = false) { return this.call({ cmd: 'detach', keep: keep ? 1 : 0 }, 5000); }
  /** Modo de ventana independiente: coloca la ventana nativa del emulador en el rectángulo de pantalla indicado (sin incrustar) */
  async layout(rect) {
    return this.call({
      cmd: 'layout',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    }, 4000);
  }
  /**
   * Cambia el título de la ventana nativa del emulador de "Android Emulator - lanzadorapk:5554" a un nombre comprensible para el usuario.
   * Con cadena vacía usa "Lanzador APK". El agente lo vuelve a fijar en sus revisiones (Qt a veces lo cambia solo).
   */
  async setTitle(text = 'Lanzador APK') {
    return this.call({ cmd: 'title', text: String(text || 'Lanzador APK') }, 4000);
  }
  /**
   * Fija el icono de la ventana nativa del emulador (en modo independiente, la barra de tareas/Alt+Tab muestran el icono de la app actual).
   * @param {string} file ruta absoluta del PNG/ICO
   */
  async setIcon(file) {
    return this.call({ cmd: 'icon', file: String(file || '') }, 4000);
  }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** Lista las ventanas de nivel superior visibles (para verificar «solo la interfaz del programa / solo la ventana de la app Android») */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * «Desprende y oculta» la ventana más sospechosa.
   * Hay que llamarlo antes de destruir la ventana anfitriona: al destruir la ventana padre, Windows vuelve a colgar del escritorio las ventanas hijas de otros procesos
   * conservando su visibilidad; de ahí salía la ventana negra de Android Emulator que aparecía de la nada en el escritorio.
   * Aunque el agente esté ocupado (quizá compilando C#) no se puede demorar el cierre de la ventana, por eso hay un límite fijo de 700 ms.
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * Activa la «supresión persistente»: la ventana principal del emulador (QWindowIcon) + barra de herramientas + consolas negras de qemu / netsimd
   * nunca pueden mostrarse, salvo la que está incrustada en nuestra ventana.
   * Esto es clave para que «al abrir el programa solo se vea su interfaz»: emulator lanza consolas qemu / netsimd
   * independientes que windowsHide de Node no alcanza; solo el agente de ventanas puede ocultarlas periódicamente.
   * Ahora el emulador además usa -qt-hide-window (la ventana se crea oculta): doble seguro, ni el primer fotograma parpadea.
   *
   * maxWaitMs: el agente se compila al vuelo al iniciar (cientos de ms; si algo falla, hasta diez segundos o más). Se llama
   * «antes de lanzar el emulador» y nunca debe retrasar el arranque porque el agente no inicie, por eso hay un límite fijo.
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** Desactiva la supresión persistente (normalmente ya no hace falta: tras incrustar, la supresión omite sola la ventana incrustada) */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * Interruptor del gancho global de ratón (idempotente).
   * Solo se instala con la ventana de la app en primer plano y al menos una asignación activa; si cambian las opciones no se reinstala el hilo,
   * solo se envían los nuevos interruptores al agente, para no instalar/quitar el gancho cada vez que cambia el foco o la configuración.
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // Con todo desactivado no se lanza PowerShell solo para «apagar» (costo cero en arranque en frío)
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // Primero se quita el gancho global y luego se termina el proceso: aunque el agente muera a la fuerza no queda ningún gancho en el sistema
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // A propósito no se mata el proceso del agente: al desconectarse entra solo en modo «guardia» (ver
    // _lingerUntil en agent.ps1). El emulador puede seguir arrancando y mostrar su ventana decenas de segundos después; si para entonces
    // el agente ya murió, quedaría una ventana negra de Android Emulator en el escritorio. Cuando desaparece el proceso del emulador
    // el agente sale solo; espera como máximo 3 minutos.
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
