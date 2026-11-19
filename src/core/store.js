'use strict';
/**
 * Persistencia local: lista de apps + configuración
 * Carpeta de datos: %APPDATA%\lanzadorapk (para MSIX/Store ver la explicación de STORE_BUILD abajo)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeFilePart } = require('./pkgname');

/**
 * ¿Es la versión empaquetada para Microsoft Store (MSIX / APPX)?
 *
 * Las apps full-trust de MSIX redirigen las **escrituras** en `%APPDATA%` / `%LOCALAPPDATA%`
 * a `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\...`,
 * pero las variables de entorno y las API siguen devolviendo la «ruta real» anterior a la redirección. Eso causa dos problemas:
 *   1. si emulator/adb/qemu lanzados desde %APPDATA%\lanzadorapk no tienen identidad de paquete,
 *      al buscar archivos por la ruta real dan «el archivo no existe»;
 *   2. al pulsar «abrir carpeta de datos» el usuario ve una carpeta vacía.
 * Por eso la versión de la Store pone la carpeta de datos **fuera** de AppData (%USERPROFILE%\LanzadorAPK),
 * totalmente fuera de la virtualización: los procesos padre e hijo ven los mismos archivos reales.
 *
 * process.windowsStore lo inyecta Electron en entornos MSIX/APPX (en node normal es undefined).
 */
const STORE_BUILD = (() => {
  try { return !!require('electron').app?.isPackaged && !!process.windowsStore; } catch (_) { return false; }
})();

const DATA_DIR = STORE_BUILD
  ? path.join(os.homedir(), 'LanzadorAPK', 'data')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'lanzadorapk');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  /**
   * Extensión de controladores (parches de compatibilidad): los parches JSON del usuario van en drivers/ dentro de la carpeta de datos.
   * Aquí solo se guardan «los id que el usuario desactivó»: por defecto todos activos; si uno falla se desactiva con un clic, sin borrar archivos.
   */
  drivers: { state: {}, disabled: [] },
  engine: {
    // Solo hay un runtime: el integrado (builtin). El campo se conserva por compatibilidad al combinar settings.json antiguos,
    // y al leer la configuración se fuerza a 'builtin' (ver la migración en getSettings).
    mode: 'builtin',
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = lo decide doctor según la memoria del equipo
    cores: 0,                // 0 = automático
    autoMemory: true,        // Sin configuración: deduce automáticamente memoria/núcleos/disco/parámetros de renderizado
    idleShutdownMinutes: 15,
    startVisible: true,
    // Debe tener ventana: sin ventana SurfaceFlinger no emite VSYNC; el proceso de la app vive pero no se ve nada en pantalla.
    // Con ventana el emulador tiene 60 fps nativos + ratón y teclado nativos; LanzadorAPK solo lo viste como ventana de app.
    headless: false,
    gpuMode: 'auto',         // auto = elige el motor según la versión de emulator y degrada paso a paso
    // Motor de renderizado que «falló al lanzarse» la última vez (formato `<versión de emulator>|<gpu>`); en modo auto va al final la próxima vez,
    // para no esperar más de 20 s en cada arranque antes de pasar al renderizado por software. Al actualizar el runtime se invalida solo.
    badGpu: '',
    forceTcg: false,         // Reservado para diagnósticos avanzados; la ruta normal ya la cubre la degradación automática de doctor
    audio: true,             // Sonido de las apps Android (avisos/video). Desactivarlo ahorra algo de CPU
    // ---- Contenedor ligero (por defecto todo activado para ahorrar recursos; el usuario puede desactivar cada cosa) ----
    liteMode: true,          // Limita la cuota de vCPU para que qemu no ocupe todos los núcleos físicos y ralentice Windows
    // Estrategia en una palabra: save (ahorro) / balanced (equilibrado) / smooth (fluido, prioridad a video y juegos).
    // La interfaz solo muestra esta opción y al guardar se traduce en liteMode / priorityMode / renderSize;
    // abajo se mantienen los interruptores detallados para usuarios avanzados.
    resourceMode: 'balanced',
    // Capacidad de la partición de datos (GB): aquí van las apps, la caché de juegos y sus actualizaciones.
    // 0 = automático (6/8 GB según el espacio libre). Al aumentarlo se **amplía en el sitio** en el próximo arranque de Android, sin perder apps.
    dataPartitionGB: 0,
    // Resolución de renderizado: más baja = más fluido y menos consumo; auto = 720x1280 / 540x960 según la aceleración
    renderSize: 'auto',
    // DNS públicos opcionales (Cloudflare + Google). Por defecto Android usa 10.0.2.3, que pasa por el DNS del equipo;
    // con VPN / redes corporativas / algunos proveedores la resolución puede tardar cientos de ms y las apps de video tardan en mostrar la primera pantalla.
    // Off by default: Android uses the host's DNS. When on, uses Cloudflare + Google public DNS.
    fastDns: false,
    // Idioma del sistema: se inyecta al arrancar con emulator -change-locale (dentro del invitado setprop lo rechaza SELinux).
    // Por defecto español latinoamericano (es-419). Con en-US u off vuelve al inglés original de la imagen.
    locale: 'es-419',
    // Android time zone: '' = same as this PC (IANA name, e.g. America/Bogota).
    timezone: '',
    // El teclado en pantalla es el latino que trae la imagen (Gboard o LatinIME de AOSP);
    // se activa al arrancar y sigue el idioma del sistema.
    // Instantánea: la instantánea de memoria quickboot hace que el segundo arranque tarde segundos, a cambio de un ram.bin extra de unos 2–3 GB
    // en disco. Con poco espacio se puede desactivar (solo afecta la velocidad de arranque, no los datos de las apps).
    keepSnapshot: true,
    // Límite de registros (KB): al superarlo se rota una copia, para que el uso prolongado no llene el disco
    logLimitKB: 2048,
    // Botones del ratón: el emulador ya mapea el clic izquierdo a «confirmar/tocar»; no hace falta interruptor.
    // Clic derecho = atrás y la rueda suave necesitan un gancho de bajo nivel, pero solo se instala con la ventana de la app en primer plano y se quita al perder el foco.
    mouseRightBack: true,    // Clic derecho = atrás en Android (intercepta el toque accidental de Qt, que por defecto trata el clic derecho como toque)
    mouseWheelMode: 'smooth', // smooth = agrupa e inyecta un deslizamiento | native = lo maneja Qt | off = no se procesa
    mouseSideButtons: false, // Botones laterales atrás/adelante: desactivados por defecto; al activarlos se agrega una asignación más
    deepTrim: false,         // Recorte profundo de paquetes de sistema en segundo plano (Play Store/asistente, etc.); por defecto no se toca el sistema
    // balanced = cede el primer plano | performance = qemu Normal | game = qemu High + entrada de baja latencia
  priorityMode: 'balanced',
    // Precalentamiento: al iniciar LanzadorAPK se prepara Android en segundo plano y la primera app casi no espera.
    // El costo es ~1 GB de memoria residente (el mismo compromiso que WSA y similares); se puede desactivar en cualquier momento.
    prewarm: true,
    // Multiventana (opción B): permite abrir varias apps a la vez, cada una en su ventana. Desactivada por defecto,
    // se mantiene el comportamiento de una ventana «abrir la nueva cierra la anterior»; al activarla, la suspensión libera el segundo plano y los recursos quedan controlados.
    multiWindow: false,
    // En multiventana se conservan sin suspender las últimas apps en segundo plano (para volver al instante sin perder la sesión).
    // 0 = máximo ahorro de memoria (solo el primer plano); por defecto 1.
    keepBackground: 1,
    // Asignación de teclas (teclado de juego → pantalla táctil): activada por defecto; el usuario puede desactivarla en Configuración
    keymapEnabled: true,
    // Tabla de asignación de teclas por app: { "com.example.game": [{key:'w',action:'tap',x:0.15,y:0.75}, ...] }
    keymaps: {},
  },
  runtime: {
    dir: '',                 // vacío = %APPDATA%\lanzadorapk\runtime
    qemuUrl: '',             // Dirección manual del instalador de QEMU
    isoUrl: '',              // Dirección manual de la imagen del sistema
    isoPath: '',             // Ruta de la imagen del sistema (ISO)
    diskPath: '',            // Disco virtual donde se instala el sistema
    diskSizeGB: 24,
    headless: false,         // No mostrar la ventana de la máquina virtual (solo depuración)
    installMode: 'guided',   // guided (instalación manual guiada) | auto (instalación automática experimental)
    emulatorUrl: '',         // Dirección manual del paquete de emulator (vacío = se resuelve automáticamente la última del índice del SDK)
    sysimgUrl: '',           // Dirección manual del paquete de imagen del sistema
    compatImage: false,      // Modo de compatibilidad ARM: usa la imagen Google Play (con native bridge; instala apps solo ARM)
    deployFailedAt: 0,       // Marca de tiempo del último fallo de instalación automática (0 = sin fallos). Tras un fallo no se vuelve a descargar automáticamente durante 30 minutos
    diskChoiceAsked: false,  // Ya se ofreció (una vez) guardar los datos de Android en otro disco con más espacio
    // Paquete del runtime de la versión ligera: por defecto se descarga del GitHub Release del proyecto (la misma fuente que «Actualizaciones»),
    // y si no está disponible se pasa a la descarga por componentes de dl.google.com. Aquí se puede poner la dirección de un espejo propio.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // Prefijo de espejo de GitHub (opcional, avanzado). Solo si tu red bloquea o limita GitHub Releases:
    // pon el prefijo de un espejo de confianza y las descargas pasarán por él (la suma SHA-256 se verifica siempre contra GitHub).
    // Vacío = directo (igual se prueba primero con 8 conexiones por bloques, que aprovechan el ancho de banda).
    mirrorPrefix: '',
    // Descargas en paralelo: conexiones de la descarga por bloques. Por defecto 8; con red débil/limitada se puede subir a 16.
    downloadConnections: 8,
    // Fuente de actualizaciones/descargas. Ahora solo GitHub; el campo se conserva por compatibilidad
    // con configuraciones anteriores.
    sourcePreference: 'github',
    // Probar automáticamente espejos públicos de GitHub. Desactivado y sin espejos predefinidos;
    // solo se usa el prefijo que configure el usuario.
    autoMirror: false,
    // (Campo heredado de una fuente de actualizaciones que ya no se usa.)
    // (Se ignora.)
  },
  sharedDir: path.join(os.homedir(), 'LanzadorAPKShared'),
  deviceSharedDir: '/sdcard/LanzadorAPKShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // Acceso en el menú Inicio = que la búsqueda de Windows encuentre la app
  shortcutDir: '',           // vacío = escritorio
  freeform: false,           // Comparte una sola ventana de runtime; ya no usa las ventanitas freeform de Android
  hideAfterLaunch: false,    // El proceso principal debe mantenerse; si sale, mata el runtime de Android
  notifyOnInstall: true,
  autoStart: true,           // Inicio automático con Windows, activado por defecto; el usuario no tiene que configurarlo
  autoDeploy: true,          // En el primer uso se completa toda la instalación automáticamente, ya no en 5 pasos
  // Tarjeta de bienvenida: lastDate guarda la fecha en que se mostró sola la última vez (abierta a mano, como mucho una vez al día),
  // disabled = el usuario marcó «no volver a mostrar».
  welcome: { lastDate: '', disabled: false },
  /**
   * Comprobación automática (depuración automática): revisa el estado del equipo periódicamente y envía la lista de problemas a la interfaz.
   * auto = si se ejecuta periódicamente; intervalMin = intervalo (minutos);
   * notify = muestra una notificación del sistema cuando aparece un «problema grave nuevo» (los conocidos no vuelven a molestar).
   */
  debug: { auto: true, intervalMin: 10, notify: true },
  display: {
    mode: 'window',          // window (ventana vertical, se puede estirar) | fullscreen (se ajusta a la pantalla)
    portrait: '900x1600',    // Resolución vertical del modo ventana; se puede ajustar en Configuración
    density: 0,              // 0 = se deduce de la resolución
    rememberBounds: true,    // Recuerda la posición/tamaño de la ventana de cada app
    autoFullscreenOnLaunch: false,
    // Horizontal = cambiar la pantalla física del AVD a 1280x720 y reiniciar (la única forma de tenerla derecha y llena).
    // Se guarda aquí; tras reiniciar LanzadorAPK se arranca con esta orientación.
    landscape: false,
    // Estrategia de orientación de la pantalla:
    //   auto      = cambia la pantalla física según la orientación que declara cada app (recomendado; solo así la imagen llena la ventana)
    //   landscape = fuerza la pantalla horizontal
    //   portrait  = fuerza la pantalla vertical
    // En modo auto, el campo landscape de arriba pasa a ser solo el hecho de «la orientación real actual de la pantalla»,
    // lo escribe restartForOrientation y ya no se usa como preferencia que sobrescriba la orientación de la app.
    orientationMode: 'auto',
    // Diseño de tableta: fija la densidad lógica del invitado en 190 dpi (720 de ancho → sw606dp ≥ 600 dp,
    // por encima del punto de corte de tableta de Android). Algunas apps solo muestran vistas a dos columnas con diseño de tableta,
    // y es el «modo tableta» que piden los usuarios. Desactivado vuelve a la densidad por defecto de la imagen (diseño de teléfono).
    tabletMode: true,
    // Modo de ventana: false = el emulador abre su propia ventana nativa (Qt renderiza directamente; orientación/escalado/entrada
    // los gestiona él, y los fotogramas y el arrastre responden al instante);
    // true = la imagen de Android se mete con SetParent en la ventana contenedora de LanzadorAPK (aspecto uniforme, con botones de
    // rotar/minimizar/maximizar/cerrar en la barra de título).
    // Desde 0.6.0 la ventana nativa es el valor por defecto: el modo incrustado tiene que reacomodar una ventana ajena en su área cliente,
    // y al escalar, rotar o cambiar de app pierde fotogramas, con bordes negros/coordenadas desplazadas/sin llenar;
    // esos problemas no tienen solución de raíz al incrustar, y la ventana nativa los evita por completo.
    // Los dos modos se siguen pudiendo elegir en Configuración (display.windowEmbed).
    windowEmbed: false,
    // Interruptor de «rotación automática» de la imagen: activado por defecto (escribe accelerometer_rotation=1 en el invitado);
    // la orientación de la pantalla la siguen decidiendo wm user-rotation lock + set-ignore-orientation-request,
    // sin que los sensores la tuerzan. Al desactivarlo se vuelve al bloqueo forzado anterior.
    autoRotate: true,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Quita un posible BOM UTF-8. Con BOM, JSON.parse lanza un error y toda la configuración
    // vuelve en silencio a los valores por defecto: el usuario vería que «se perdió toda la configuración» sin saber por qué.
    // Este archivo lo editan la configuración, herramientas de sincronización e incluso el usuario a mano; tiene que tolerar el BOM.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Estrategia de recursos → interruptores concretos.
 *   save     : 2 vCPU + prioridad baja + 540x960, para portátiles viejos / dejar apps abiertas;
 *   balanced : vCPU = la mitad de los núcleos físicos (2–4) + cede el primer plano + 720x1280;
 *   smooth   : vCPU sin límite + misma prioridad que el primer plano + 720x1280, prioridad a video y juegos.
 * La resolución no sube a 1080p por ahora: la huella de la instantánea quickboot depende de ella y cada cambio obliga a un arranque en frío, y 720p
 * en una ventana con proporción de teléfono no se distingue, pero rinde un nivel mejor.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,
  // Marca de la versión empaquetada para la Store (MSIX): main.js desactiva la autoactualización y omite instalar controladores de kernel que requieren administrador
  STORE_BUILD,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    /**
     * Desde 0.5.6 ya no hay backends de terceros: mode=mumu / fydeos / attach de configuraciones viejas,
     * o cualquier otro valor editado a mano, se trata como builtin y se borran los campos de terceros que queden.
     *
     * Solo se cambia el objeto en memoria al leer, sin escribir de inmediato en disco: el archivo de configuración es del usuario y se guarda
     * cuando él guarde la configuración; así no pasa que «abrir LanzadorAPK una vez le cambie el settings.json».
     */
    s.engine.mode = 'builtin';
    for (const k of ['mumuPath', 'mumuIndex', 'mumuRenderProfile', 'mumuMemoryGB', 'mumuCores', 'fydeosHost']) {
      delete s.engine[k];
    }
    // Las versiones antiguas corrían sin ventana por defecto: el proceso de la app arrancaba pero no había ventana en pantalla, equivalente a «no abre».
    // Se migra sin condiciones al modo con ventana y ya no se permite desactivarlo con configuraciones viejas.
    s.engine.headless = false;
    // Las versiones antiguas mataban todo el runtime de Android al salir de la capa contenedora, y los iconos del escritorio parpadeaban y se cerraban.
    s.hideAfterLaunch = false;
    // Las versiones antiguas usaban ventanitas freeform de Android; ahora toda la ventana del emulador es la ventana de la app,
    // y la app debe llenar esa pantalla; si no, aparecería «una ventanita dentro de la ventana».
    s.freeform = false;

    /**
     * Decisión final del modo de ventana: **por defecto debe ser la ventana nativa del emulador**.
     *
     * La 0.5.9 llegó a migrar a todos al modo incrustado, y la incrustación (SetParent + reacomodar
     * con SetWindowPos una y otra vez una ventana ajena) perdía fotogramas al escalar/rotar/cambiar de app, con bordes negros,
     * coordenadas desplazadas y sin llenar: el tipo de problema más reportado por los usuarios. La ventana nativa la dibuja y coloca
     * el propio emulador, sin esos problemas, así que se vuelve a ella por defecto.
     *
     * Aquí ya no basta con la «marca de migración»: mientras el usuario **no lo haya elegido activamente en Configuración**
     * (windowEmbedChosen lo escribe la configuración), el valor leído se corrige a nativo y se guarda en disco.
     * La forma anterior se desentendía en cuanto windowEmbedMigrated2 era true, así que en configuraciones viejas
     * windowEmbed:true seguía vigente: tras actualizar, el usuario seguía viendo la ventana contenedora
     * y creía que «el valor por defecto no cambió». El criterio solo es «si lo eligió activamente»; las demás marcas no cuentan.
     */
    try {
      const raw = readJson(SETTINGS_FILE, {});
      const d = (raw && raw.display) || {};
      if (d.windowEmbedChosen !== true && d.windowEmbed !== false) {
        s.display.windowEmbed = false;
        s.display.windowEmbedMigrated2 = true;
        // Se escribe de inmediato, para que el propio archivo de configuración vuelva a nativo; los demás campos del usuario se conservan tal cual.
        writeJson(SETTINGS_FILE, {
          ...raw,
          display: { ...d, windowEmbed: false, windowEmbedMigrated2: true },
        });
      }
    } catch (_) { /* Si la migración falla no afecta el arranque; se mantiene el valor leído */ }

    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // Si solo cambió la «estrategia de recursos», se traduce a los tres interruptores concretos, para que no haya dos configuraciones contradictorias
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    // Segunda defensa: pkg viene de un APK / apps.json analizado externamente y debe quedar dentro de la carpeta de datos.
    // Aunque haya registros dañados escritos por versiones anteriores, no pueden armar una ruta fuera de ICON_DIR (issue #2 P0-1).
    return path.join(ICON_DIR, `${safeFilePart(pkg)}.png`);
  },

  apkPath(pkg, version = 'cur') {
    const v = /^[A-Za-z0-9_-]+$/.test(String(version)) ? version : 'cur';
    return path.join(APK_DIR, `${safeFilePart(pkg)}-${v}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
