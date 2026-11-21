'use strict';
/**
 * Ventana de app: una app Android en ejecución = una ventana limpia de Windows.
 *
 * La ventana solo tiene arriba una barra de título de 38 px (rotar / minimizar / maximizar / cerrar),
 * y debajo toda la imagen es la ventana del emulador incrustada (SetParent): no se ve el escritorio de Android,
 * ni la barra lateral del emulador, ni aparece un segundo icono en la barra de tareas.
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');
const { physicalRect } = require('./geometry');

const TITLEBAR_H = 38;
/**
 * La ventana del emulador trae un margen gris de 8 px alrededor (el borde de Qt),
 * y la imagen LCD real empieza en +8 px. Agrandando la ventana hija 16 px y desplazándola 8 px arriba a la izquierda,
 * ese borde gris queda fuera del área cliente y la imagen llena limpiamente los cuatro lados.
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null, windowTargets = null, controlBar = null }) {
    this.agent = agent;
    // Barra de controles flotante del modo de ventana independiente (Atrás / Inicio / Apps abiertas / Cerrar…).
    // controlBar es un getter del interruptor de Configuración; null = sin barra (pruebas).
    this.controlBar = null;
    if (typeof controlBar === 'function') {
      const { ControlBar } = require('./controlbar');
      this.controlBar = new ControlBar({
        agent,
        enabled: controlBar,
        preload: path.join(__dirname, '..', 'preload.js'),
        page: path.join(__dirname, '..', 'ui', 'controlbar.html'),
      });
    }
    this.setOrientation = setOrientation || null;
    // Origen de los identificadores candidatos de la ventana de imagen: ahora solo hay un backend, siempre null;
    // el agente de ventanas los busca por ámbito de proceso (todas esas ventanas las crea el emulator que lanzamos).
    this.windowTargets = typeof windowTargets === 'function' ? windowTargets : null;
    // El gancho global de ratón solo se instala con «ventana de la app en primer plano + al menos una asignación activa».
    // pointerConfig recibe una función: si cambia un interruptor en Configuración, se aplica en el próximo foco sin reiniciar.
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** Tamaño objetivo del contenido de la ventana en vertical / horizontal (se ajusta a la pantalla) */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // Márgenes suficientes: barra de título 38 + 24 arriba y abajo, 40 a cada lado
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // Doble seguro: nunca superar el área disponible de la pantalla; si no, el sistema la recorta y se ve «con bordes negros / sin llenar»
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    // workArea está en DIP (píxeles lógicos). El proceso del agente de ventanas es DPI-aware por monitor,
    // y SetWindowPos recibe píxeles físicos, así que en modo de ventana independiente estos valores deben multiplicarse por sf
    // antes de pasarlos a agent.layout. sf y area salen de la misma pantalla; con varios monitores no se usa una escala equivocada.
    return { x: a.x, y: a.y, w: a.width, h: a.height, sf: d.scaleFactor || 1 };
  }

  /**
   * La ventana nativa del emulador fija su propia proporción según la pantalla del dispositivo; una proporción equivocada la corrige ella misma.
   * Aquí se calcula la proporción w/h que debe tener la ventana actual (con la barra de título), para dar el tamaño correcto de una vez.
   * En modo de ventana independiente la ventana contenedora está oculta y sus bounds pueden ser los verticales por defecto,
   * así que se corrige según la orientación de la pantalla (en horizontal ancho > alto, proporción > 1).
   */
  _panelRatio() {
    const b = this.win ? this.win.getBounds() : this._area();
    if (b && b.width > 0 && b.height > 0) {
      // Con pantalla horizontal, los bounds de la ventana contenedora pueden seguir siendo verticales (en modo detached está oculta);
      // leerlos daría 0,56 (9:16), pero la pantalla real es 16:9.
      // En ese caso se usa el h/w de vertical como ancho (horizontal = pantalla vertical girada 90°)
      if (this.state.landscape && b.height > b.width) {
        return b.height / b.width;
      }
      return b.width / b.height;
    }
    return 0.5625; // Respaldo vertical 9:16
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * Convierte un rectángulo en DIP (píxeles lógicos) a píxeles físicos, para el SetWindowPos del agente de ventanas.
   * Las coordenadas de screen/BrowserWindow de Electron siempre son DIP; agent.ps1 declara arriba
   * conciencia de DPI per-monitor v2, y SetWindowPos de Win32 recibe píxeles físicos. Mezclarlos
   * con escalado de 125 %/150 % era la causa de «la ventana se ve a medias / corrida a una esquina / clics desplazados»
   * (issue #99). _rect() ya multiplicaba por sf; aquí se completa lo que faltaba en el modo de ventana independiente.
   */
  _physical(rect, sf) {
    return physicalRect(rect, sf || this._scale());
  }

  /**
   * Abre (o reutiliza) la ventana de la app.
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, detached,
   *                     showWhileWaiting, onClosed }
   *        Con detached=true usa el «modo de ventana independiente»: la ventana contenedora se carga sin mostrarse y la imagen va en la ventana nativa del emulador.
   *        Con showWhileWaiting=true, **durante la espera** se muestra primero la ventana contenedora (con un texto de aviso),
   *        y openDetached() la oculta cuando se engancha la ventana del emulador. Cambiar a una app con otra orientación
   *        requiere reiniciar el runtime (unos 40 s); antes, durante ese tiempo no se veía nada y el usuario creía que se había cerrado.
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen, detached } = o;
    this.detachedMode = !!detached;
    this.waitingForRestart = false;
    this._showWhileWaiting = !!o.showWhileWaiting;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      // En modo de ventana independiente la ventana contenedora nunca debe verse (no tiene contenido, solo es un bloque negro).
      // Si el usuario vuelve a pulsar la misma app, lo que quiere es «traer al frente la ventana que está viendo»,
      // así que el agente de ventanas sube la ventana nativa del emulador.
      if (this.detachedMode) this.agent.show().catch(() => {});
      else {
        this.win.show();
        this.win.focus();
      }
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    // Guarda la ruta del archivo de icono original: en modo de ventana independiente se le asigna a la ventana nativa del emulador (LoadImage de
    // Win32 solo acepta rutas de archivo, no la data URL que usa el HTML).
    this.iconFilePath = iconPath || '';
    this.portrait = portrait || { w: 540, h: 960 };
    // En modo de ventana independiente la «pantalla completa» se aplica a la ventana del emulador (nuestra capa contenedora está oculta;
    // maximizar una ventana oculta no tiene ningún efecto visible; openDetached lee esta marca).
    this._wantFullscreen = !!fullscreen;
    this.state = { label: label || 'App', tip: 'Iniciando el runtime de Android…', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'Lanzador APK',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // El título de la página cambiaría el título de la ventana al <title> de shell.html y la barra de tareas no sabría qué app es;
    // aquí se bloquea para que el título del sistema sea siempre el nombre de la app (lo usan la vista previa de la barra de tareas y Alt+Tab).
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'Lanzador APK'); } catch (_) { /* La ventana puede estar ya destruida */ }
    });
    this.win.once('ready-to-show', () => {
      // En modo de ventana independiente la imagen de Android está en la ventana nativa del emulador; nuestra capa contenedora no tiene nada que mostrar
      // y solo añadiría una ventana negra vacía. Por eso solo se carga sin mostrarse (la ventana existe para la lógica de estado/cierre).
      // Excepción: showWhileWaiting (al cambiar de app no hay animación de arranque que lo cubra): es mejor mostrar primero
      // la ventana «Abriendo xxx…» que dejar al usuario 40 s frente al escritorio vacío.
      if (this.detachedMode && !this._showWhileWaiting) return;
      this.win.show();
      this._push();
    });

    // Al maximizar, el tamaño de la ventana de Electron tarda varios pasos en estabilizarse (animación del sistema, recálculo de DPI),
    // y un solo ajuste con 40 ms de espera solía capturar un estado intermedio: la imagen incrustada ocupaba solo una franja arriba a la izquierda
    // con un gran espacio vacío a la derecha; el «tras maximizar no se llena» de las capturas de usuarios.
    // Ahora se ajusta en varias rondas seguidas, recalculando cada vez con el getContentBounds más reciente.
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() termina por su cuenta tras completar park
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // Las vías de cierre que no pasan por close() (Alt+F4, cerrar desde la barra de tareas, apagado del sistema) también deben detener la app Android
      // y desprender la ventana del emulador. Si no, la ventana desaparece pero la app sigue en segundo plano, y al volver a abrirla
      // se salta directo porque «ya está en ejecución», y parece que «no se puede cerrar».
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // El gancho global solo se instala con «la ventana de la app realmente en primer plano» y al menos una asignación de ratón activa;
    // se quita al perder el foco/cerrar, para que LanzadorAPK nunca ralentice el ratón de todo el sistema desde segundo plano.
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    // Atención: maximize() muestra directamente una ventana con show:false.
    // En modo de ventana independiente la imagen está en la ventana nativa del emulador; maximizar aquí haría aparecer
    // una ventana contenedora negra vacía en el centro de la pantalla: la mitad de los reportes de «al abrir la app aparecen varias ventanas» venían de aquí.
    if (fullscreen && !this.detachedMode) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // En modo juego / baja latencia no se instala el gancho global: WH_MOUSE_LL llama de forma síncrona
    // por cada evento de ratón del escritorio y aumenta la latencia del puntero; los FPS necesitan que la ventana Qt reciba la entrada directamente.
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** Cambiaron las asignaciones de ratón en Configuración: se vuelve a sincronizar según el foco actual (sin reinstalar el hilo del gancho) */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // La ventana no está en primer plano: solo se quita, para que el gancho no corra en vano en segundo plano
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  /**
   * «Mostrar temporalmente la ventana contenedora» en modo de ventana independiente.
   *
   * Caso: al cambiar a una app con otra orientación hay que reiniciar el runtime de Android (unos 40 s); mientras tanto
   * la ventana nativa del emulador se destruye y la nueva aún no existe. Si la ventana contenedora está oculta, en pantalla
   * no hay nada y el usuario cree que el programa se cerró. Al iniciar se muestra una vez con showWhileWaiting,
   * pero en cuanto pre-attach tiene éxito se oculta; cuando llega el reinicio real ya nadie la vuelve a mostrar.
   *
   * Por eso se llama explícitamente antes y después del reinicio: primero se muestra la ventana con el aviso, y cuando se engancha la nueva ventana
   * el hide() de la primera línea de openDetached() la oculta.
   */
  showWaiting(tip) {
    if (!this.isOpen) return false;
    // Marca «esperando reinicio»: el sondeo pre-attach del arranque la ve y se aparta,
    // porque si no, en su siguiente openDetached() ocultaría la ventana contenedora y el usuario volvería a esperar frente al escritorio vacío.
    this.waitingForRestart = true;
    if (tip) this.state = { ...this.state, tip, ready: false };
    this._push();
    try {
      this.win.show();
      this.win.moveTop();
    } catch (_) {
      return false;
    }
    return true;
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* La ventana puede acabar de cerrarse */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * Incrusta la ventana del emulador en la ventana actual y la extiende por toda el área bajo la barra de título.
   * La supresión persistente no se desactiva: omite la ventana «ya incrustada en la nuestra» y sigue ocultando las demás (incluidas
   * las consolas negras de qemu / netsimd); desactivarla les daría otra oportunidad de aparecer.
   * A veces la ventana del emulador aún no está creada (en equipos donde la instantánea se restaura muy rápido); aquí se reintenta dos veces.
   */
  /**
   * Modo de ventana independiente: **no** se incrusta el emulador en nuestra ventana; se le deja abrir su propia ventana nativa.
   *
   * Por qué existe esta vía: incrustar (SetParent) se ve más uniforme, pero trae toda una serie de problemas:
   * orden Z entre primer y segundo plano, bordes negros, coordenadas desplazadas, no llena al maximizar, la orientación de la pantalla Qt choca con la proporción del anfitrión.
   * Todo eso es el costo inherente de «meter la ventana de otro dentro de la propia».
   *
   * En ventana independiente, la ventana del emulador es una ventana nativa del sistema: orientación, escalado y entrada los gestiona ella,
   * y todos esos problemas desaparecen de raíz. El costo es un icono más en la barra de tareas y un aspecto no del todo uniforme.
   *
   * @returns {Promise<boolean>} si se logró cambiar a ventana independiente
   */
  async openDetached() {
    // Si la ventana contenedora ya se cerró (el usuario pulsó cerrar / se ocultó durante el arranque) no hay dónde alojar nada.
    // Se registra el motivo: si no, el registro superior solo mostraría "unknown", sin saber si «la ventana ya no existe»
    // o «no se encontró la ventana del emulador».
    if (!this.isOpen) { this.lastEmbedError = 'shell-closed'; return false; }
    // Empieza la toma real del control; la marca de espera termina aquí (la siguiente ronda de pre-attach puede reintentar normalmente)
    this.waitingForRestart = false;
    // En modo independiente la ventana contenedora nunca debe verse (no tiene contenido, solo sería un bloque negro).
    // Pero con showWhileWaiting ahora es el «aviso de espera» visible; aquí se encarga de ocultarlo.
    try { this.win.hide(); } catch (_) { /* ignore */ }
    // Primero se asegura que no siga incrustada (al venir del modo incrustado, el padre de _emu sigue siendo el anfitrión).
    // keep=true: le dice al agente que esto es «cambiar a ventana independiente», no «terminar la incrustación»; si no,
    // ocultaría como estorbo la ventana del emulador que el usuario está viendo.
    const dt = await this.agent.detach(true).catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug = `detach=${JSON.stringify(dt)}`;
    // El título tiene que fijarse antes de show.
    // El proceso del agente es persistente y guarda en caché «el último título fijado» (_ourTitle); una nueva ventana del emulador
    // recibe ese título viejo apenas se muestra: al cambiar de app la ventana mostraba **el nombre de la app anterior**
    // durante 0,5 s, y en el primer arranque primero salía "Android Emulator - lanzadorapk:5554".
    // Antes el orden era show() → setTitle(), por eso ese medio segundo siempre se veía.
    const title = this.state && this.state.label ? this.state.label : 'Lanzador APK';
    await this.agent.setTitle(title).catch(() => {});
    await sleep(600);
    // Hace visible de verdad la ventana del emulador
    const shown = await this.agent.show().catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` show=${JSON.stringify(shown)}`;
    if (!shown || shown.ok === false) { this.lastEmbedError = this._detachedDebug; return false; }
    // También el icono pasa a ser el de la app actual: la ventana nativa del emulador trae por defecto el robot verde de Google, y en modo independiente
    // se notaría en la barra de tareas/Alt+Tab. LoadImage de Win32 es más fiable con .ico (no siempre acepta PNG),
    // y el instalador ya generó un .ico con el mismo nombre para cada app; aquí se usa primero.
    const icoForNative = this.iconFilePath
      ? this.iconFilePath.replace(/\.png$/i, '.ico')
      : '';
    if (icoForNative && fs.existsSync(icoForNative)) {
      try { await this.agent.setIcon(icoForNative); } catch (_) { /* ignore */ }
    } else if (this.iconFilePath) {
      try { await this.agent.setIcon(this.iconFilePath); } catch (_) { /* ignore */ }
    }
    await sleep(300);
    // Centra y dimensiona según el área disponible de la pantalla.
    // Atención: la ventana nativa del emulador fija su proporción según la pantalla del dispositivo (vertical 9:16);
    // si recibe un w/h que no coincide, ajusta el ancho al valor correspondiente a la altura, y el resultado es «se pidieron 1280 de ancho
    // y quedaron 400». Por eso aquí se calcula el tamaño según la proporción de la pantalla y se da correcto de una vez.
    //
    // En pantalla completa («Pantalla completa al iniciar») llena toda el área disponible; con pantalla horizontal la proporción ya coincide
    // con el monitor y no deja bordes negros; por eso la horizontal aprovecha mejor la pantalla completa que la vertical.
    const area = this._area();
    const ratio = this._panelRatio();
    let w;
    let h;
    let x;
    let y;
    if (this._wantFullscreen) {
      // «Llenar» también respeta la proporción de la pantalla. Al poner una pantalla vertical (720x1280) en un monitor de 1920x1080,
      // si la ventana se fija directamente en area.w × area.h, Qt la reduce proporcionalmente pero la deja en
      // la esquina superior izquierda: el usuario ve una franja vertical pegada arriba a la izquierda, no «pantalla completa».
      // Aquí se toma el mayor rectángulo con esa proporción y se centra; con pantalla horizontal la proporción ya coincide y realmente llena.
      const fitW = Math.min(area.w, Math.round(area.h * ratio));
      w = fitW;
      h = Math.round(fitW / ratio);
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + (area.h - h) / 2);
      // Se sincroniza la marca de pantalla completa; si no, la primera vez que se pulse «maximizar» se tomaría como «entrar a pantalla completa» en lugar de restaurar.
      this._detachedFullscreen = true;
    } else {
      this._detachedFullscreen = false;
      const maxH = Math.min(area.h - 140, 1000);
      const maxW = Math.min(area.w - 80, 1280);
      w = maxW;
      h = Math.round(w / ratio);
      if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + 60);
    }
    // area/x/y/w/h son píxeles lógicos DIP de Electron, y SetWindowPos del agente de ventanas recibe
    // píxeles físicos. Sin convertir, con escalado de 150 % la ventana queda a 2/3 y corrida arriba a la izquierda: el «se ve a medias»
    // de la issue #99. _rect() (modo incrustado) ya multiplicaba por sf; aquí se completa el modo independiente.
    const lay = await this.agent.layout(this._physical({ x, y, w, h }, area.sf))
      .catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` layout=${JSON.stringify(lay)}`;
    this.lastEmbedError = this._detachedDebug;
    this.lastEmbedOk = false;
    const placed = !!(lay && lay.ok !== false);
    if (placed && this.controlBar) {
      try { this.controlBar.attach(title); } catch (_) { /* sin barra la app sigue funcionando (bandeja / menú) */ }
    }
    return placed;
  }

  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // Si desde fuera llegan identificadores candidatos (interfaz histórica, ahora siempre null); si no hay, se espera y se reintenta
      // porque los identificadores se reasignan en cada arranque y guardar uno viejo incrustaría la ventana en el lugar equivocado.
      let targets = null;
      if (typeof this.windowTargets === 'function') {
        // eslint-disable-next-line no-await-in-loop
        targets = await Promise.resolve(this.windowTargets()).catch(() => null);
        if (Array.isArray(targets) && !targets.length) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(attempt < 2 ? 400 : 1000);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect(), targets).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) { this.lastEmbedOk = true; return true; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // Se devuelve el motivo del fallo: la capa superior lo escribe en app.log y si hay un problema se ve de inmediato si fue «no se encontró la ventana del emulador»
    // o «falló SetParent», sin tener que adivinar.
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});  }

  /** Rectángulo que debe ocupar la ventana hija del emulador (píxeles físicos, con el margen de 8 px ya fuera del área visible) */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // El -EMU_PAD de arriba cae sobre la barra de título; el agente de ventanas lo recorta (ver clipTop en agent.fit)
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds cuántas rondas seguidas de ajuste (si cambia el tamaño de la ventana, cada ronda recalcula los bounds más recientes)
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * Cambiar horizontal/vertical (botón de rotación de la barra de título) = cambiar de verdad la «pantalla física» a horizontal o vertical.
   *
   * Por qué tiene que ser así (problemas ya vividos):
   *   - cambiar wm size: solo cambia la resolución lógica de Android; el LCD físico del emulador sigue vertical,
   *     Qt pega la imagen arriba a la izquierda -> imagen acostada 90°, en una franja, con bordes negros y clics desplazados;
   *   - cambiar wm density: el tamaño del framebuffer no cambia, la imagen no llena y al maximizar queda un gran espacio vacío a la derecha;
   *   - adb emu rotate: solo gira el contenido de la imagen; el sistema sigue en vertical.
   * La única forma de tener una horizontal «derecha y a pantalla llena» es cambiar hw.lcd.width/height a
   * 1280x720 y reiniciar el emulador. El reinicio tarda unos 30–60 s, así que se hace una sola vez y con un aviso claro.
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] implementación del reinicio inyectada por la capa superior
   * @param {boolean} [explicitNext] orientación objetivo. Si se pasa se usa directamente, sin invertir;
   *        el punto de entrada de la rotación calcula la orientación y la pasa, para que aquí y arriba no se calcule por separado
   *        y «el valor guardado en apps.json» no quede al revés de «la orientación a la que se cambió realmente».
   */
  async rotate(onRestart, explicitNext) {
    if (!this.isOpen) return this.state.landscape;
    const next = explicitNext === undefined || explicitNext === null
      ? !this.state.landscape : !!explicitNext;
    this.setState({ tip: next ? 'Cambiando a horizontal (reinicia el runtime de Android, unos 30-60 s)…' : 'Volviendo a vertical (reinicia el runtime de Android, unos 30-60 s)…', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // Cambió el tamaño de la pantalla, así que cambia la proporción de la ventana; se ajusta en varias rondas
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // Sin implementación de reinicio inyectada (o si falla) se usa la densidad, al menos para cambiar el diseño
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** Cambia a la orientación indicada si hace falta (pantalla completa = horizontal, ventana = vertical) */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  async toggleMaximize() {
    if (!this.isOpen) return;
    // Modo de ventana independiente: la imagen está en la ventana nativa del emulador y la contenedora está oculta; maximizar una ventana
    // oculta no tiene efecto visible (justo la causa de «el botón de arriba a la derecha no hace nada»). Aquí en cambio
    // la ventana del emulador se extiende al área de trabajo / vuelve al tamaño anterior.
    if (this.detachedMode) {
      const area = this._area();
      if (this._detachedFullscreen) {
        // Restaurar: vuelve al tamaño guardado antes de la pantalla completa (si existe); si no, se centra con la proporción por defecto
        this._detachedFullscreen = false;
        if (this._preFullscreenRect) {
          await this.agent.layout(this._preFullscreenRect).catch(() => {});
          this._preFullscreenRect = null;
        } else {
          await this.openDetachedLayoutOnly(area);
        }
      } else {
        // Antes de la pantalla completa se guarda la posición y el tamaño actuales de la ventana, para restaurar
        try {
          const probe = await this.agent.probe().catch(() => null);
          if (probe && probe.w > 0 && probe.h > 0) {
            this._preFullscreenRect = { x: probe.x, y: probe.y, w: probe.w, h: probe.h };
          }
        } catch (_) { /* Si no se obtienen, al restaurar se usa el valor por defecto */ }
        this._detachedFullscreen = true;
        // Igual que openDetached: la pantalla completa también respeta la proporción y centra; si no, una app vertical
        // sería reducida por Qt y se quedaría arriba a la izquierda.
        const ratio = this._panelRatio();
        const fitW = Math.min(area.w, Math.round(area.h * ratio));
        const fitH = Math.round(fitW / ratio);
        await this.agent.layout(this._physical({
          x: Math.round(area.x + (area.w - fitW) / 2),
          y: Math.round(area.y + (area.h - fitH) / 2),
          w: fitW,
          h: fitH,
        }, area.sf)).catch(() => {});
      }
      return;
    }
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  /**
   * Solo reajusta el tamaño de la ventana del emulador (sin volver a detach/show), para que pantalla completa/restaurar reutilicen
   * el cálculo de tamaño de openDetached. Se separa para no repetir el flujo detach.
   */
  async openDetachedLayoutOnly(area) {
    const maxH = Math.min(area.h - 140, 1000);
    const maxW = Math.min(area.w - 80, 1280);
    const ratio = this._panelRatio();
    let w = maxW;
    let h = Math.round(w / ratio);
    if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
    await this.agent.layout(this._physical({
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + 60),
      w, h,
    }, area.sf)).catch(() => {});
  }

  minimize() {
    if (!this.isOpen) return;
    // Modo de ventana independiente: lo que se minimiza es la ventana nativa del emulador (agent.hide la oculta),
    // no la ventana contenedora invisible.
    // Se minimiza a la barra de tareas (antes se ocultaba del todo y solo se recuperaba desde la bandeja o volviendo a abrir la app)
    if (this.detachedMode) {
      this.agent.minimize().catch(() => this.agent.hide().catch(() => {}));
      return;
    }
    this.win.minimize();
  }

  /**
   * Cierra la ventana. Por defecto también detiene la app Android (ahorra memoria) pero conserva el motor; la próxima vez abre al instante.
   *
   * El orden importa: primero hay que «desprender y ocultar» la ventana del emulador de la anfitriona, y luego destruir la anfitriona.
   * Al revés, Windows vuelve a colgar del escritorio las ventanas hijas de otros procesos conservando su visibilidad,
   * y en el escritorio del usuario aparece de la nada una ventana negra "Android Emulator - lanzadorapk5554".
   */
  close({ keepApp = false } = {}) {
    if (this.controlBar) this.controlBar.detach();
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    this.lastEmbedOk = false;
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
