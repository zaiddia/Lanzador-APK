'use strict';
/**
 * Proceso principal de LanzadorAPK
 * Funciones: ventanas / bandeja / instancia única / reparto de la línea de comandos (doble clic en apk, inicio desde accesos directos) / IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');
const orientation = require('./core/orientation');

// Logo de marca (generado por build/render-logo.js); si falta se usa el icono anterior dibujado por código
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* Se usa el icono dibujado por código */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}

// La bandeja usa el «logo simplificado pequeño»: reducir el logo de 512 a 16 px lo dejaría borroso, sin textura ni texto
function loadTrayIcon() {
  try {
    const p = path.join(LOGO_DIR, 'tray-16.png');
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  } catch (_) { /* Se vuelve al icono dibujado por código */ }
  return nativeImage.createFromBuffer(drawAppIcon(16));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { KeymapEngine } = require('./core/keymap-engine');
const { PRESETS: KEYMAP_PRESETS } = require('./core/keymap');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater, findUninstaller } = require('./core/updater');
const leftovers = require('./core/leftovers');

// En Windows, con la ventana tapada, capturePage obtiene un fotograma viejo; las capturas automáticas necesitan desactivar el cálculo de oclusión
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * Si el disco del sistema está casi lleno, la caché propia de Chromium (Cache / GPUCache / Local Storage …)
 * se mueve al disco de la «carpeta de datos de Android».
 * Por defecto esa caché va en %APPDATA%\lanzadorapk; con solo unos cientos de MB libres en C hasta el arranque puede fallar,
 * y el usuario muchas veces ya movió los datos de Android a otro disco mientras la caché sigue ocupando C.
 * Hay que fijarlo antes de app ready; después no tiene efecto.
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* Si no cabe se deja el valor por defecto; no afecta el arranque */ }
}
relocateUserDataIfCrowded();

// La ventana de la app incrusta el emulador como hija con SetParent. Por defecto Chromium dibuja la página
// con capas semitransparentes de DirectComposition (Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP), que DWM compone a nivel de ventana
// y tapan directamente la ventana hija incrustada: el síntoma es «imagen totalmente negra aunque Android está corriendo».
// La interfaz contenedora solo tiene una barra de título de 38 px y la pantalla de carga; con composición por software va perfecto,
// y sin aceleración por hardware Chromium dibuja directamente en el HWND y el orden de las ventanas hijas funciona de verdad.
// Para comparar el efecto se puede iniciar con LANZADORAPK_HWACCEL=1.
if (process.env.LANZADORAPK_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * Registro ligero en archivo: empaquetado no hay consola; si hay un problema el usuario puede enviar app.log.
 * Solo se anotan puntos clave y excepciones; miles de líneas en la ruta normal no lo llenan.
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* Un fallo del registro no puede afectar el flujo principal */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));
// Al salir deja una línea con el código de salida: en salidas silenciosas (sin pila de fallo ni before-quit) permite distinguir
// «salida normal», «finalizado por el Administrador de tareas» y «terminado por el apagado del sistema».
process.on('exit', (code) => appLog(`process exit code=${code}`));

/**
 * Toma automática de la versión completa (runtime integrado):
 * el paquete de distribución trae runtime/ junto a LanzadorAPK.exe (emulator + platform-tools + AEHD + imagen compatible con ARM).
 * En el primer arranque (si aún no existe settings.json) runtime.dir apunta directamente ahí y se activa el modo compatible;
 * el usuario no descarga ni configura nada y funciona al instante. Después puede volver a la versión en línea en Configuración.
 */
/**
 * Carpeta del runtime incluida en el instalador (runtime/ junto al exe de la versión completa, o
 * app\resources\runtime del MSIX de Microsoft Store). No vacío = el emulador y la imagen son locales: la animación de arranque no debe hablar de
 * «descargar» y autoDeploy no debe usar internet.
 *
 * Debe declararse antes de bootstrapBundledRuntime(): esa función se ejecuta al cargar el módulo,
 * y declarar con `let` después chocaría con la TDZ (la asignación lanza un error, el catch lo oculta y la marca queda siempre vacía).
 */
let bundledRuntimeDir = null;

function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // La versión portátil pone el runtime junto al exe; portable de electron-builder descomprime los recursos en
    // resources/, al mismo nivel que el exe del proceso, así que se revisan varias ubicaciones candidatas.
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // El runtime incluido solo exige «emulator + cualquier imagen del sistema completa», sin versión de API fija:
    // la versión de un solo archivo puede traer una imagen AOSP más pequeña, y fijar API34 la haría pasar por «sin runtime».
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // En la versión de un solo archivo la imagen va comprimida (system.img.xz / .gz) y se descomprime en el primer arranque.
            // Aceptar aquí solo system.img haría que «el paquete trae la imagen» se tomara como que no la trae y se descargara de internet.
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // La versión anterior solo tomaba el control si no existía settings.json: si el usuario instaló antes la versión en línea y luego descomprimió la completa,
    // se quedaba siempre en el asistente de «faltan componentes». Ahora toma el control siempre que la carpeta del runtime actual no tenga emulator.
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    // «Runtime de otro instalador»: la ruta es <alguna carpeta>/resources/runtime pero no está bajo la carpeta de este EXE.
    // Solo puede venir de «descomprimir una versión portátil nueva mientras settings.json recuerda la ruta del paquete viejo»;
    // en pruebas las consecuencias eran muy ocultas: arranca el paquete nuevo, pero corren el emulator/imagen/instantánea de la versión anterior,
    // tras actualizar sigue lento, los parámetros de orientación son los viejos, y si se borra el paquete viejo ya no arranca.
    // Las carpetas que el usuario eligió (como D:\LanzadorAPKRuntime) no se ven afectadas por esta regla.
    const looksForeignBundle = /[\\/]resources[\\/]runtime$/i.test(current)
      && !path.resolve(current).toLowerCase().startsWith(path.resolve(exeDir).toLowerCase());
    if (looksForeignBundle && fs.existsSync(path.join(bundled, 'emulator', 'emulator.exe'))) {
      store.saveSettings({ runtime: { dir: bundled } });
      bundledRuntimeDir = bundled;
      appLog(`El directorio del runtime apunta a otro paquete (${current}); se usará el runtime incluido en el paquete ${bundled}`);
      return;
    }
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // Tras mover/actualizar la versión portátil (descomprimida en otra carpeta), settings sigue guardando la ruta vieja:
    // solo hay que aceptar «el runtime bajo la carpeta del EXE actual»; si no, se seguirían usando componentes del paquete viejo
    // (pasó en pruebas: el emulator del paquete viejo no tenía emulator-check → falla la detección de aceleración → vuelve a la emulación TCG).
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // Las carpetas que eligió el usuario (fuera de la carpeta del EXE, como D:\LanzadorAPKRuntime u otro disco)
    // siempre se respetan: puede ser para ahorrar espacio en C o para que varias versiones portátiles compartan un runtime.
    // La versión anterior siempre la sobrescribía aquí con el runtime incluido junto al exe; el síntoma era
    // «cambié la carpeta de datos del runtime en Configuración y sigue descargando en la carpeta vieja / AppData» (issue #23).
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // Si ya hay un runtime utilizable (incluida la versión en línea) se respeta: los datos de usuario del AVD están en esa carpeta y no se pueden mover a escondidas
    if (currentOk) {
      // El runtime está bajo la carpeta del EXE = viene con el instalador (versión completa / Store)
      bundledRuntimeDir = current;
      // Pero igual se activan los parámetros automáticos; los 4 GB/4 núcleos fijos/modos de GPU obsoletos de configuraciones viejas no pueden seguir usándose
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // Solo se activa el modo compatible si el paquete trae la imagen Google Play; la imagen AOSP trae librerías x86_64 nativas
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* Se ignora */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
    bundledRuntimeDir = bundled;
  } catch (_) { /* Si falla la toma no se bloquea el arranque; se usa la guía en línea */ }
}
bootstrapBundledRuntime();

// En escenarios automatizados como las capturas de prueba se omite la detección del registro (para no depender de reg.exe)
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.LANZADORAPK_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// «Qué ventanas son nuestras» se asigna en whenReady (ver agentScope). Va a nivel de módulo porque
// runLaunch / el temporizador de precalentamiento se definen antes de ese código, y un const de esa clausura no se vería desde su ámbito.
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

/**
 * El estado de la ventana de la animación de arranque va a nivel de módulo.
 *
 * Antes estaba dentro del callback de app.whenReady() (const splashWin/splashDone), y
 * runLaunch() / autoDeploy() se definen en un ámbito más externo: su
 * `typeof splashDone === 'function'` siempre era false, así que:
 *   - el texto de progreso nunca se actualizaba (siempre «Preparando…»);
 *   - tras un arranque exitoso la splash nunca se cerraba, y la ventana alwaysOnTop de 480x360 quedaba fija
 *     en el centro de la pantalla, encima de la imagen de Android.
 * Ese era el «al abrir una app aparecen varias ventanas» que reportaban: ventana principal/splash/ventana de app a la vez.
 * Al subirlo a nivel de módulo, estas llamadas por fin funcionan.
 */
let splashWin = null;
let splashProgress = () => {};
let splashDone = () => {};

// ---------------- Interpretación de la línea de comandos ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron mete sus propias opciones y la ruta de la app en argv; solo se aceptan nombres de paquete con la forma com.foo.bar
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium decodifica WebP y nativeImage no; con una ventana oculta se convierte el icono del APK a PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** Inicio automático: activado por defecto, sin que el usuario tenga que marcarlo en Configuración */
function applyAutoStart() {
  if (!app.isPackaged) return; // En desarrollo no se escribe en el registro
  const on = !!store.getSettings().autoStart;
  try {
    // Hay que indicar name explícitamente; si no, la entrada de inicio en el registro se llamaría "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'LanzadorAPK',
      path: process.execPath,
      args: ['--autostart'],
    });
    // Se borra la que dejaron versiones anteriores (sin name), para no iniciar dos veces
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* Si una directiva de grupo lo prohíbe, se ignora */ }
}

// ---------------- Modo de visualización: pantalla completa adaptable / ventana vertical ajustable ----------------

function displaySettings() { return store.getSettings().display || {}; }

/**
 * Identidad de la barra de tareas / notificaciones de Windows.
 *
 * Por qué cambia según la app: el acceso directo de cada app Android tiene su propio AUMID
 * (`zaiddia.LanzadorAPK.<paquete>`, ver installer.createShortcut), y el icono del acceso directo
 * es **el icono de esa app**. Windows solo une la ventana en ejecución y el anclaje de la barra de tareas en un mismo botón,
 * usando el icono del acceso directo, cuando «el AUMID del proceso == el AUMID del acceso directo».
 * Si no coinciden aparece «el anclaje tiene el icono de la app, pero la barra de tareas muestra aparte un icono de LanzadorAPK».
 *
 * La recomendación oficial es llamar a setAppUserModelId una sola vez; en la práctica afecta a las ventanas **creadas después** (shells como VS Code,
 * que ejecutan varias apps en un proceso, lo hacen así). Aquí solo se cambia antes de abrir una ventana y todo va en try/catch:
 * si alguna versión de Windows lo ignora, solo se muestra con el icono del exe, sin afectar las funciones.
 */
const APP_AUMID = 'zaiddia.LanzadorAPK';
function setAumid(id) {
  try { app.setAppUserModelId(String(id || APP_AUMID).slice(0, 128)); } catch (_) { /* Se ignora fuera de Windows o en versiones antiguas */ }
}

/**
 * ¿Esta app debe usar la pantalla horizontal o la vertical?
 *
 * La pantalla física del emulador (hw.lcd) es la «forma real» de la imagen; Android no gira toda la pantalla
 * por una app con otra orientación: solo le da una franja estrecha tipo buzón
 * en el centro, con bordes negros. Por eso la única forma de «llenar la ventana» es: orientación de la pantalla = orientación de la app.
 *
 * Prioridad: modo forzado de la configuración > sustitución manual de cada app > orientación natural del manifiesto del APK
 * > orientación actual de la pantalla (si la app declara seguir la gravedad, no se reinicia para nada).
 */
function wantLandscapeFor(pkg) {
  const ds = displaySettings();
  const app = pkg ? store.getApp(pkg) : null;
  return orientation.resolveLandscape({
    mode: ds.orientationMode || 'auto',
    orientation: app && app.orientation,
    orientationOverride: app && app.orientationOverride,
    panelLandscape: !!ds.landscape,
  });
}

/**
 * Punto de entrada único para rotar la app actual: calcula la orientación objetivo → escribe la sustitución por app → reinicia la pantalla.
 *
 * Antes el botón de la barra de título, el menú de la bandeja y Ctrl+R calculaban cada uno «la siguiente orientación», con bases distintas
 * (uno miraba display.landscape, otro appWin.state.landscape). Al pulsar rotar,
 * el valor guardado en apps.json podía quedar justo al revés que la orientación real a la que se cambiaba, y al siguiente inicio
 * wantLandscapeFor lo volvía a invertir: esa era la causa de raíz de «no hay forma de poner la app en horizontal».
 * Ahora la única base es wantLandscapeFor(pkg); se invierte y a la vez se escribe la sustitución + se cambia la pantalla.
 */
async function rotateCurrentApp() {
  const pkg = appWin && appWin.pkg;
  const current = pkg ? wantLandscapeFor(pkg) : !!displaySettings().landscape;
  const next = orientation.flipLandscape(current);
  if (pkg) {
    store.upsertApp({ package: pkg, orientationOverride: orientation.overrideValue(next) });
    appLog(`orientation override ${pkg} = ${orientation.overrideValue(next)}`);
  }
  // appWin.rotate actualiza el estado de la barra de título y ajusta la ventana; recibe el next unificado como orientación objetivo,
  // y por dentro llama a restartForOrientation para cambiar la pantalla (un solo reinicio).
  if (appWin && appWin.isOpen) {
    await appWin.rotate((want) => restartForOrientation(want, { reloadApp: false }), next).catch(() => {});
  } else {
    await restartForOrientation(next, { reloadApp: false }).catch(() => {});
  }
  return { ok: true, landscape: next };
}

/**
 * «Aprende» en ejecución la orientación real de la app.
 *
 * El análisis sin conexión del AndroidManifest basta para muchas apps (decenas de Activities con portrait fijo),
 * pero algunas declaran todo como sensor / fullSensor y el manifiesto no muestra preferencia. En ese caso se espera a que
 * corra de verdad y se le pregunta una vez a Android (el requestedOrientation de ActivityRecord es el valor final que el sistema
 * calcula según lo que pide la app). Lo aprendido se guarda en apps.json y en el próximo inicio se elige bien la pantalla.
 */
async function learnAppOrientation(pkg) {
  const app = store.getApp(pkg);
  if (!app || app.orientation || app.orientationOverride) return null;
  let out = '';
  try {
    out = await runtime.client().shell(
      'dumpsys activity activities | grep -m1 requestedOrientation', { timeout: 8000 });
  } catch (_) { return null; }
  const s = String(out || '');
  let value = null;
  if (/requestedOrientation=SCREEN_ORIENTATION_(PORTRAIT|SENSOR_PORTRAIT|REVERSE_PORTRAIT|USER_PORTRAIT)/.test(s)) value = 'portrait';
  else if (/requestedOrientation=SCREEN_ORIENTATION_(LANDSCAPE|SENSOR_LANDSCAPE|REVERSE_LANDSCAPE|USER_LANDSCAPE)/.test(s)) value = 'landscape';
  if (!value) return null;
  store.upsertApp({ package: pkg, orientation: value });
  appLog(`learned orientation ${pkg} = ${value}`);
  return value;
}

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** La inyección de rueda necesita la resolución del lado de Android; se guarda una vez y se invalida al rotar/reiniciar el runtime */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* El runtime aún no arrancó */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** Tras cambiar los botones del ratón en Configuración, se sincroniza enseguida la configuración del gancho según el foco actual */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * Rotar = cambiar el tamaño de la pantalla física y reiniciar el emulador.
 *
 * Es la única forma de tener la horizontal «derecha y llena» (se probaron los tres caminos equivocados):
 *   - wm size: solo cambia la resolución lógica; el LCD físico sigue vertical -> imagen acostada 90° en una franja arriba a la izquierda;
 *   - wm density: el tamaño del framebuffer no cambia -> la imagen no llena y al maximizar queda un gran espacio vacío a la derecha;
 *   - adb emu rotate: solo gira el contenido de la imagen; el sistema sigue en vertical.
 * solo cambiando hw.lcd.width/height a horizontal y reiniciando Qt abre la ventana con pantalla horizontal y la imagen sale derecha y llena.
 */
async function restartForOrientation(landscape, { reloadApp = true } = {}) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Cambiando a horizontal: reiniciando el runtime de Android…' : 'Volviendo a vertical: reiniciando el runtime de Android…');
  try {
    // El reinicio destruye la ventana del emulador y crea otra. Mientras tanto la pantalla no puede quedar vacía:
    // en modo de ventana independiente primero se muestra la ventana contenedora con un aviso (openDetached la oculta cuando se engancha la nueva).
    try {
      appWin.showWaiting(landscape
        ? 'Cambiando a horizontal (reinicia Android, unos 40 s, solo una vez)…'
        : 'Volviendo a vertical (reinicia Android, unos 40 s, solo una vez)…');
    } catch (_) { /* La ventana pudo cerrarse recién */ }
    // Primero se desprende la ventana incrustada, para que el reinicio no deje una ventana negra en el escritorio
    try { await appWin.agent.detach(); } catch (_) { /* ignore */ }
    await runtime.stop({ graceful: false }).catch(() => {});
    /**
     * Se espera a que adb realmente deje de ver este dispositivo y luego se relanza.
     *
     * Entre que sale el proceso del emulador y adb actualiza su estado hay cientos de milisegundos: en ese lapso
     * `adb -s emulator-5554 get-state` sigue respondiendo "device". Si se llamara a ensure() enseguida,
     * isOnline() concluiría «runtime listo (reused)» y volvería al instante,
     * pero cada comando adb siguiente daría `device 'emulator-5554' not found`:
     * así se rompía toda la cadena de arranque al cambiar la orientación (probado: «listo» en 0,2 s y luego todo fallaba).
     */
    try {
      const c = runtime.client();
      for (let i = 0; i < 14; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const online = await c.isOnline().catch(() => false);
        if (!online) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (_) { /* Si la comprobación falla se sigue igual; ensure tiene su propio respaldo */ }
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) { appWin.waitingForRestart = false; return false; }
    // Aquí **ya no** se espera la red. El WiFi de un emulador recién reiniciado tarda más de 20 s en estar listo, y quien llama
    // (beforeStart del launcher → installer.launch) enseguida vuelve a pasar por waitForNetwork;
    // las dos esperas solo se sumaban: en pruebas, al cambiar la orientación la primera esperaba en vano 25 s hasta agotarse y la segunda otros 23 s,
    // y un cambio de orientación pasaba de 100 s a 125 s. Basta con que el flujo de launch espere una sola vez.
    if (reloadApp && pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
      await attachAppWindow();
      appWin.scheduleFit(6);
    }
    // Devuelve el rt nuevo: beforeStart lo recibe y sustituye al anterior (el client anterior dejó de servir con stop)
    return rt;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    try { appWin.waitingForRestart = false; } catch (_) { /* La ventana ya se destruyó */ }
    return false;
  }
}

/**
 * Lleva la imagen de Android ante los ojos del usuario. Dos modos:
 *   - ventana nativa (por defecto): el emulador abre su propia ventana y gestiona orientación, escalado y entrada,
 *     sin los bordes negros, coordenadas desplazadas, falta de llenado ni pérdida de fotogramas propios de la incrustación;
 *   - incrustada: con SetParent dentro de nuestra ventana, aspecto uniforme y botón de rotación en la barra de título.
 *   Lo controla la opción display.windowEmbed (solo true es incrustada).
 */
async function attachAppWindow() {
  if (!appWin) return false;
  const embedMode = displaySettings().windowEmbed === true;
  if (!embedMode) {
    /**
     * La toma de la ventana nativa debe reintentarse.
     *
     * El momento en que la ventana del emulador aparece en el sistema no coincide con el retorno de `am start`:
     * tras un arranque en frío, una restauración de instantánea o un cambio de orientación de la pantalla, la ventana Qt suele hacerse visible
     * varios cientos de milisegundos o uno o dos segundos después. Antes se probaba una sola vez y, si fallaba, no se hacía nada: la página de espera
     * «Iniciando» de la ventana contenedora quedaba en pantalla, el usuario veía «sigue saliendo esa ventana decorada vuestra»,
     * y la imagen nunca se enganchaba (en el registro: attach failed (detached): unknown).
     */
    for (let i = 0; i < 4; i += 1) {
      if (!appWin.isOpen) {
        appLog(`attach detached: la ventana contenedora se cerró (ronda ${i + 1})`);
        return false;
      }
      // eslint-disable-next-line no-await-in-loop
      const ok = await appWin.openDetached().catch((e) => {
        appWin.lastEmbedError = (e && e.message) || 'threw';
        return false;
      });
      if (ok) return true;
      appLog(`attach detached #${i + 1} falló: ${appWin.lastEmbedError || 'unknown'}`);
      // La espera se alarga en cada ronda: show/layout del agente de ventanas también pueden coincidir con una recreación de la ventana
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 400 + i * 600));
    }
    // Si en cuatro rondas no aparece (escritorio remoto / problema del controlador gráfico / emulador lanzado con --no-window):
    // en vez de dejar una pantalla negra o una página de espera que gira para siempre, mejor enganchar la imagen incrustada
    // y decirle claramente al usuario que es un respaldo; el próximo arranque sigue priorizando la ventana nativa.
    appLog('attach detached: fallaron todos los reintentos, se vuelve temporalmente al modo incrustado');
    const fallback = await appWin.embed().catch(() => false);
    if (fallback) {
      try {
        send('toast', { type: 'info', message: 'La ventana nativa del emulador no se mostró; esta vez la imagen se muestra en la ventana integrada' });
      } catch (_) { /* La ventana principal puede estar cerrada */ }
    }
    return fallback;
  }
  const ok = await appWin.embed().catch(() => false);
  if (!ok) {
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
  }
  return ok;
}

/**
 * Abre (o reutiliza) la ventana de «una app, una ventana limpia».
 *
 * Al cambiar de app hay que cerrar de verdad la app **anterior**; si no, pasa lo que reportaban los usuarios:
 * «abro una segunda app y la primera no responde / ANR»:
 *   - en appWin.open() la ventana vieja se cierra con close({keepApp:true}), que solo cierra la ventana
 *     **y no llama a endApp, así que el proceso de la app vieja ni recibe force-stop ni sale de
 *     runtime._activeApps;
 *   - cuando la nueva app hace beginApp, `first = _activeApps.size === 0` da mal,
 *     y toda la lógica de prioridad / instantáneas se desordena;
 *   - dos apps compiten por el primer plano del mismo emulador → la vieja se cuelga y muestra ANR.
 * Por eso aquí primero se espera (await) a que la app vieja se detenga del todo y luego se abre la ventana nueva.
 */
async function openAppWindow(pkg, tip) {
  // Solo «cambiar a otra app» obliga a cerrar la anterior; pulsar otra vez la misma usa la ruta de reutilización, sin interrumpir.
  if (currentAppPkg && currentAppPkg !== pkg && appWin && appWin.isOpen) {
    const prev = currentAppPkg;
    try {
      // Primero se desprende la imagen y luego se detiene el proceso: en modo de ventana independiente la ventana nativa del emulador es la que el usuario está viendo,
      // y park la oculta para que al destruir el anfitrión no quede una ventana negra en el escritorio.
      await appWin.close({ keepApp: true });
      await runtime.endApp(prev, { onIdle: onContainerActive }).catch(() => {});
      appLog(`switch: closed ${prev} before launching ${pkg}`);
    } catch (e) {
      appLog(`switch close ${prev} failed: ${e && e.message}`);
    }
  } else if (currentAppPkg && currentAppPkg !== pkg) {
    // La ventana ya no existe, pero el proceso puede seguir en _activeApps; también hay que cerrarlo.
    await runtime.endApp(currentAppPkg).catch(() => {});
  }
  const rec = store.getApp(pkg);
  const land = wantLandscapeFor(pkg);
  const p0 = portraitSize();
  const detached = displaySettings().windowEmbed === false;
  // La orientación de la pantalla no coincide con la de la app → beforeStart reinicia el runtime una vez (unos 40 s).
  const willRestart = land !== !!displaySettings().landscape;
  // En modo de ventana independiente la ventana contenedora normalmente no se muestra, pero **durante la espera** hay que darle al usuario algo visible:
  //   - si hay animación de arranque (primer inicio), se encarga ella;
  //   - sin animación (cambio de app) hay que mostrar la ventana contenedora; si no, el escritorio pasa 40 s sin nada
  //     y el usuario cree que el programa falló.
  const splashVisible = !!(splashWin && !splashWin.isDestroyed());
  const label = (rec && rec.label) || pkg;
  // Primero se cambia la identidad a la de esta app y luego se abre la ventana: así la barra de tareas usa el icono de la app del acceso directo
  setAumid(`${APP_AUMID}.${pkg}`);
  appWin.open({
    pkg,
    label,
    iconPath: rec && rec.icoPath,
    // En horizontal la ventana se abre con proporción horizontal; si no, una imagen horizontal en una ventana vertical deja grandes bordes negros
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    // La pantalla completa llega por dos vías: se eligió el modo «pantalla completa», o se marcó «pantalla completa al iniciar».
    // Lo segundo era antes un interruptor muerto (solo declarado en la configuración por defecto, sin código que lo leyera); aquí se completa.
    fullscreen: displaySettings().mode === 'fullscreen'
      || displaySettings().autoFullscreenOnLaunch === true,
    detached,
    showWhileWaiting: detached && !splashVisible,
  });
  appWin.setIcon(rec && rec.icoPath);
  // Al abrir se inicializa con la orientación guardada (la orientación de la pantalla física se decide en doctor.lcdFor)
  appWin.setState({
    // Si hay que reiniciar para cambiar la pantalla, se explica «por qué es lento» en el aviso, para que el usuario no adivine frente a 40 s de pantalla vacía
    tip: willRestart
      ? `Cambiando «${String(label).slice(0, 20)}» a ${land ? 'horizontal' : 'vertical'} (reinicia Android, unos 40 s, solo una vez)…`
      : (tip || 'Iniciando el runtime de Android…'),
    ready: false,
    landscape: land,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    // En modo de ventana independiente la imagen está en la ventana nativa del emulador; maximizar la ventana contenedora no tiene efecto visible,
    // solo appWin.toggleMaximize extiende/restaura la ventana del emulador.
    if (displaySettings().windowEmbed === false) {
      appWin.toggleMaximize().catch(() => {});
    } else if (full) appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit(6);
    // Ojo: aquí **ya no** se cambia de paso la orientación de la pantalla.
    // Pantalla completa y horizontal son cosas distintas: la orientación de la pantalla la decide ahora «la orientación que declara la propia app»
    // (ver wantLandscapeFor). Antes F11 reiniciaba también el runtime para pasar a horizontal, y las apps verticales
    // quedaban dentro de una pantalla horizontal → bordes negros a los lados → el usuario creía que «la pantalla completa no funcionó».
  }
  return next.display.mode;
}

/**
 * Primer inicio con poco espacio: si el disco de los datos (normalmente C:) no alcanza para Android
 * y hay otro disco con bastante más espacio, se ofrece usarlo ANTES de descargar o descomprimir nada.
 * Solo se pregunta una vez, solo si el usuario no eligió carpetas y todavía no existe ningún AVD
 * (así nunca se mueven datos ya creados). Si dice que no, todo sigue igual que antes.
 */
async function maybeSuggestRoomierDisk() {
  try {
    const s = store.getSettings();
    const r = s.runtime || {};
    if (r.diskChoiceAsked || r.installed || String(r.avdDir || '').trim()) return;
    const diskspace = require('./core/diskspace');
    const p = runtime.provisioner.paths();
    if (fs.existsSync(path.join(p.avdHome, 'lanzadorapk.avd'))) return;
    const ownRuntime = !bundledRuntimeDir && !String(r.dir || '').trim()
      && !fs.existsSync(path.join(p.root, 'emulator', 'emulator.exe'));
    // Lo que va a ocupar: datos de Android (partición + instantánea) ~10 GB; con el runtime descargado, +6 GB en el pico de instalación
    const needMB = (ownRuntime ? 6 * 1024 : 0) + 10 * 1024;
    const curFree = require('./core/doctor').freeDiskMB(store.DATA_DIR);
    // Si el disco actual alcanza con holgura no se recorren las demás unidades (evita esperar por unidades de red desconectadas)
    if (!curFree || curFree >= needMB + 5120) return;
    const best = diskspace.pickRoomierDrive({ currentDir: store.DATA_DIR, needMB, drives: diskspace.listDrives() });
    if (!best) return;
    const curDrive = diskspace.driveOf(store.DATA_DIR) || 'el disco del sistema';
    const base = path.join(best.root, 'LanzadorAPK');
    const detail = [
      `Android necesita unos ${Math.round(needMB / 1024)} GB libres y en ${curDrive} quedan ${(curFree / 1024).toFixed(1)} GB.`,
      `El disco ${best.drive} tiene ${(best.freeMB / 1024).toFixed(1)} GB libres.`,
      '',
      `Si aceptas, se guardarán en ${base}:`,
      '  • los datos de Android (apps instaladas, almacenamiento e instantánea)',
      ownRuntime ? '  • el runtime de Android que se descarga la primera vez' : null,
      '',
      'Puedes cambiarlo cuando quieras en Configuración → Integración con el sistema.',
    ].filter((l) => l !== null).join('\n');
    store.saveSettings({ runtime: { diskChoiceAsked: true } });
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Lanzador APK',
      message: `Poco espacio en ${curDrive}. ¿Guardar los datos de Android en ${best.drive}?`,
      detail,
      buttons: [`Usar ${best.drive}`, `Seguir en ${curDrive}`],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) {
      appLog(`disk suggestion declined (${best.drive})`);
      return;
    }
    const avdDir = path.join(base, 'android-data');
    fs.mkdirSync(avdDir, { recursive: true });
    const patch = { runtime: { avdDir } };
    if (ownRuntime) {
      const rtDir = path.join(base, 'runtime');
      fs.mkdirSync(rtDir, { recursive: true });
      patch.runtime.dir = rtDir;
    }
    store.saveSettings(patch);
    try { runtime.provisioner.invalidateEnvCache?.(); } catch (_) { /* ignore */ }
    appLog(`disk suggestion accepted: avdDir=${avdDir}${patch.runtime.dir ? ` runtime=${patch.runtime.dir}` : ''}`);
  } catch (e) {
    appLog(`disk suggestion failed: ${e.message}`);
  }
}

/** En la primera ejecución se instalan adb / emulator / imagen del sistema de una vez, ya no en 5 pasos */
let deploying = false;
async function autoDeploy({ force = false } = {}) {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  // Espera tras fallos de descarga: antes, mientras checkEnv() detectara componentes faltantes, cada inicio de LanzadorAPK volvía
  // a bajar el paquete del runtime de 1,5 GB, y el usuario veía «descarga una y otra vez».
  // Tras un fallo se anota una marca de tiempo y durante 30 minutos no se reintenta solo; cuando el usuario pulsa «Completar con un clic»
  // force=true permite reintentar enseguida. El éxito o el forzado manual borran la espera.
  const COOLDOWN_MS = 30 * 60 * 1000;
  const lastFail = Number(store.getSettings().runtime.deployFailedAt || 0);
  if (!force && lastFail && Date.now() - lastFail < COOLDOWN_MS) {
    appLog(`autoDeploy en espera (último fallo: ${new Date(lastFail).toISOString()}); se omite el reintento automático`);
    return { ok: false, error: 'cooldown', cooldown: true, until: lastFail + COOLDOWN_MS };
  }
  deploying = true;
  const progress = (p) => {
    send('provision:progress', { ...p, component: p.component || 'all' });
    // Se envía también a la ventana de la animación de arranque
    if (typeof splashProgress === 'function') splashProgress(p);
  };
  let succeeded = false;
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // Runtime incluido en el paquete (instalador completo / versión de Microsoft Store): **nunca usa internet**.
    // La imagen ya está en el paquete (comprimida) y engine.ensure() la descomprime en el sitio en el primer arranque;
    // descargar otros 1,5 GB aquí sería un desperdicio, justo la queja de «ya instalé y sigue descargando la imagen».
    if (bundledRuntimeDir && env.adb.ok && env.emulator.ok && env.sysimg.ok) {
      appLog(`autoDeploy omitido: el runtime viene incluido en el paquete (${bundledRuntimeDir}), no hace falta internet `
        + (env.needsExtract ? '; la imagen se descomprimirá localmente en el primer arranque' : ''));
      // Esto es un **éxito**, no un fallo. Antes aquí se hacía return sin poner succeeded, y finally lo escribía
      // como fallo en deployFailedAt: en los equipos con runtime incluido se registraba cada 30 minutos
      // un «fallo de instalación»; el «último fallo: …» del registro venía en realidad de una omisión normal,
      // y el usuario no entendía el «reintentar instalación» de la configuración.
      succeeded = true;
      return { ok: true, source: 'bundled', needsExtract: !!env.needsExtract };
    }
    if (bundledRuntimeDir && !env.emulator.ok) {
      appLog(`autoDeploy omite la descarga: el directorio del runtime viene incluido (${bundledRuntimeDir}); pasa al diagnóstico`);
      // Pasar al diagnóstico tampoco es «fallo de descarga»; no se entra en espera.
      succeeded = true;
      return { ok: false, error: 'bundled', bundled: true };
    }
    // La versión ligera usa primero «el paquete del runtime en el GitHub del proyecto»: un solo archivo con emulator + imagen del sistema,
    // y la fuente de descarga coincide con la de actualizaciones en GitHub.
    // Si no se obtiene el paquete (sin red / el archivo aún no se publicó / límite alcanzado / sin suma SHA-256) se instalan los componentes uno por uno desde la fuente oficial.
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Descargando el runtime desde GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) {
          succeeded = true;
          return { ok: true, source: 'github' };
        }
        progress({ message: 'El paquete del runtime está incompleto; se completará desde la fuente oficial…' });
      } catch (e) {
        // Sin espacio en disco la fuente oficial fallaría igual (y bajaría otro 1,4 GB a medias): se para aquí con el motivo real.
        if (e && e.code === 'DISK_FULL') {
          progress({ message: e.message });
          return { ok: false, error: e.message, code: 'DISK_FULL' };
        }
        progress({ message: `Runtime de GitHub no disponible (${e.message}); se usará la fuente oficial…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Preparando adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Preparando el runtime de Android…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Preparando la imagen del sistema Android…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    succeeded = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    return { ok: succeeded };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Solo un «fallo real» entra en espera; una instalación exitosa borra el registro de fallos anterior.
    try {
      store.saveSettings({ runtime: { deployFailedAt: succeeded ? 0 : Date.now() } });
    } catch (_) { /* Si no se puede escribir la configuración no afecta este resultado */ }
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** Copia recursivamente el contenido de una carpeta (lo posible, sin borrar el origen; para mover una vez los archivos viejos al cambiar la ruta de la carpeta compartida) */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* Un fallo en un archivo no afecta al resto */ }
  }
}

/** Activa con permisos de administrador una característica opcional de Windows (como VirtualMachinePlatform / HypervisorPlatform) */
/**
 * Activa con elevación una característica opcional de Windows.
 *
 * Devuelve { ok, cancelled, code, feature }:
 *   cancelled usa 1223 (ERROR_CANCELLED) para distinguir «el usuario pulsó No en el UAC» de «falló de verdad»;
 *   antes ambos eran ok:false y la interfaz solo podía decir «no se pudo activar», sin que el usuario supiera que había cancelado.
 */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)}); exit $p.ExitCode } `
      + 'catch { exit 1223 }';
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({
      ok: code === 0, cancelled: code === 1223, restart: true, code, feature,
    }));
    proc.on('error', () => resolve({ ok: false, feature, error: 'No se pudo iniciar PowerShell' }));
  });
}

/**
 * Activa el WHPX integrado en el sistema (Windows Hypervisor Platform).
 *
 * Ojo: la función que de verdad permite al emulador de Android usar WHPX se llama
 * **«Plataforma del hipervisor de Windows» (HypervisorPlatform)**;
 * «Plataforma de máquina virtual» (VirtualMachinePlatform) es la de WSL2, y activar solo esa no deja usar WHPX.
 * Se activan las dos una vez, para cubrir diferencias entre equipos (primero la que realmente hace falta).
 *
 * Tampoco se usa ya la existencia de WinHvPlatform.dll como interruptor: esa DLL ya viene en los Windows modernos
 * (probado: en este equipo WinHvPlatform.dll existe, pero se usa AEHD); usarla para decidir «si se puede activar WHPX»
 * solo dejaría fuera a los equipos que de verdad necesitan activarlo.
 */
async function enableWhpxFeatures() {
  const steps = [];
  for (const f of ['HypervisorPlatform', 'VirtualMachinePlatform']) {
    // eslint-disable-next-line no-await-in-loop
    steps.push(await enableWindowsFeature(f));
  }
  return { ok: steps.some((s) => s.ok), cancelled: steps.every((s) => s.cancelled), steps };
}

/** Texto de guía manual exclusivo de la versión de la Store: los paquetes MSIX van fijos en mediumIL y normalmente no obtienen elevación */
const MSIX_ACCEL_HINT = 'La versión de la Store no puede pedir permisos de administrador. Actívalo manualmente una vez: '
  + 'Pulsa Win+R → escribe optionalfeatures → marca «Plataforma del hipervisor de Windows» '
  + '(HypervisorPlatform, la que realmente necesita WHPX); acepta y reinicia el equipo.';

// ---------------- Ventana principal ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: Number(process.env.LANZADORAPK_WIN_W) || 1140,
    height: Number(process.env.LANZADORAPK_WIN_H) || 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // En las pruebas de humo los errores del proceso de interfaz salen por stdout: si la interfaz queda en blanco o un botón no responde,
  // casi siempre es una excepción en app.js tras cambiar algún id, que en ejecución normal no se ve.
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // Los enlaces externos siempre van al navegador del sistema (GitHub, etc.); nunca se navega fuera con la ventana de la app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('Lanzador APK sigue ejecutándose en segundo plano', 'Haz clic en el icono de la bandeja para volver a abrirlo; clic derecho para salir.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  // Volver a la ventana principal = volver a la identidad propia de LanzadorAPK (si no, la barra de tareas seguiría con el icono de la app anterior)
  setAumid(APP_AUMID);
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- Comprobación automática (depuración automática) ----------------

/**
 * Comprobación automática = revisar periódicamente el estado real del equipo y enviar a la interfaz una «lista de problemas».
 *
 * Tres principios (cada uno aprendido de un error ya vivido):
 *  1) recolectar y evaluar por separado: la recolección está en src/core/autodebug-probe.js (llama comandos del sistema),
 *     la evaluación en src/core/autodebug.js (funciones puras, probables).
 *  2) fallo de detección ≠ problema: si no se obtiene el estado queda vacío y la evaluación lo toma como «no se sabe»;
 *     nunca se inventa algo «para tener qué reportar». Un falso aviso y el usuario deja de confiar.
 *  3) solo molestar al usuario cuando «aparece un problema nuevo»: los viejos ya se avisaron,
 *     mostrar ventanas en cada ronda es ruido; lo recuperado solo se anota en silencio.
 */
let autodebugState = { issues: [], summary: null, at: 0, running: false };
let autodebugTimer = null;
let autodebugBusy = false;

function autodebugConfig() {
  const d = (store.getSettings() || {}).debug || {};
  const intervalMin = Number(d.intervalMin);
  return {
    auto: d.auto !== false,
    intervalMin: [1, 5, 10, 30, 60].includes(intervalMin) ? intervalMin : 10,
    notify: d.notify !== false,
  };
}

async function runAutodebug({ force = false } = {}) {
  if (autodebugBusy) return autodebugState;
  const cfg = autodebugConfig();
  if (!force && !cfg.auto) return autodebugState;
  autodebugBusy = true;
  send('autodebug:state', { ...autodebugState, running: true });
  try {
    const autodebug = require('./core/autodebug');
    const probe = require('./core/autodebug-probe');
    const obs = await probe.collect({ runtime, store, doctor: require('./core/doctor') });
    const issues = autodebug.evaluate(obs);
    const summary = autodebug.summarize(issues);
    const { added } = autodebug.diff(autodebugState.issues, issues);
    autodebugState = { issues, summary, at: Date.now(), running: false };
    send('autodebug:state', autodebugState);
    if (cfg.notify) {
      // Solo avisa de un «error nuevo»: warn/info quedan para verlos en la configuración, sin interrumpir al usuario.
      const fresh = added.filter((i) => i.severity === 'error');
      if (fresh.length) {
        const text = fresh.map((i) => i.title).join(';');
        send('toast', { type: 'error', message: `La comprobación automática encontró problemas nuevos: ${text} (Configuración → Diagnóstico y reparación)` });
        notify('La comprobación automática encontró problemas nuevos', `${text}. Abre «Configuración → Diagnóstico y reparación» en Lanzador APK para resolverlo con un clic.`);
        appLog(`autodebug new issues: ${fresh.map((i) => i.code).join(',')}`);
      }
    }
    return autodebugState;
  } catch (e) {
    // Un fallo de la propia comprobación no puede afectar el flujo principal: se anota en el registro y se reintenta en la siguiente ronda.
    appLog(`autodebug failed: ${e && e.message}`);
    autodebugState = { ...autodebugState, running: false, error: String((e && e.message) || e) };
    send('autodebug:state', autodebugState);
    return autodebugState;
  } finally {
    autodebugBusy = false;
  }
}

function scheduleAutodebug() {
  if (autodebugTimer) {
    clearInterval(autodebugTimer);
    autodebugTimer = null;
  }
  const cfg = autodebugConfig();
  if (!cfg.auto) return;
  autodebugTimer = setInterval(() => {
    runAutodebug().catch(() => {});
  }, cfg.intervalMin * 60 * 1000);
  if (autodebugTimer.unref) autodebugTimer.unref();
}

// ---------------- Bandeja ----------------

function buildTray() {
  const icon = loadTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    // En modo de ventana independiente la interfaz principal está oculta y la bandeja es el único acceso siempre disponible;
    // «Cerrar la aplicación actual» debe estar aquí; si no, el usuario no tendría forma de cerrar la app en ejecución.
    // Para saber «si hay una app en marcha» se miran a la vez currentAppPkg y runtime.activeApps:
    // endApp quita el paquete de activeApps, así que al cerrarla esto pasa a false automáticamente.
    // Pero currentAppPkg puede seguir apuntando a la app anterior (endApp no lo borra), por eso se comprueban las dos cosas.
    const hasRunning = currentAppPkg && runtime && runtime.activeApps
      ? runtime.activeApps.includes(currentAppPkg)
      : false;
    const runningLabel = currentAppPkg
      ? ((store.getApp(currentAppPkg) || {}).label || currentAppPkg)
      : '';
    const menu = Menu.buildFromTemplate([
      { label: 'Abrir Lanzador APK', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'Todavía no hay aplicaciones instaladas', enabled: false }]),
      { type: 'separator' },
      {
        label: hasRunning ? `Cerrar la aplicación actual (${runningLabel})` : 'Cerrar la aplicación actual',
        enabled: !!hasRunning,
        click: () => {
          const pkg = currentAppPkg;
          if (!pkg) return;
          // Se reutiliza la misma ruta de app:stop, sin duplicar la lógica en dos lugares
          stopApp(pkg).then(() => refresh());
        },
      },
      {
        label: 'Cerrar todas las apps de Android',
        click: () => {
          closeAllApps().then((r) => {
            refresh();
            if (r && r.ok) notify('Apps cerradas', 'Se cerraron las apps de Android abiertas; Android sigue listo para abrir la próxima al instante.');
          });
        },
      },
      {
        label: wantLandscapeFor(currentAppPkg) ? 'Volver a vertical (reinicia el runtime)' : 'Cambiar a horizontal (reinicia el runtime)',
        enabled: !!currentAppPkg,
        click: () => { rotateCurrentApp().catch(() => {}); },
      },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Volver a ventana vertical' : 'Pantalla completa (se ajusta a la pantalla)',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Recrear accesos directos del escritorio / menú Inicio', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Sincronizar carpeta compartida', click: () => sharer.sync() },
      { label: 'Configuración', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `Nueva versión disponible ${updateInfo.tag}` : 'Buscar actualizaciones',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'Nueva versión disponible',
              message: `Lanzador APK ${info.tag} ya está publicada; versión actual v${app.getVersion()}. ¿Actualizar ahora?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Actualizar ahora', 'Más tarde'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('Ya tienes la última versión', `Lanzador APK v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Salir',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('Lanzador APK — Ejecutor de apps Android');
  // La convención de la bandeja de Windows es abrir la ventana principal con un clic (con doble clic también).
  // Antes solo había double-click; con un clic no pasaba nada y el usuario creía que el icono de la bandeja estaba roto.
  // El menú sale con clic derecho, así que showWindow con un clic no choca con el menú.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- Acciones principales ----------------

let installBusy = null;   // Ruta del archivo que se está instalando: varios doble clic sobre un APK pasan por second-instance; no se puede instalar en paralelo
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // El mismo paquete ya se está instalando (el usuario pulsó varias veces el icono / lo arrastró varias veces) → se avisa una vez, sin repetir la instalación
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'Este APK se está instalando, espera un momento…' });
      return { ok: false, error: 'Instalando' };
    }
    send('toast', { type: 'info', message: 'Ya hay una instalación en curso; espera a que termine.' });
    return { ok: false, error: 'Ya hay una instalación en curso' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // El Explorador debe actualizar enseguida el nuevo icono del escritorio; si no, el usuario cree que «no se creó el acceso directo»
    windowctl.refreshShell().catch(() => {});
    notify('Instalación completada', `${result.app.label} instalada ${result.app.shortcutPath ? '; se creó el acceso directo en el escritorio' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // El mismo error solo muestra una notificación del sistema cada 8 s: en reintentos seguidos no se llena la esquina inferior derecha
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // Con la ventana en primer plano el usuario ya ve el aviso en la interfaz; no hace falta una notificación del sistema
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Error al instalar', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * Descarga e instala la nueva versión; luego el script update-apply se encarga de «reemplazar + reiniciar».
 * La interfaz y el menú de la bandeja comparten esta ruta.
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'Actualizando' };
  // La versión de la Store (MSIX) no puede autoactualizarse: la carpeta C:\Program Files\WindowsApps es de solo lectura,
  // sobrescribir el exe no solo fallaría, también podría romper la verificación de integridad del paquete e impedir que arranque.
  // La actualización va por Microsoft Store (protocolo ms-windows-store:).
  if (store.STORE_BUILD) {
    shell.openExternal('ms-windows-store://downloadsandupdates').catch(() => {});
    return { ok: false, error: 'Las actualizaciones de la versión de la Store las gestiona Microsoft Store; se abrió «Descargas y actualizaciones»', manual: true };
  }
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'Ya tienes la última versión' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'Esta versión no tiene un paquete instalable directamente; se abrió la página de versiones de GitHub', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Preparando la descarga…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Reemplazando el programa y reiniciando…' });
    updater.apply(job);
    // Se da un momento a la interfaz para mostrar «se reiniciará» y luego se sigue la salida normal (before-quit oculta la ventana del emulador)
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

/**
 * Serialización de los arranques.
 *
 * Un arranque puede tardar hasta 80 s (reinicio por cambio de pantalla + arranque en frío). Mientras tanto el usuario puede pulsar otra app,
 * hacer doble clic dos veces en el mismo icono o pulsar el menú de la bandeja; antes todo eso lanzaba de verdad un segundo arranque en paralelo:
 * openAppWindow cerraba la app que estaba iniciando (close + endApp) mientras la máquina virtual reiniciaba,
 * y ambos fallaban; en el registro aparecían `cmd: Can't find service: activity` / `device not found`,
 * y el usuario veía «pulsé, no pasó nada y volvió a la ventana principal».
 *
 * Ahora: la misma app → se reutiliza el arranque en curso (varios clics cuentan como uno); otra app → se espera a que termine
 * el anterior antes de empezar, en vez de quitarle el runtime.
 */
let launchInFlight = null;
// El aviso de «emulación por software» se muestra una vez por proceso, para no enviar una notificación del sistema en cada cambio de app
let accelWarned = false;

async function runLaunch(pkg) {
  if (launchInFlight) {
    if (launchInFlight.pkg === pkg) {
      appLog(`launch reused in-flight ${pkg}`);
      return launchInFlight.promise;
    }
    appLog(`launch queued ${pkg} (esperando a que ${launchInFlight.pkg} termine de arrancar)`);
    await launchInFlight.promise.catch(() => {});
  }
  const entry = { pkg };
  entry.promise = launchOne(pkg).finally(() => {
    if (launchInFlight === entry) launchInFlight = null;
  });
  launchInFlight = entry;
  return entry.promise;
}

async function launchOne(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  // Estado de «enganchar la imagen antes»: se engancha en cuanto aparece el proceso, pero el resultado final se sabe cuando vuelve el callback.
  // Va en el ámbito de la función para la evaluación final de más abajo.
  let attachDoneEarly = false;
  let earlyAttachOk = false;
  appLog(`launch start ${pkg}`);
  try {
    // 0) Primero se oculta la ventana principal y luego se abre la ventana de la app.
    // El orden importa: antes hide() iba después de openAppWindow() y de armAgent(),
    // y armAgent espera el arranque en frío del agente de ventanas (300–600 ms); durante ese tiempo «ventana principal +
    // ventana de app (+ animación de arranque)» estaban a la vez en pantalla: el usuario veía varias ventanas revoloteando.
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();
    // 1) Luego se abre la «ventana de la app» con la animación de arranque: en todo el proceso no se ve el escritorio de Android ni la ventana del emulador
    await openAppWindow(pkg, 'Iniciando el runtime de Android…');
    /**
     * Modo de ventana nativa: sacar la ventana propia del emulador **lo antes posible y una y otra vez**, para que el usuario no espere
     * frente a nuestra ventana contenedora «Iniciando».
     *
     * Antes aquí no se hacía nada, y la ventana contenedora (barra de título + logo + indicador de carga) era la primera pantalla que veía el usuario,
     * mientras la ventana nativa solo se enganchaba después de am start: en un arranque en frío / cambio de orientación eso son más de 30 s.
     * El usuario sentía que «sigue saliendo esa ventana decorada vuestra».
     *
     * En el arranque en frío la ventana Qt solo se crea cuando arranca el runtime, así que un solo intento falla seguro; por eso es
     * un sondeo: un intento cada 1,5 s, hasta lograrlo (máximo 30 s). Al reiniciar el runtime para cambiar la orientación,
     * la ventana vieja desaparece con el runtime y la nueva también se atrapa aquí cuando aparece.
     */
    if (displaySettings().windowEmbed === false && appWin && appWin.isOpen) {
      let tries = 0;
      let rounds = 0;
      const preAttach = async () => {
        if (!appWin || !appWin.isOpen) return;
        rounds += 1;
        // Límite fijo: ya sea por ceder el paso o por fallar, como máximo 45 rondas (cerca de 1 minuto) y se detiene,
        // para que tras un cambio de orientación fallido este temporizador no quede corriendo en vano.
        if (rounds > 45) return;
        // Se está cambiando la orientación de la pantalla y se va a reiniciar el runtime: enganchar ahora solo ocultaría
        // la ventana de espera recién mostrada y la pantalla quedaría vacía. Se cede el paso y se retoma tras el reinicio.
        if (appWin.waitingForRestart) {
          setTimeout(preAttach, 1500);
          return;
        }
        tries += 1;
        // eslint-disable-next-line no-await-in-loop
        const ok = await appWin.openDetached().catch(() => false);
        if (ok) { appLog(`pre-attach detached ok (intento ${tries})`); return; }
        if (tries < 20) setTimeout(preAttach, 1500);
      };
      preAttach();
    }
    // Durante el arranque se ocultan la ventana principal del emulador + las consolas negras de qemu / netsimd, para que nada parpadee.
    // La supresión es persistente (tras embed omite automáticamente la ventana incrustada; ver appwin.embed).
    // Aquí hay que hacer await: si se sigue sin esperar a que la supresión funcione, la ventana negra aparece en el instante del arranque.
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }

    const r = await installer.launch(pkg, {
      onLog: (m) => {
        send('runtime:log', m); appLog(`  rt ${m}`);
        // Se sincroniza con la animación de arranque
        if (typeof splashProgress === 'function') splashProgress({ message: m });
      },
      onMark: mark,
      // En cuanto aparece el proceso de la app se engancha la imagen, sin esperar los 4 s posteriores de observación «para confirmar que no falla».
      // Esos 4 s tienen sentido para la estabilidad, pero el usuario ve «pulsé y no pasa nada»; mostrar primero que la app está cargando
      // cambia mucho la sensación (probado: de pulsar a ver la imagen pasó de 7,2 s a unos 3 s).
      // A propósito no hay await: enganchar la imagen y evaluar la supervivencia van en paralelo; lo que termine primero no afecta lo otro.
      onAppUp: () => {
        attachDoneEarly = true;
        mark('app up (imagen enganchada antes)');
        attachAppWindow()
          .then(async (ok) => {
            earlyAttachOk = ok;
            mark(`early attach=${ok}`);
            if (!ok) return;
            // Imagen enganchada ≠ primer fotograma dibujado: Android 12+ pone antes del primer fotograma de la Activity
            // una pantalla Splash del sistema (icono de la app + fondo blanco). Si la animación de arranque desaparece entonces, el usuario ve
            // una imagen con fondo blanco y cree que se colgó. Se espera a que se quite la Splash del sistema (primer fotograma en pantalla) para cerrar la animación,
            // y si se agota el tiempo se cierra igual (un fallo del criterio no puede dejar al usuario atrapado en la animación).
            let painted = true;
            try {
              const c = runtime.client();
              if (c && typeof c.waitForAppFirstFrame === 'function') {
                // En apps pesadas, de am start al primer fotograma real pueden pasar más de 15 s;
              // rendirse a los 12 s cerraría la animación antes de tiempo y dejaría ver el icono sobre fondo blanco de la Splash del sistema.
              // 20 s dan margen de sobra; si de verdad no dibuja, solo se espera un poco más, sin bloquear el flujo.
              painted = await c.waitForAppFirstFrame(pkg, { timeoutMs: 20000 });
              }
            } catch (_) { /* Si falla el criterio se trata como listo */ }
            mark(`first frame=${painted}`);
            if (typeof splashDone === 'function') splashDone();
          })
          .catch(() => { earlyAttachOk = false; });
        // Recién iniciada la app la Activity todavía se recrea y vuelve a girar según la orientación que declara (portrait),
        // sobrescribiendo la orientación recién bloqueada: eso era «en modo tableta/horizontal la imagen siempre queda acostada 90 grados».
        // Cuando se estabiliza se hace otra autocorrección de orientación (lee init/cur y solo escribe si de verdad está acostada).
        setTimeout(() => {
          runtime._healOrientation?.().catch(() => {});
          // De paso se anota la orientación real de esta app (las apps con todo sensor en el manifiesto solo se pueden aprender así)
          learnAppOrientation(pkg).catch(() => {});
        }, 1800);
      },
      // Antes de arrancar se corrige la orientación de la pantalla a la que pide la configuración.
      // La horizontal solo se logra con la pantalla física (intercambiando hw.lcd.width/height) + reinicio, y eso se escribe
      // en config.ini al arrancar. Si el usuario cambió la opción «horizontal» pero la máquina virtual sigue con la pantalla vertical
      // (muy común con el precalentamiento), solo con wm size / wm user-rotation la imagen quedaría acostada.
      // Por eso, si no coincide, aquí primero se reinicia una vez, y con reloadApp=false se inicia la app normalmente abajo.
      beforeStart: async (rt) => {
        mark('engine ready');
        // La orientación de la pantalla debe coincidir con la que declara la app; si no, Android solo da una franja tipo buzón
        // (negro a los lados). wantLandscapeFor combina «el modo forzado de la configuración / la sustitución por app /
        // la orientación leída del manifiesto del APK»; ver el comentario de la función.
        const wantLand = wantLandscapeFor(pkg);
        const cur = runtime.emulator && typeof runtime.emulator.panelLandscape === 'function'
          ? runtime.emulator.panelLandscape()
          : null;
        if (cur !== null && cur !== wantLand) {
          mark(`orientation mismatch (panel=${cur ? 'landscape' : 'portrait'}, want=${wantLand}) corrección con reinicio`);
          appWin.setState({ tip: wantLand ? 'Cambiando a horizontal…' : 'Cambiando a vertical…' });
          // restartForOrientation devuelve un rt nuevo tras reiniciar el runtime (el client anterior ya no sirve).
          // Se devuelve a installer.launch, y los resetDisplayOverrides / startApp siguientes
          // usan el client nuevo; si no, todos fallarían en silencio (el catch lo oculta y la app no mostraría imagen).
          const newRt = await restartForOrientation(wantLand, { reloadApp: false }).catch(() => null);
          mark('orientation fixed');
          if (newRt && newRt.ok) return newRt;
        }
        appWin.setState({ tip: 'Abriendo la aplicación…' });
        // Inmersivo + sin animaciones + sin pantalla de bloqueo: se hace una sola vez y cada arranque posterior es instantáneo
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
        // Si no hubo reinicio devuelve null (installer usa el rt original)
        return null;
      },
    });
    mark('app started');

    // 2) Solo cuando la app sobrevive de verdad se pone la imagen ante el usuario (si no, vería parpadear el escritorio/una página de error)
    // Pero si onAppUp ya enganchó la imagen (toma anticipada), aquí solo se «confirma», sin volver a engancharla:
    // engancharla otra vez en modo de ventana independiente volvería a ocultar/mostrar la ventana recién colocada y la imagen parpadearía.
    let embedded;
    if (attachDoneEarly) {
      embedded = !!earlyAttachOk;
      mark(`early attached already (${embedded})`);
    } else {
      embedded = await attachAppWindow();
    }
    // El texto del registro distingue los dos modos: en modo de ventana independiente embedded=true significa
    // «la imagen ya está ante el usuario (en la ventana nativa del emulador)», no «incrustada en nuestra ventana».
    // Si no, quien lea el registro creería que la configuración no se aplicó.
    const attachMode = displaySettings().windowEmbed === false ? 'detached' : 'embed';
    if (!embedded) appLog(`attach failed (${attachMode}): ${appWin.lastEmbedError || 'unknown'}`);
    mark(`${attachMode}=${embedded}`);
    // Tras incrustar, la ventana se saca de debajo de otras ventanas. Si no, las ventanas de arriba (navegador, etc.) taparían la imagen de Android,
    // el usuario vería «pantalla negra / la imagen no llena» y el ratón no llegaría a la app (se lo comerían las ventanas de arriba).
    // Se pone topmost un instante y se quita enseguida: solo se usa una vez para subir el orden Z al frente, sin ocupar la capa superior.
    // Se omite en modo de ventana independiente: la imagen está en la ventana propia del emulador y mostrar la ventana contenedora vacía solo la taparía.
    const detachedMode = displaySettings().windowEmbed === false;
    if (appWin.isOpen && !detachedMode) {
      try {
        appWin.win.show();
        appWin.win.setAlwaysOnTop(true);
        appWin.win.moveTop();
        appWin.win.focus();
        setTimeout(() => {
          if (appWin.isOpen) {
            try { appWin.win.setAlwaysOnTop(false); } catch (_) { /* La ventana está cerrada */ }
          }
        }, 700);
      } catch (_) { /* La ventana puede acabar de cerrarse */ }
    }
    appWin.setState({ ready: true, tip: '' });
    // Sesión del contenedor: el entorno ya está listo; aquí solo se hace «recorte según la app + sondeo en segundo plano»,
    // sin volver a arrancar Android para esta app. El gancho de botones del ratón lo decide el evento focus de la ventana
    // según la configuración, y se quita al perder el foco.
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    // Modo juego/baja latencia: el agente de ventanas reduce la frecuencia de escaneo, para que el EnumWindows de todo el escritorio no trabe el equipo
    if (winAgent) {
      const game = store.getSettings().engine?.priorityMode === 'game';
      winAgent.setPerformanceMode(game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} ${attachMode}=${embedded}`);
    // Con emulación por software se avisa una vez la primera vez que se abre una app: el usuario ya está esperando, y el aviso/elemento de comprobación
    // está en la configuración, que probablemente no vio. Una notificación del sistema aparece encima de la ventana de la app: es el aviso más efectivo.
    if (!accelWarned) {
      runtime.provisioner.emulatorAccel().then((a) => {
        if (!a || a.ok) return;
        accelWarned = true;
        notify('Ejecutando con emulación por software (muy lento)', store.STORE_BUILD
          ? 'Activa «Plataforma del hipervisor de Windows» y reinicia una vez: será de 5 a 10 veces más rápido. '
            + 'Configuración → Comprobación del entorno → Reparar abre esa ventana directamente.'
          : 'Configuración → Comprobación del entorno → Reparar lo activa con un clic (requiere permisos de administrador); luego reinicia una vez.');
      }).catch(() => {});
    }
    // Respaldo: si early attach no disparó splashDone (por ejemplo en modo incrustado), se hace aquí
    if (typeof splashDone === 'function') splashDone();
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // Si el arranque falla también se sigue suprimiendo la ventana del emulador (que no aparezca como «ventana de emulador independiente»),
    // y la próxima vez que se pulse una app se sigue el mismo camino ocultar → embed.
    if (winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    send('toast', { type: 'error', message: `Error al iniciar: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * Interruptor de tareas en segundo plano según haya o no ventanas de apps en el contenedor.
 * La sincronización de archivos recorre la carpeta compartida y hace un adb find/stat cada 8 s, y el puente de notificaciones también sondea;
 * antes arrancaban sin condición en cuanto iniciaba LanzadorAPK, aunque no hubiera ninguna app Android abierta.
 * Ahora solo arrancan cuando de verdad hay apps en el contenedor, y se detienen en cuanto se cierra la última ventana.
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/**
 * Cierra una app Android en ejecución; el menú de la bandeja y el menú contextual comparten esta ruta.
 *
 * Hace tres cosas:
 *  1. forceStop del proceso de la app (la lógica de reposo de endApp también va después de este paso)
 *  2. retira la imagen: en modo incrustado cierra la ventana contenedora; en modo independiente oculta primero la ventana del emulador y luego cierra la contenedora
 *     (el orden importa: destruir primero la contenedora haría parpadear la ventana del emulador en el escritorio antes del park)
 *  3. borra currentAppPkg, para que «Cerrar la aplicación actual» de la bandeja quede gris de inmediato
 *
 * @param {string} pkg nombre de paquete de la app que se cierra
 * @param {object} [opts] { keepWindow } con keepWindow=true no se cierra la ventana
 * @returns {Promise<{ok:boolean, pkg?:string, error?:string}>}
 */
async function stopApp(pkg, opts = {}) {
  const target = pkg || currentAppPkg;
  if (!target) return { ok: false, error: 'No hay ninguna aplicación en ejecución' };
  const detached = displaySettings().windowEmbed === false;
  try {
    await runtime.endApp(target, { onIdle: (idle) => onContainerActive(idle) }).catch(() => {});
    appLog(`stop ${target}`);

    if (!opts.keepWindow) {
      // Modo de ventana independiente: primero se oculta la ventana del emulador y luego se cierra la contenedora.
      // Al revés quedaría en el escritorio una ventana del emulador que parpadea y desaparece.
      if (detached && appWin && appWin.isOpen) {
        try { await appWin.agent.hide(); } catch (_) { /* ignore */ }
      }
      if (appWin && appWin.isOpen) {
        appWin.close({ keepApp: true });
      }
    }

    // Borra la marca de app actual: «Cerrar app» de la bandeja y del menú contextual quedan grises según esto
    if (currentAppPkg === target) currentAppPkg = null;

    try { send('apps:changed'); } catch (_) { /* ignore */ }
    return { ok: true, pkg: target };
  } catch (e) {
    appLog(`stop failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Cierra todas las apps Android abiertas (la de la ventana y las que quedaron en segundo plano), sin apagar Android:
 * la próxima app sigue abriendo al instante. Solo toca apps instaladas por el usuario (nunca paquetes del sistema).
 */
async function closeAllApps() {
  try {
    if (currentAppPkg) await stopApp(currentAppPkg).catch(() => {});
    if (!runtime) return { ok: true, closed: 0 };
    const client = runtime.client();
    if (!(await client.isOnline().catch(() => false))) return { ok: true, closed: 0 };
    const { validPackageName } = require('./core/pkgname');
    const { isSystemPackage } = require('./core/container');
    const pkgs = store.getApps().map((a) => a.package).filter((p) => validPackageName(p) && !isSystemPackage(p));
    const cmds = pkgs.map((p) => `am force-stop ${p}`);
    cmds.push('am kill-all');
    await client.shell(cmds.join('; '), { timeout: 30000 }).catch(() => {});
    try { send('apps:changed'); } catch (_) { /* ignore */ }
    appLog(`close all apps (${pkgs.length})`);
    return { ok: true, closed: pkgs.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Puente de notificaciones: solo sondea con ventanas de apps; al cerrarlas se detiene, para no correr en vano */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // Forma de inicio (inicio automático / abierto con doble clic): la tarjeta de bienvenida decide con esto si se muestra sola
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // Elegir carpeta (para mover runtime/imagen/apps instaladas a un disco que no sea el del sistema)
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir la carpeta de datos',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* Se ignora si el runtime no arrancó */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir el APK que quieres instalar',
      filters: [{ name: 'Aplicación Android', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  /**
   * Cierra una app Android en ejecución.
   *
   * Antes no existía este acceso: endApp solo se disparaba al «cerrar la ventana de la app», y en modo de ventana independiente
   * esa ventana está oculta y nunca se cierra, así que una vez iniciada la app no se podía cerrar,
   * y el usuario solo podía salir de todo LanzadorAPK desde la bandeja (llevándose también la máquina virtual).
   */
  ipcMain.handle('app:stop', async (_e, pkg, opts = {}) => stopApp(pkg, opts));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('La aplicación no existe');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  /**
   * Sustitución de orientación horizontal/vertical por app (para el menú contextual de la tarjeta).
   * Solo escribe orientationOverride en apps.json, sin reiniciar el runtime aquí;
   * la próxima vez que se abra la app, wantLandscapeFor lo lee y cambia la pantalla a esa orientación.
   * null quita la sustitución y vuelve a la orientación natural leída del manifiesto del APK.
   */
  ipcMain.handle('app:setOrientation', async (_e, { pkg, orientation: value }) => {
    if (!pkg) return { ok: false, error: 'Falta el nombre del paquete' };
    const next = value === 'landscape' || value === 'portrait' ? value : null;
    store.upsertApp({ package: pkg, orientationOverride: next });
    appLog(`orientation override ${pkg} = ${next || '(según la aplicación)'}`);
    // La lista de la ventana principal debe mostrar enseguida el texto de la nueva orientación
    send('apps:changed');
    return { ok: true, orientation: next, landscape: wantLandscapeFor(pkg) };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  /**
   * Memoria / CPU / partición de datos deciden directamente cómo arranca la máquina virtual y qué tamaño de juego cabe;
   * antes de guardar se ajustan todos una vez: valores absurdos de settings.json editados a mano o de versiones anteriores se corrigen aquí,
   * para que qemu no salga al arrancar por un -memory 32, ni la partición sea mayor que el disco.
   */
  const sanitizeResourcePatch = (patch) => {
    if (!patch || !patch.engine) return patch;
    const res = require('./core/resources');
    const host = res.hostProfile();
    const eng = { ...patch.engine };
    if ('memoryMB' in eng) {
      const c = res.clampMemoryMB(eng.memoryMB, host.totalMB);
      eng.memoryMB = c.mb;
      if (c.mb > 0) eng.autoMemory = false;
    }
    if ('cores' in eng) eng.cores = res.clampCores(eng.cores, host.cores).cores;
    if ('dataPartitionGB' in eng) {
      eng.dataPartitionGB = Math.max(0, Math.min(256, Number(eng.dataPartitionGB) || 0));
    }
    return { ...patch, engine: eng };
  };

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, rawPatch) => {
    const patch = sanitizeResourcePatch(rawPatch);
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // Cambió el tamaño vertical base: solo afecta el tamaño de las ventanas que se abran después, sin interrumpir la app en ejecución
      appWin.portrait = portraitSize();
    }
    // Al activar «acceso directo en el menú Inicio» se completan enseguida, sin esperar a la próxima instalación
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // Cambiaron los botones del ratón: se instala/quita el gancho enseguida según el foco actual, sin esperar al próximo cambio de ventana
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // Cambió la fuente de actualizaciones / el prefijo de espejo / la dirección del paquete: la conclusión anterior de «cuál es más rápida» ya no vale y se borra la caché de velocidad;
    // las direcciones del paquete del runtime / motor / imagen siguen en provisioner._cache, y sin borrarlas habría que reiniciar el proceso para que se apliquen.
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /**
   * Cambio de la carpeta compartida del equipo: los archivos de la carpeta anterior se mueven una vez a la nueva (lo posible, sin borrar los viejos),
   * y luego se guarda la configuración. Sharer lee store.getSettings().sharedDir en cada sincronización, así que se aplica sin reiniciar.
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'El directorio no puede estar vacío' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Modo de visualización / accesos directos / instalación con un clic ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // Pantalla completa = diseño horizontal de tableta (ver la explicación de toggleDisplayMode)
      appWin.setLandscape(full).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  // Si el usuario pulsa «Completar con un clic» se fuerza el reintento, saltando la espera tras fallos
  ipcMain.handle('runtime:autoDeploy', (_e, opts = {}) => autoDeploy({ force: !!opts.force }));
  // Al desactivar «recorte profundo» se restauran los paquetes del sistema desactivados con pm disable-user
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Cambiaron los botones del ratón: solo se sincroniza la configuración, ya no se quita el gancho sin condición (clic derecho/rueda pueden seguir necesitándolo)
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // Compatibilidad con la interfaz anterior: el significado ahora es «volver a sincronizar según la configuración»
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  // ---------------- Diagnóstico del equipo / configuración automática ----------------
  // Lo que la detección puede hacer sola (memoria, núcleos, calidad, motor de renderizado) se hace solo;
  // lo que requiere administrador (activar funciones de Windows, instalar AEHD) tiene un botón; lo que solo se hace en la BIOS se explica.

  ipcMain.handle('preflight:run', async () => {
    const preflight = require('./core/preflight');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* El runtime todavía no está instalado */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    return { ok: true, hw, report, edition };
  });

  /**
   * Aplica la recomendación del diagnóstico: escribe la configuración + guarda el parche de este equipo como un controlador.
   * Solo escribe los pocos elementos seguros que lista preflight (memoria / núcleos / calidad / motor de renderizado / si se fija la emulación por software).
   */
  ipcMain.handle('preflight:apply', async () => {
    const preflight = require('./core/preflight');
    const drv = require('./core/drivers');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* ignore */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    const patch = sanitizeResourcePatch(report.patch);
    const next = store.saveSettings(patch);

    // Fija los parámetros de este equipo como controlador: cada arranque los sigue, sin repetir el diagnóstico.
    // Se valida antes de guardar: lo que genera el diagnóstico tampoco puede saltarse la lista permitida.
    let driverFile = '';
    let driverError = '';
    try {
      const v = drv.validateDriver(report.driver);
      if (!v.ok) throw new Error(v.errors.join(';'));
      const dir = drv.userDir(store);
      fs.mkdirSync(dir, { recursive: true });
      driverFile = path.join(dir, `${v.driver.id}.json`);
      fs.writeFileSync(driverFile, `${JSON.stringify(report.driver, null, 2)}\n`, 'utf8');
      const prev = (next.drivers && next.drivers.state) || {};
      store.saveSettings({ drivers: { state: { ...prev, [v.driver.id]: true } } });
    } catch (e) {
      driverError = e.message;
    }

    appLog(`Configuración automática por diagnóstico: ${JSON.stringify(patch.engine)} driver=${driverFile || '(no guardado)'}`);
    return {
      ok: true,
      settings: store.getSettings(),
      driverFile,
      driverError,
      summary: report.summary,
      recommended: report.recommended,
    };
  });

  // ---------------- Controladores (parches de compatibilidad) ----------------
  // Un controlador es un JSON que declara «a qué equipos aplica» + «qué parámetros de arranque cambia si coincide».
  // Aquí solo se hace «leer la carpeta / validar / comparar / importar / exportar plantilla / activar»; nunca se ejecuta código.

  /** Arma el perfil del equipo actual + todos los controladores + el resultado de la comparación (para la configuración) */
  async function driverOverview() {
    const drv = require('./core/drivers');
    const doctor = require('./core/doctor');
    const os = require('os');
    const s = store.getSettings();
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* El runtime no está instalado */ }
    let emulatorVersion = '';
    try { emulatorVersion = (await runtime.provisioner.emulatorVersion()).version || ''; } catch (_) { /* ignore */ }
    let osBuild = 0;
    try {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* ignore */ }
    const host = drv.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (os.cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const dirs = { user: drv.userDir(store), bundled: drv.bundledDir(APP_ROOT) };
    const loaded = drv.loadAll([dirs.bundled, dirs.user]);
    const resolved = drv.resolve({ drivers: loaded.drivers, host, state, disabled });
    const hit = new Map(resolved.applied.map((d) => [d.id, d]));
    return {
      host,
      dirs,
      errors: loaded.errors,
      effect: resolved.effect,
      drivers: loaded.drivers.map((d) => {
        const forced = typeof state[d.id] === 'boolean' ? state[d.id] : null;
        return {
          id: d.id,
          name: d.name,
          version: d.version,
          author: d.author,
          description: d.description,
          priority: d.priority,
          builtin: d.dir === dirs.bundled,
          file: d.file,
          enabled: forced !== null ? forced : d.enabled !== false,
          matched: hit.has(d.id),
          hits: (hit.get(d.id) || {}).hits || [],
        };
      }),
    };
  }

  ipcMain.handle('drivers:list', () => driverOverview());

  ipcMain.handle('drivers:openFolder', async () => {
    const dir = require('./core/drivers').userDir(store);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('drivers:import', async () => {
    const drv = require('./core/drivers');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir archivo de controlador (.json)',
      filters: [{ name: 'JSON de controlador', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const out = drv.importDriver(r.filePaths[0], drv.userDir(store));
    if (out.ok) {
      // Importar = activar: un parche importado a propósito por el usuario debería aplicarse de inmediato
      const s = store.getSettings();
      store.saveSettings({ drivers: { state: { ...(s.drivers.state || {}), [out.driver.id]: true } } });
      send('runtime:log', `Controlador importado: ${out.driver.name} v${out.driver.version}`);
    }
    return { ...out, overview: await driverOverview() };
  });

  ipcMain.handle('drivers:exportTemplate', async () => {
    const drv = require('./core/drivers');
    const overview = await driverOverview();
    const tpl = drv.templateFromHost(overview.host);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar plantilla de controlador de este equipo',
      defaultPath: path.join(drv.userDir(store), `${tpl.id}.json`),
      filters: [{ name: 'JSON de controlador', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
    fs.writeFileSync(r.filePath, `${JSON.stringify(tpl, null, 2)}\n`, 'utf8');
    return { ok: true, file: r.filePath, template: tpl };
  });

  ipcMain.handle('drivers:setEnabled', async (_e, { id, enabled } = {}) => {
    const did = String(id || '');
    if (!did) return { ok: false, error: 'Falta el id del controlador' };
    const s = store.getSettings();
    const prev = (s.drivers && s.drivers.state) || {};
    store.saveSettings({ drivers: { state: { ...prev, [did]: !!enabled } } });
    return { ok: true, overview: await driverOverview() };
  });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- Diagnóstico / reducción ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // Si ya arrancó se usan los parámetros reales; si no, también se deducen con «la versión real del motor + el estado real de aceleración»,
    // si no, la configuración mostraría swiftshader_indirect obsoleto / emulación por software, distinto de lo que corre en realidad.
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * Validación automática de problemas del sistema: antes de arrancar/en ejecución revisa las causas habituales de «no se instala / no arranca»
   * y da sugerencias de reparación concretas (en el aviso de la página principal + el panel de configuración, con reparación de un clic por problema).
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // Estos dos valores se asignan dentro del try y se devuelven fuera, así que hay que declararlos fuera de su ámbito
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'Falta Microsoft Visual C++ Redistributable (x64)',
          hint: 'El runtime de Android necesita Microsoft VC++ 2015-2022; sin él el emulador no arranca (0xc0000135).', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        // La versión de la Store y la instalada se reparan de formas totalmente distintas; los avisos deben ir por separado:
        //   - la versión de la Store (MSIX) no puede instalar controladores de kernel y normalmente no obtiene elevación → solo se puede guiar al usuario
        //     a marcar él mismo «Plataforma del hipervisor de Windows» en «Activar o desactivar las características de Windows»;
        //   - las versiones instalada/portátil pueden activarlo con elevación de un clic (y si falla, pasar al controlador AEHD).
        // Antes ambas versiones compartían una sola frase, y los usuarios de la Store veían «instala el controlador AEHD»,
        // cuando la versión de la Store no puede instalar controladores: un camino sin salida.
        issues.push(store.STORE_BUILD
          ? {
            code: 'accel',
            severity: 'error',
            title: 'Hay que activar «Plataforma del hipervisor de Windows»',
            hint: 'Sin ella solo funciona la emulación por software y el arranque puede tardar varios minutos. '
              + MSIX_ACCEL_HINT
              + '(La versión de la Store no puede pedir permisos de administrador por ti; hazlo manualmente una vez y reinicia.)',
            fix: 'virtualization',
          }
          : {
            code: 'accel',
            severity: 'warn',
            title: 'Aceleración por hardware no activada',
            hint: `${accel.note || 'Se usará emulación por software (funciona, pero muy lento).'}`
              + 'Pulsa «Reparar» a la derecha para activarla automáticamente (requiere permisos de administrador; puede pedir un reinicio); '
              + 'si falla, se instalará el controlador AEHD automáticamente.',
            fix: 'virtualization',
          });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Poco espacio en disco para el runtime',
          hint: `«${runtime.provisioner.paths().root}» solo tiene ${free} MB libres; el runtime y las imágenes podrían llenar el disco.`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'El directorio del runtime tiene caracteres especiales o no ASCII',
          hint: 'Algunos componentes del runtime fallan con rutas con acentos o caracteres especiales. Usa una carpeta con nombre solo en ASCII.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'Faltan las herramientas adb', hint: 'No se puede conectar con el runtime de Android.', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'El motor del runtime no está instalado', hint: 'Primero hay que instalar el motor del runtime (unos 440 MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'La imagen del sistema no está lista', hint: 'Primero hay que descargar la imagen del sistema Android (unos 1,5 GB).', fix: 'deploy' });
      }
      // Archivos de bloqueo restantes: harían que el próximo arranque se tome como «AVD ya en uso» y dé FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Quedaron archivos de bloqueo del arranque anterior', hint: 'Pueden hacer que el próximo arranque se tome como «AVD ya en uso».', fix: 'lock' });
      }
    } catch (_) { /* Un fallo de la autocomprobación no bloquea el uso */ }
    return { issues, accel, free };
  });

  // ---------------- Comprobación automática (depuración automática) ----------------

  /** Ejecuta una comprobación ahora (el botón «Comprobar ahora» de la configuración / la tarea periódica pasan por aquí) */
  ipcMain.handle('autodebug:run', () => runAutodebug({ force: true }));

  /** Toma el resultado anterior (al abrir la configuración se muestra primero el viejo, para que la interfaz no quede vacía esperando) */
  ipcMain.handle('autodebug:state', () => autodebugState);

  /** Interruptor e intervalo */
  ipcMain.handle('autodebug:config', (_e, patch = {}) => {
    const cur = autodebugConfig();
    const next = {
      auto: patch.auto === undefined ? cur.auto : !!patch.auto,
      intervalMin: patch.intervalMin === undefined ? cur.intervalMin : Number(patch.intervalMin) || cur.intervalMin,
      notify: patch.notify === undefined ? cur.notify : !!patch.notify,
    };
    store.saveSettings({ debug: next });
    scheduleAutodebug();
    if (next.auto) runAutodebug().catch(() => {});
    return next;
  });

  /** Limpia los procesos huérfanos del emulador (emulator.exe solo es el lanzador; qemu es detached) */
  ipcMain.handle('app:clearOrphans', async () => {
    try {
      const r = await runtime.killOrphanEmulators({ onLog: (m) => appLog(`orphan: ${m}`) });
      return { ok: true, note: r && r.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** Invalida la instantánea de arranque rápido (si está dañada, cada arranque espera en vano un arranque en frío) */
  ipcMain.handle('app:clearSnapshot', async () => {
    try {
      const ok = runtime.emulator.invalidateSnapshot();
      return { ok: !!ok };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** Reiniciar el runtime: la primera acción para autocorregir unauthorized / arranque colgado / bloqueos huérfanos */
  ipcMain.handle('runtime:restart', async () => {
    try {
      await runtime.stop({ onLog: (m) => appLog(`restart-stop: ${m}`) }).catch(() => {});
      const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
      return { ok: true, ready: !!r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Microsoft VC++ 2015-2022 x64: el emulador de Android (Qt6) y qemu dependen de él.
  // si falta, en otros equipos no arrancan (0xc0000135 / falta MSVCP140).
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // Se instala con elevación RunAs (VC++ es un componente del sistema y requiere administrador); /quiet silencioso, /norestart sin reiniciar
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // Diálogo de confirmación genérico (la interfaz siempre pasa por aquí, para no armar textos de diálogo en cada lugar)
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'Confirmar',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Cancelar', opts.okLabel || 'Aceptar'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  /**
   * Resumen de asignación de recursos: límite del anfitrión, asignación actual, espacio libre del disco de datos.
   * Lo responde resources() del propio runtime; la interfaz solo usa esa estructura.
   */
  ipcMain.handle('engine:resources', async () => {
    try {
      const backend = runtime.backend;
      if (backend && typeof backend.resources === 'function') return await backend.resources();
      return { backend: backend ? backend.id : '', ok: false, note: 'El runtime no está listo; todavía no se puede leer la asignación de recursos' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Cuando no se puede ampliar en el sitio (disco diferencial quickboot) se usa esto: recrear /data con la capacidad objetivo.
   * Borra las apps instaladas y las partidas guardadas; quien llama debe haber obtenido antes la confirmación explícita del usuario.
   */
  ipcMain.handle('runtime:resetAndResize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const want = res.clampDataGB(gb, freeMB).gb;
    if (!want) return { ok: false, error: 'Capacidad de destino no válida' };
    store.saveSettings({ engine: { dataPartitionGB: want } });
    await runtime.stop().catch(() => {});
    const r = await runtime.resetAndroidData().catch((e) => ({ ok: false, error: e.message }));
    appLog(`reset+resize -> ${want}GB: ${JSON.stringify(r)}`);
    return { ok: !!(r && r.ok), wantGB: want, ...r };
  });

  // Capacidad de la partición de datos (/data): aquí se instalan las apps, los juegos y sus actualizaciones.
  // «La actualización del juego dice que no hay espacio» casi siempre es porque esto es demasiado pequeño; la ampliación se hace en el sitio, sin perder datos.
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const b = runtime.backend;
    const info = (b && typeof b.dataInfo === 'function') ? (b.dataInfo() || {}) : {};
    const freeDiskMB = Number(info.freeMB) || Number(info.freeDiskMB)
      || doctor.freeDiskMB(runtime.provisioner.paths().root);
    return { ...info, freeDiskMB };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const clamped = res.clampDataGB(gb, freeMB);
    const want = clamped.gb;
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // Con la imagen ocupada por qemu no se puede cambiar; primero se detiene el contenedor (las apps se cierran con él, es lo esperado)
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Partición de datos ajustada', `Espacio disponible en Android: unos ${want} GB${stopped ? ' (el runtime se reinició)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // Doble confirmación explícita: primero se da la lista y solo tras confirmar se borra de verdad; y solo se limpia la propia carpeta del runtime de LanzadorAPK
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancelar', `Limpiar ${preview.candidates.length} elementos`],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirmar limpieza de la caché del runtime',
      message: `Se liberarán unos ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'Primero se detiene el runtime y luego se borran las imágenes antiguas, las instantáneas de arranque rápido del AVD actual, los archivos de bloqueo y la caché de AVD inactivos. Las apps instaladas se conservan (solo se borran instantáneas).'
        : 'Solo se borran imágenes y instantáneas antiguas, archivos de bloqueo y la caché de AVD inactivos; las apps instaladas se conservan.')
        + 'Esta acción no se puede deshacer; te recomendamos exportar antes un informe de diagnóstico.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // Restablece por completo los datos de Android: vacía la partición de usuario /data + apps instaladas + instantánea de arranque rápido,
  // y el AVD vuelve al estado limpio de «sistema recién instalado». Borra de verdad varios GB de datos; la interfaz debe pedir doble confirmación.
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Repara la red de la máquina virtual: restablece /data (conserva la lista de apps; se reinstalan al abrirlas).
  // Caso típico: todas las páginas en línea de Android se quedan en negro; en realidad wlan0 no arrancó y no hay ruta por defecto.
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Solo comprueba la red, sin tocar ningún dato (la configuración lo usa para mostrar el estado actual)
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Restos de versiones anteriores ----------------

  /** Solo analiza, no borra: primero muestra a la interfaz tal cual «lo que se encontró» y el usuario decide */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Autoaprovisionamiento del runtime ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** Instala el controlador AEHD con elevación: aparece el UAC y, si el usuario confirma, se instala en silencio */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'El paquete del controlador AEHD no está listo');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Se canceló la autorización de administrador (tienes que pulsar «Sí» para instalar el controlador)' : `Error al instalar el controlador (código de salida ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Activa la virtualización automáticamente: el usuario no tiene que ir al panel de «Características de Windows».
   * Primero se activa la función «Plataforma de máquina virtual» (WHPX) del sistema; si ni siquiera existe esa DLL (sistemas antiguos),
   * se instala y activa el controlador AEHD de Google. Ambas formas requieren elevación de administrador.
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'La aceleración por hardware ya funciona; no hace falta nada más' };

      // ---------------- Versión de la Store (MSIX): solo puede usar el WHPX del sistema ----------------
      // Los paquetes MSIX los lanza el modelo de implementación AppX, fijos en mediumIL: no pueden instalar controladores de kernel (AEHD)
      // y normalmente no obtienen elevación. Por eso aquí solo se intenta WHPX y, si no se logra, se pasa a la guía de
      // «activación manual»: la implementación anterior usaba directamente Start-Process -Verb RunAs, que en la Store
      // estaba condenado a fallar, y el aviso «sin aceleración por hardware» nunca desaparecía.
      if (store.STORE_BUILD) {
        const whpx = await enableWhpxFeatures();
        runtime.provisioner.invalidateEnvCache?.();
        if (whpx.ok) {
          return {
            ok: true, restartNeeded: true, steps: whpx.steps,
            accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
            note: 'Se pidió activar «Plataforma del hipervisor de Windows»; la aceleración por hardware funcionará después de reiniciar el equipo',
          };
        }
        return {
          ok: false,
          manual: true,
          settingsUri: 'ms-settings:optionalfeatures',
          steps: whpx.steps,
          accel,
          note: MSIX_ACCEL_HINT,
        };
      }

      // ---------------- Versión instalada / portátil ----------------
      // Primero WHPX (del sistema, sin descargas); si falla (el usuario pulsó No / el sistema no lo admite) se pasa al controlador AEHD.
      // AEHD necesita internet para bajar el controlador, por eso va después.
      const whpx = await enableWhpxFeatures();
      runtime.provisioner.invalidateEnvCache?.();
      if (whpx.ok) {
        return {
          ok: true, restartNeeded: true, steps: whpx.steps,
          accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
          note: whpx.steps.some((s) => s.cancelled)
            ? '«Plataforma del hipervisor de Windows» activada; reinicia el equipo para aplicar el cambio'
            : '«Plataforma del hipervisor de Windows» activada; reinicia el equipo para aplicar el cambio',
        };
      }
      if (whpx.cancelled) {
        return {
          ok: false,
          cancelled: true,
          error: 'Cancelaste la autorización de administrador; la aceleración por hardware no cambió. Puedes pulsar «Reparar» de nuevo o activar manualmente «Plataforma del hipervisor de Windows».',
        };
      }

      // WHPX no se activa: se usa el controlador AEHD de Google (funciona al instalarlo, sin reiniciar)
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'No se pudo preparar el paquete del controlador AEHD' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Se canceló la autorización de administrador (tienes que pulsar «Sí» para instalar el controlador)' : `Error al instalar el controlador (código de salida ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      runtime.provisioner.invalidateEnvCache?.();
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'Aceleración por hardware AEHD activada' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir imagen del sistema Android-x86 / Bliss OS',
      filters: [{ name: 'Imagen del sistema', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir un disco virtual con Android instalado',
      filters: [{ name: 'Disco virtual', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // Entornos de prueba/sin shell: no se detecta el registro (reg.exe puede estar bloqueado por directivas)
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'lanzadorapk.ico');
    if (!fs.existsSync(icoPath)) {
      // Primero el ICO de marca de varios tamaños incluido en el paquete; si falta se genera desde el PNG del logo
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** Limpia los archivos de bloqueo del AVD de la vez anterior: harían que el próximo arranque se tome por error como «AVD ya en uso» y dé FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Desinstalación de LanzadorAPK con un clic:
   * 1) primero se quita la asociación de archivos .apk (para que tras desinstalar el doble clic en un APK no apunte a un programa borrado)
   * 2) versión instalada: se inicia el desinstalador NSIS (pide administrador/confirmación por su cuenta) y luego se sale de este programa
   * 3) versión portátil (sin instalar): no hay uninstaller.exe; se devuelve un aviso para que el usuario borre a mano las carpetas del programa y de datos
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* Si falla quitar la asociación no afecta la desinstalación */ }
      const exeDir = path.dirname(process.execPath);
      // Mismas reglas de identificación que updater.flavor: electron-builder genera
      // "Uninstall LanzadorAPK.exe" y el código anterior solo buscaba "uninstaller.exe",
      // así que en la versión instalada «Desinstalar» se tomaba por versión portátil y solo mostraba un aviso sin desinstalar (issue #51).
      const unName = findUninstaller(exeDir);
      if (!unName) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const uninstaller = path.join(exeDir, unName);
      const { spawn } = require('child_process');
      // Antes de desinstalar se cierra el emulador residente: qemu bloquea los exe/dll de resources\runtime,
      // y si NSIS no puede borrarlos deja media carpeta de instalación. Esto solo aplica a «desinstalar de verdad», no a la salida diaria.
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // Primero sale este programa y luego un proceso independiente lanza el desinstalador 2 s después:
      // un exe en ejecución bloquea archivos de la carpeta de instalación, y lanzar el desinstalador directamente suele dejar restos.
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  /**
   * Abre el diálogo «Activar o desactivar las características de Windows».
   *
   * Por qué no ms-settings:optionalfeatures: en Win11 esa página es la lista de «Características opcionales»
   * y **no tiene** «Plataforma del hipervisor de Windows»; el usuario buscaría en vano. El diálogo clásico
   * optionalfeatures.exe sí tiene ese elemento (la función que realmente necesita WHPX).
   * Abrirlo no requiere administrador; el UAC aparece al pulsar «Aceptar».
   */
  ipcMain.handle('provision:openWindowsFeatures', () => {
    try {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'optionalfeatures.exe');
      const { spawn } = require('child_process');
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (e) {
      // Muy raro: bloqueado por una directiva de grupo / archivo faltante. Se abre la configuración, para dar al menos un acceso al usuario
      shell.openExternal('ms-settings:optionalfeatures').catch(() => {});
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- Ventana de app (solo rotar / minimizar / maximizar / cerrar) ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  // En modo de ventana independiente la imagen está en la ventana nativa del emulador y la contenedora está oculta: los botones deben actuar sobre
  // la ventana realmente visible. appWin decide según el modo, para no maximizar/minimizar una ventana oculta.
  ipcMain.handle('shell:minimize', () => appWin.minimize());
  ipcMain.handle('shell:maximize', () => appWin.toggleMaximize());
  // El cierre debe pasar por appWin.close(): primero desprende la ventana del emulador del anfitrión y luego detiene la app Android.
  // La implementación anterior llamaba directamente a win.close(), saltándose ese cierre: la ventana desaparecía pero el proceso de Android seguía corriendo,
  // que es lo que el usuario llamaba «pulso cerrar y la app no se cierra».
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  // El botón de rotación de la barra de título = «esta app la quiero en horizontal/vertical».
  // Todo pasa por rotateCurrentApp: con wantLandscapeFor(pkg) como única base calcula la orientación objetivo,
  // y con un solo next escribe a la vez la sustitución por app + cambia la pantalla física. Antes aquí y en appWin.rotate
  // cada uno calculaba por su cuenta (uno miraba display.landscape, otro state.landscape), y los dos valores podían
  // ser opuestos: «pulsar rotar → la sustitución se escribe horizontal → la pantalla vuelve a vertical → la próxima vez vuelve a vertical»,
  // y algunas apps no había forma de ponerlas en horizontal.
  ipcMain.handle('shell:rotate', () => rotateCurrentApp());

  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });
  ipcMain.handle('shell:nav', async (_e, key) => {
    const c = runtime.client();
    if (key === 'home') await c.keyHome();
    else if (key === 'recents') await c.keyRecents();
    else if (key === 'back') await c.keyBack();
    else return { ok: false };
    return { ok: true };
  });
  // Captura de la pantalla de Android → Imágenes\Lanzador APK\<app> <fecha>.png
  ipcMain.handle('shell:screenshot', async () => {
    try {
      const png = await runtime.client().screenshot();
      if (!png || png.length < 100 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('la captura salió vacía');
      const dir = path.join(app.getPath('pictures'), 'Lanzador APK');
      fs.mkdirSync(dir, { recursive: true });
      const label = String((appWin && appWin.state && appWin.state.label) || 'Android').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
      const file = path.join(dir, `${label} ${stamp}.png`);
      fs.writeFileSync(file, png);
      appLog(`screenshot: ${file}`);
      notify('Captura guardada', file);
      return { ok: true, file };
    } catch (e) {
      notify('No se pudo hacer la captura', e.message);
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Ajustes del sistema Android (sin entrar al escritorio de Android) ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Opción de configuración desconocida: ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  // Botones de navegación de Android: se guarda y, si Android ya está en marcha, se aplica al momento
  ipcMain.handle('android:navButtons', async (_e, on) => {
    store.saveSettings({ display: { navButtons: !!on } });
    try {
      if (!(await runtime.client().isOnline())) return { ok: true, applied: false };
      const r = await runtime.client().setNavButtons(!!on);
      return { ok: r.ok, applied: r.ok, error: r.ok ? '' : r.out };
    } catch (e) { return { ok: true, applied: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('apps:closeAll', () => closeAllApps());

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // ---- Asignación de teclas ----
  ipcMain.handle('shell:keyEvent', async (_e, key) => {
    if (!keymapEngine || !keymapEngine.enabled) return false;
    const pkg = currentAppPkg;
    if (!pkg) return false;
    return keymapEngine.handleKey(key, pkg);
  });
  ipcMain.handle('keymap:getPresets', () => {
    return Object.entries(KEYMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
  });
  ipcMain.handle('keymap:getMap', (_e, pkg) => keymapEngine ? keymapEngine.getMap(pkg) : []);
  ipcMain.handle('keymap:setMap', (_e, pkg, mappings) => {
    if (!keymapEngine) return { ok: false };
    keymapEngine.setMap(pkg, mappings);
    // Se guarda en la configuración
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    if (mappings && mappings.length) maps[pkg] = mappings;
    else delete maps[pkg];
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true };
  });
  ipcMain.handle('keymap:setEnabled', (_e, on) => {
    if (keymapEngine) keymapEngine.enable(!!on);
    store.saveSettings({ engine: { keymapEnabled: !!on } });
    return { ok: true };
  });
  ipcMain.handle('keymap:isEnabled', () => keymapEngine ? keymapEngine.enabled : false);
  ipcMain.handle('keymap:applyPreset', (_e, pkg, presetId) => {
    if (!keymapEngine || !KEYMAP_PRESETS[presetId]) return { ok: false };
    const mappings = KEYMAP_PRESETS[presetId].mappings;
    keymapEngine.setMap(pkg, mappings);
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    maps[pkg] = mappings;
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true, mappings };
  });

  // ---------------- Actualización en línea ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // El usuario pulsó «Buscar actualizaciones» → se omite la caché y se vuelve a consultar siempre
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // Se permite abrir directamente la página de versiones de GitHub: si falla la búsqueda de actualizaciones, la interfaz depende de esto
    // para que el usuario descargue manualmente.
    const raw = String(url || '');
    const ok = /^https:\/\/github\.com\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// ---------------- Ciclo de vida ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    /**
     * Anota «quién gestiona ahora este runtime».
     *
     * Para qué sirve, ver releaseRuntime() abajo: si la app no responde el usuario vuelve a pulsar, la instancia vieja
     * está saliendo (ya liberó el bloqueo de instancia única), la nueva toma el emulador y empieza a iniciar la app;
     * pero la limpieza de la vieja igual hacía runtime.dispose(), y la nueva recibía `device 'emulator-5554' not found`.
     * El síntoma era «tras pulsar dos veces la app ya no abre». La nueva instancia sobrescribe este archivo al iniciar,
     * y la vieja, al cerrar, ve que el pid no es el suyo y no detiene el runtime.
     */
    try { fs.writeFileSync(path.join(store.DATA_DIR, 'owner.pid'), String(process.pid)); } catch (_) { /* ignore */ }
    // Identidad de la barra de tareas de Windows (AppUserModelID)
    // Sin fijarla, Windows solo puede adivinar la identidad por la ruta del exe: anclajes de la barra de tareas, listas de salto y origen de notificaciones
    // caerían en "Electron": el usuario vería «el icono/nombre por defecto».
    // Ojo: esta es la identidad del «proceso actual»; al cambiar a una app Android se cambia al
    // AUMID propio de esa app (ver openAppWindow); si no, el anclaje de la barra de tareas y la ventana en ejecución no coinciden
    // y el anclaje seguiría mostrando el icono de LanzadorAPK.
    setAumid(APP_AUMID);
    runtime = new Runtime(APP_ROOT);
    // Deja una línea al iniciar: si hay un problema y el usuario envía app.log se ven la versión y la carpeta de datos
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);

    // ---- Ventana de la animación de arranque ----
    // Estilo de marca sencillo: el logo aparece gradualmente + barra de progreso + texto de estado.
    // En la primera instalación muestra además una introducción a los pasos de configuración; si no, solo una animación breve.
    // Cuando el entorno Android está listo desaparece y la app abre al instante.
    // Antes de la animación de arranque (que va siempre encima) y antes de descargar/descomprimir nada
    await maybeSuggestRoomierDisk();
    const isFirstRun = !store.getSettings().runtime.installed;
    try {
      // Centrada en la pantalla
      const { screen: electronScreen } = require('electron');
      const disp = electronScreen.getPrimaryDisplay();
      const sw = disp.workAreaSize.width;
      const sh = disp.workAreaSize.height;
      const splashW = 480, splashH = 360;
      splashWin = new BrowserWindow({
        width: splashW, height: splashH,
        x: Math.round((sw - splashW) / 2),
        y: Math.round((sh - splashH) / 2),
        frame: false, transparent: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true,
        backgroundColor: '#0b0c0e',
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'splash-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
        },
      });
      // Se usa el nivel screen-saver para que la ventana del emulador no la tape (antes el nivel por defecto de alwaysOnTop
      // competía por el orden Z con el SetForegroundWindow del agente, y la splash quedaba detrás)
      splashWin.setAlwaysOnTop(true, 'screen-saver');
      splashWin.loadFile(path.join(__dirname, 'ui', 'splash.html'));
      splashWin.once('ready-to-show', () => splashWin.show());
      // IPC: número de versión, marca de primera ejecución, cierre
      ipcMain.handle('splash:version', () => app.getVersion());
      ipcMain.handle('splash:isFirstRun', () => isFirstRun);
      // Si los componentes vienen en el paquete: la animación de arranque cambia el texto, para no decir «descargando» a quien ya tiene la imagen incluida
      ipcMain.handle('splash:bundled', () => !!bundledRuntimeDir);
      ipcMain.on('splash:close', () => {
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        splashWin = null;
      });
    } catch (e) {
      appLog(`splash window failed: ${e.message}`);
      splashWin = null;
    }
    // Envía progreso / señal de fin a la splash (variables de nivel de módulo, ver la explicación al principio del archivo)
    splashProgress = (p) => {
      if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('splash:progress', p);
    };
    // La señal de desvanecer se envía una sola vez; además hay un «fusible»: si la splash no se cierra sola en 2,5 s
    // (proceso de interfaz colgado / IPC perdido), el proceso principal la cierra a la fuerza; nunca se deja la pantalla de inicio en el escritorio.
    let splashDoneSent = false;
    splashDone = () => {
      if (splashDoneSent) return;
      splashDoneSent = true;
      if (!splashWin || splashWin.isDestroyed()) return;
      try { splashWin.webContents.send('splash:done'); } catch (_) { /* ignore */ }
      setTimeout(() => {
        try {
          if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        } catch (_) { /* ignore */ }
        splashWin = null;
      }, 2500).unref?.();
    };
    // Tiempo límite de respaldo: aunque ningún camino dispare splashDone (por ejemplo, un fallo de arranque atascado) también se cierra,
    // si no, la splash quedaría flotando en el centro de la pantalla: la imagen más molesta de «varias ventanas».
    setTimeout(() => { if (!splashDoneSent) splashDone(); }, 180000).unref?.();

    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // La búsqueda de Windows indexa los .lnk del menú Inicio; solo en el escritorio la app «no se encontraría»;
      // en Linux el equivalente es la carpeta del menú de aplicaciones de freedesktop.
      startMenuDir: process.platform === 'win32'
        ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        : path.join(process.env.HOME || app.getPath('home'), '.local', 'share', 'applications'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    // ---- Motor de asignación de teclas ----
    const keymapEngine = new KeymapEngine({
      execInput: (cmd) => runtime.client().shell(cmd, { timeout: 4000 }),
      getSize: () => {
        // Usa el tamaño actual de la pantalla (horizontal 1280x720 / vertical 720x1280)
        const land = !!(store.getSettings().display || {}).landscape;
        return land ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
      },
    });
    // Carga desde la configuración la tabla de asignación de cada app
    const savedMaps = (store.getSettings().engine || {}).keymaps || {};
    for (const [pkg, mappings] of Object.entries(savedMaps)) {
      if (Array.isArray(mappings) && mappings.length) keymapEngine.setMap(pkg, mappings);
    }
    // Activado por defecto (el usuario puede desactivarlo en Configuración)
    keymapEngine.enable(store.getSettings().engine.keymapEnabled !== false);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // Para que el actualizador lea el prefijo de espejo de la configuración
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // Agrupador de rueda: los giros dentro de una ventana de tiempo solo inyectan un input swipe, por la adb shell persistente.
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // Agente de ventanas: solo se encarga de incrustar la ventana del emulador. El gancho global de ratón solo se instala según la configuración con la ventana de la app en primer plano.
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // Rotar cambia la resolución lógica de Android; lo hace el cliente adb
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // Se pasa un getter: si cambian las teclas en Configuración, se aplica en el próximo focus / refresco de la ventana sin reiniciar
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
      // La ventana de imagen la busca el agente por ámbito de proceso (la ventana del emulator integrado la lanzamos nosotros)
      windowTargets: () => null,
      // Barra de controles flotante del modo de ventana independiente (se puede desactivar en Configuración)
      controlBar: () => store.getSettings().display.controlBar !== false,
    });
    appWin.onCloseApp((pkg) => {
      // Cerrar la ventana = detener esa app; al cerrar la última ventana el contenedor queda en reposo (baja prioridad, deja de sondear),
      // pero el entorno Android se mantiene y la próxima apertura es instantánea en vez de un nuevo arranque en frío.
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
      // Un cierre externo (Alt+F4 / cerrar desde la barra de tareas) también debe borrar la marca de app actual; si no, el menú de la bandeja
      // seguiría mostrando «Cerrar la aplicación actual (xxx)» sin hacer nada al pulsarlo (la app ya se detuvo).
      if (currentAppPkg === pkg) currentAppPkg = null;
      try { send('apps:changed'); } catch (_) { /* ignore */ }
    });

    // «Qué ventanas son nuestras» = carpeta del runtime + carpeta engine incluida en el paquete.
    // El agente de ventanas solo puede tocar ventanas creadas por esos procesos; ninguna otra app Qt (WeChat 4.x es Qt6,
    // con la misma clase de ventana que el emulador) se puede tocar; ver SetScope en agent.ps1.
    const agentScope = () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      return dirs.filter(Boolean);
    };
    // El alcance se guarda en la memoria del proceso del agente y se pierde si el agente se recrea; por eso se reenvía antes de cada supresión de arranque.
    armAgent = async (agent) => {
      if (!agent) return { ok: false };
      const dirs = agentScope();
      // El segundo parámetro es el pid de este proceso: con él el agente se niega a incrustar ventanas en ventanas que «no son nuestras»
      await agent.scope(dirs, process.pid).catch(() => null);
      if (!dirs.length) appLog('agent scope vacío: no se oculta ninguna ventana (para no afectar a otros programas)');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // Si el proceso del agente sale inesperadamente se recrea, y hay que volver a conectar los oyentes de eventos (la versión anterior perdía aquí
    // el clic derecho = atrás y la rueda, con el síntoma «tras un rato ya no responde»).
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
        // El agente nuevo no tiene la información de alcance; sin reenviarla no se atreve a tocar ninguna ventana
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // La «compuerta» de supresión de ventanas de comandos debe abrirse antes de que se cree el proceso del emulador.
    // La implementación anterior «ocultaba 4 s después de iniciar LanzadorAPK», y para entonces el emulador ya había
    // creado la consola de qemu: el usuario veía una ventana negra fugaz.
    runtime.emulator.onBeforeSpawn = async () => {
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // El agente de ventanas es un proceso PowerShell residente; su arranque en frío tarda unos 300–600 ms.
    // Se lanza antes, para no empezar a esperar justo cuando hay que ocultar ventanas.
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // Comprobación automática: primero se programa la tarea periódica y la primera ronda corre 25 s después de iniciar.
    // Se retrasa porque justo tras arrancar adb / disco / instantáneas todavía se están acomodando,
    // y el estado recolectado entonces se malinterpreta fácilmente (por ejemplo «no se ve el dispositivo» cuando solo no terminó de arrancar).
    scheduleAutodebug();
    setTimeout(() => { runAutodebug().catch(() => {}); }, 25000).unref?.();

    // Las apps instaladas con versiones antiguas no tienen el campo orientation (esa función no existía entonces).
    // Sin completarlo, «según la app» solo podría usar «la orientación actual de la pantalla» para ellas, y las apps verticales
    // seguirían con bordes negros en una pantalla horizontal. Aquí se completa una vez con el análisis sin conexión del manifiesto del APK incluido;
    // solo lee el directorio central + AndroidManifest, unos cientos de ms y una sola vez.
    try {
      const { parseApk } = require('./core/apk');
      const filled = [];
      for (const app of store.getApps()) {
        if (app.orientation || !app.apkPath) continue;
        if (!fs.existsSync(app.apkPath)) continue;
        try {
          const meta = parseApk(app.apkPath);
          if (meta.orientation) {
            store.upsertApp({ package: app.package, orientation: meta.orientation });
            filled.push(`${app.label}=${meta.orientation}`);
          }
        } catch (_) { /* Las apps que no se pueden analizar se omiten, sin afectar el arranque */ }
      }
      if (filled.length) appLog(`orientation backfill: ${filled.join(', ')}`);
    } catch (_) { /* ignore */ }

    // Espacio libre en disco: con menos de 3 GB Android no arranca (fallan las escrituras de imagen/instantánea).
    // En vez de dejar al usuario con un «no abre» sin entender por qué, se le dice directamente dónde cambiarlo.
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Espacio en disco insuficiente', `Solo quedan ${(freeMB / 1024).toFixed(1)} GB. Ve a «Configuración → Integración con el sistema» y mueve los datos o el runtime de Android a otro disco, o libera espacio.`);
          send('toast', { type: 'error', message: `Solo quedan ${(freeMB / 1024).toFixed(1)} GB en disco; puede que Android no arranque (Configuración → Integración con el sistema para cambiar de disco)` });
        }, 3000).unref?.();
      }
    }

    // Versiones antiguas solo creaban el acceso del escritorio / el icono era null: al iniciar se completan solos, sin intervención del usuario
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('Accesos directos completados', fixed.join(','));
      }
    }).catch(() => {});

    // F11 pantalla completa / cambio de ventana; los atajos globales solo funcionan mientras LanzadorAPK está vivo
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }
    // Atajo de rotación: en modo de ventana nativa la ventana contenedora está oculta y el Ctrl+R de la barra de título no recibe el foco,
    // así que se registra además una combinación global. Se usa Ctrl+Alt+R y no Ctrl+R: este último chocaría con
    // «actualizar» de navegadores/editores, y registrarlo globalmente anularía el actualizar de los otros programas del usuario.
    try {
      globalShortcut.register('CommandOrControl+Alt+R', () => {
        if (currentAppPkg) rotateCurrentApp().catch(() => {});
      });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);
    else {
      // No se inició una app directamente: la splash desaparece cuando la ventana principal está lista
      if (typeof splashDone === 'function') {
        setTimeout(() => splashDone(), 800);
      }
    }

    // Precalentamiento: mantener el entorno Android cargado, como WSA y similares.
    // Al abrir LanzadorAPK se prepara en segundo plano (con la ventana oculta todo el tiempo), y luego abrir una app solo necesita un am start.
    // Solo se precalienta si «ya hay apps instaladas + un runtime utilizable», para no gastar memoria en el primer uso o cuando solo se administra.
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1,2 s bastan para que la ventana dibuje su primer fotograma. Antes se esperaban 4 s y el usuario ya había pulsado una app,
      // y «abrir» y «precalentar» competían por el mismo bloqueo del AVD, lo que era aún más lento.
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // Durante el arranque se ocultan la ventana del emulador y la consola de qemu; el usuario no debe ver ninguna ventana
          // Ojo con el await: si se hace spawn sin esperar a que funcione, la ventana negra aparece seguro.
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // Si falla el precalentamiento se sigue suprimiendo la ventana del emulador: puede que solo sea lento y arranque un poco después,
            // y el usuario no debe ver un emulador en el escritorio porque «falló el precalentamiento».
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* Un fallo del precalentamiento no afecta la apertura normal posterior */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // La instalación de componentes en la primera ejecución se retrasa 20 s: durante el arranque en frío el disco/la CPU ya están al máximo,
    // y descargar y descomprimir a la vez solo trabaría más el escritorio. Si de verdad se abre una app, ensure() lo prepara.
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'El runtime se preparó automáticamente' });
      }).catch(() => {});
    }, 20000).unref?.();

    // 8 s después de iniciar se busca en silencio una versión nueva (solo tiene sentido empaquetado). Si la hay solo se avisa;
    // nunca se descarga automáticamente: actualizar es algo que el usuario hace al pulsar «Actualizar ahora».
    // Se omite en la versión de la Store (MSIX): la carpeta de instalación es WindowsApps de solo lectura; la autoactualización no puede escribir ahí ni
    // cumpliría las reglas; las actualizaciones las gestiona Microsoft Store.
    if (app.isPackaged && !store.STORE_BUILD) {
      // issue #98: primero se busca «una actualización descargada y descomprimida la vez anterior, pero cuyo reemplazo/reinicio no se completó».
      // Si existe se repite directamente el reemplazo+reinicio con el contenido local, sin volver a bajar el paquete: la solución de raíz al bucle de actualización.
      // Va antes de buscar versiones nuevas, para que resumable y la nueva comprobación no compitan por la barra de progreso.
      let resuming = false;
      try {
        const job = updater.findResumableJob();
        if (job) {
          resuming = true;
          appLog(`resuming pending update ${job.version} from cached payload`);
          send('update:progress', { stage: 'apply', percent: 100, message: 'Terminando la actualización que quedó pendiente…' });
          updater.apply(job);
          setTimeout(() => { quitting = true; app.quit(); }, 900);
        }
      } catch (e) { appLog(`resume check failed: ${e.message}`); }
      // Si hay algo que completar no se lanza en paralelo otra búsqueda de versiones; pero no se puede usar return para salir de todo el callback de inicio.
      if (!resuming) setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // Ya no se muestra una notificación del sistema aparte: los avisos al iniciar van todos a la «tarjeta de bienvenida» dentro de la app,
            // para que el inicio automático no saque otra burbuja en la esquina inferior derecha (una de las «ventanitas emergentes» que reportaban).
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // La sincronización de archivos / el sondeo de notificaciones ya no corren siempre: solo cuando hay de verdad ventanas de apps en el contenedor
    // (ver onContainerActive).

    // Prueba de humo: sale tras la captura, para verificar automáticamente que la interfaz se dibuja bien
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // El panel del runtime ya está dentro de la configuración: --setup equivale a --settings y abre directamente la configuración para la captura
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // La ventana puede estar tapada y dar un fotograma viejo: se fuerza el redibujado + dos capturas seguidas, usando la segunda
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // Una captura de la sección «Rendimiento y uso de recursos» (la que más controles tiene en la configuración)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // Una captura de la sección «Fuentes de descarga y actualización»
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // Otra captura de la sección «Acerca de» (GitHub / Powered by)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] falló la captura de pantalla', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // Al cerrar la ventana normalmente solo se oculta en la bandeja (el evento close está interceptado);
    // llegar aquí significa que de verdad se quiere salir, y hay que dejarlo pasar; si no, el proceso quedaría vivo ocupando el bloqueo de instancia única.
    // Se anota una línea: al investigar «la ventana de la app estaba abierta y LanzadorAPK desapareció solo», esta línea permite
    // distinguir «se cerraron todas las ventanas» de «el proceso fue terminado desde fuera».
    appLog(`window-all-closed quitting=${quitting}`);
    if (quitting) app.exit(0);
  });

  // Cuando falla el proceso de interfaz / de GPU, Electron por defecto solo deja la ventana en blanco y no siempre sale del proceso principal;
  // pero es la causa más común de «la imagen desapareció de golpe», así que siempre debe quedar en el registro.
  app.on('child-process-gone', (_e, d) => {
    try {
      appLog(`child-process-gone type=${d && d.type} reason=${d && d.reason} exit=${d && d.exitCode}`);
    } catch (_) { /* Si no se puede escribir el registro, no pasa nada */ }
  });

  let quitReady = false;
  /**
   * Solo se detiene el runtime si «todavía lo gestiono yo».
   *
   * La alternancia de dos instancias es un caso real: la app no responde → el usuario pulsa otra vez. Al iniciar la segunda, la primera
   * ya liberó el bloqueo de instancia única pero aún no salió del todo; la nueva toma el emulador y empieza am start;
   * luego la vieja ejecuta dispose() y mata el emulador que está usando la nueva:
   * en el registro aparece «El runtime se cerró (code=0)» seguido de «device 'emulator-5554' not found».
   * owner.pid se sobrescribe en cada inicio, así que el dueño es quien inició último.
   */
  const releaseRuntime = () => {
    let mine = true;
    try {
      const owner = Number(String(fs.readFileSync(path.join(store.DATA_DIR, 'owner.pid'), 'utf8')).trim());
      mine = !owner || owner === process.pid;
    } catch (_) { mine = true; }
    if (mine) {
      runtime?.dispose();
    } else {
      appLog('Otra instancia tomó el control del runtime; no se detiene (si no, cerraría su emulador)');
    }
  };
  app.on('before-quit', (e) => {
    quitting = true;
    appLog(`before-quit ready=${quitReady}`);
    // Antes de salir el agente de ventanas debe «desprender + ocultar» la ventana del emulador. Este paso es asíncrono
    // (hay que esperar la respuesta del agente), así que el primer before-quit se intercepta y se sale de verdad al terminar la limpieza.
    // Sin este paso, al destruirse la ventana anfitriona Windows volvería a colgar la ventana hija del emulador en el escritorio y la mostraría:
    // el síntoma es «tras cerrar LanzadorAPK sigue quedando una ventana negra de Android Emulator en el escritorio».
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { winAgent?.dispose(); } catch (_) { /* ignore */ }
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        releaseRuntime();
        // La ventana oculta de decodificación de iconos también es una ventana; sin cerrarla window-all-closed nunca se dispararía
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    releaseRuntime();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
