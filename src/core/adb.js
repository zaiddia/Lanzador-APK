'use strict';
/**
 * Envoltorio del cliente adb
 * Solo lo que necesita lanzadorapk: instalar / iniciar / detener / desinstalar / sincronizar archivos / capturas
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { autoRotateSetting } = require('./orientation');

/**
 * Valor que se escribe en el invitado para el interruptor de «rotación automática» ('1' activado / '0' desactivado).
 * No decide la orientación de la pantalla: lo que manda es `wm user-rotation lock 0` + `wm set-ignore-orientation-request`,
 * que vienen justo después en setOrientation / resetDisplayOverrides.
 * Aquí solo se hace que el interruptor de los ajustes del sistema aparezca «activado», por si alguna app lee ese ajuste.
 */
function guestAutoRotate() {
  try { return autoRotateSetting(store.getSettings()); } catch (_) { return '1'; }
}

/**
 * Densidad lógica del diseño de tableta.
 * 720 de ancho ÷ (190/160) = 606 dp ≥ 600 dp, justo por encima del punto de corte de tableta de Android;
 * con 320 dpi (valor por defecto de la imagen) solo hay 360 dp, diseño de teléfono.
 */
const TABLET_DENSITY = 190;
function tabletDensity() {
  try {
    return (store.getSettings().display || {}).tabletMode !== false ? String(TABLET_DENSITY) : 'reset';
  } catch (_) {
    return String(TABLET_DENSITY);
  }
}

/**
 * Posibles ubicaciones de adb en el sistema. **A propósito solo se listan el Android SDK y carpetas de instalación manual comunes**:
 * el adb que traen otros emuladores (MuMu / LDPlayer / BlueStacks) no está aquí: usarlo haría
 * heredar el estado de su servidor (puertos, autorizaciones, cortes offline), lo que choca con el «funcionamiento independiente».
 * Nuestro propio adb está en la carpeta del runtime y siempre tiene la máxima prioridad (ver engine.adbPath).
 */
const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:/Android/platform-tools/adb.exe',
  'C:/adb/adb.exe',
];

/**
 * Traduce el motivo original del fallo de pm install a un mensaje comprensible para el usuario.
 * Conserva el código de error original al final, para poder buscarlo.
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'Error al instalar: esta app solo incluye librerías nativas ARM (muchas apps lo hacen), '
      + 'y la imagen del sistema actual no tiene capa de traducción ARM. Lanzador APK cambiará automáticamente a la imagen compatible con la capa de traducción nueva y lo reintentará.',
    INSTALL_FAILED_OLDER_SDK:
      'Error al instalar: la app necesita una versión de Android más nueva que la del runtime (hace falta una imagen del sistema más reciente).',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      'Error al instalar: el APK no tiene una firma válida.',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      'Error al instalar: la firma no coincide con la versión instalada; desinstala primero la versión anterior.',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      'Error al instalar: ya hay una versión más nueva instalada y no se puede volver a una anterior.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      'Error al instalar: no queda espacio en el disco del runtime; libera espacio e inténtalo de nuevo.',
    INSTALL_FAILED_INVALID_APK:
      'Error al instalar: el APK está dañado o incompleto (quizá la descarga no terminó); vuelve a descargarlo.',
    INSTALL_FAILED_INVALID_URI: 'Error al instalar: la ruta del APK tiene caracteres especiales; mueve el archivo a una ruta solo en ASCII e inténtalo de nuevo.',
    INSTALL_FAILED_ALREADY_EXISTS: 'Error al instalar: ya existe una app con el mismo nombre y otra firma; desinstálala primero.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Error al instalar: la firma no coincide con la versión instalada; desinstala primero la versión anterior.',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      'Error al instalar: esta app está hecha para versiones muy antiguas de Android (targetSdk demasiado bajo) y Android 14 la bloquea por defecto. '
      + 'Lanzador APK lo reintentará automáticamente con el parámetro oficial para omitir el bloqueo.',
    INSTALL_FAILED_TEST_ONLY: 'Error al instalar: es un paquete solo para pruebas; se reintentó automáticamente con el parámetro de paquete de prueba.',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: 'Error al instalar: la app necesita funciones del dispositivo (como librerías de un fabricante) que el runtime no tiene.',
    INSTALL_FAILED_USER_RESTRICTION: 'Error al instalar: el sistema restringió la instalación; reinicia el runtime e inténtalo de nuevo.',
    INSTALL_FAILED_CONFLICTING_PROVIDER: 'Error al instalar: conflicto de ContentProvider con una app ya instalada; desinstala la app en conflicto.',
    INSTALL_FAILED_INTERNAL_ERROR: 'Error al instalar: error interno del sistema (suele pasar si falta espacio o el arranque no terminó); reinicia el runtime e inténtalo de nuevo.',
  };
  const msg = table[tag];
  return msg ? `${msg} (${tag})` : `Error al instalar: ${raw}`;
}

/** Traduce el registro de un cierre inesperado tras iniciar a una causa comprensible */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || 'App'} se cierra al abrir: la capa de traducción ARM no es compatible con el manejo de señales de esta app. `
      + 'Lanzador APK cambiará automáticamente a la imagen compatible de Android 14 y lo reintentará.';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || 'App'} se cierra al abrir: faltan librerías nativas del dispositivo (puede que la app solo tenga versión ARM). `
      + 'Se cambiará automáticamente a la imagen compatible con traducción ARM y se reintentará.';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || 'App'} se cierra al abrir (error interno de la app; puede deberse al entorno del emulador o a que faltan los servicios de Google).`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || 'App'} no pudo iniciar: el sistema rechazó la solicitud (problema de permisos o de firma).`;
  }
  return `${pkg || 'App'} no pudo iniciar ${t ? `: ${t.slice(0, 240)}` : ' (el proceso no sigue activo)'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lee la columna state de un serial en `adb devices`.
 * Clave: un dispositivo unauthorized también responde 'device' en `get-state`; solo la columna state
 * de la lista de dispositivos distingue authorized / unauthorized / offline; la detección en el arranque se autocorrige con esto.
 */
function parseDeviceState(text, serial) {
  const lines = String(text || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const m = /^(\S+)\s+(unauthorized|offline|recovery|sideload|no\s+permissions|device)\b/i.exec(line.trim());
    if (!m) continue;
    if (serial && m[1] !== serial) continue;
    const st = m[2].toLowerCase().replace(/\s+/g, '');
    if (st === 'device') return 'device';
    if (st === 'unauthorized' || st === 'nopermissions') return 'unauthorized';
    return st; // offline / recovery / sideload
  }
  return 'no-device';
}

/** Detecta unauthorized en los errores de shell causados por el diálogo «Permitir depuración USB» sin confirmar */
function isUnauthorizedError(raw) {
  return /\bunauthorized\b|no permissions|confirm.*(allow|debug)/i.test(String(raw || ''));
}

/** Saca la ruta real de cada APK de la salida de `pm path <pkg>` */
function parsePmPaths(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^package:/.test(l)).map((l) => l.slice(8).trim()).filter(Boolean);
}

/** Puntos de entrada ya resueltos (adbPath|pkg → activity), válidos 10 minutos */
const LAUNCHER_CACHE = new Map();

/**
 * El adb de Windows maneja mal rutas no ASCII (muy común con nombres de usuario o carpetas de descarga con acentos).
 * Antes de instalar se copia el APK a una carpeta temporal solo ASCII y se borra al terminar.
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'lanzadorapk-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Arma con la «Activity» el componente completo que necesita am start -n.
 * Hay que admitir dos formas:
 *   - solo nombre de clase (lo que guardaban las apps.json antiguas): `MainActivity` / `.MainActivity` → `<pkg>/<activity>`
 *   - componente completo (salida de `cmd package resolve-activity`): `com.a.b/.Main` → se usa tal cual
 * La implementación anterior siempre armaba `${pkg}/${activity}`; con un componente completo quedaba `pkg/pkg/class`,
 * am start se cancelaba (result code=-92) y el síntoma era «al tocar el icono solo se ve el escritorio de Android».
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** Toma de la salida de `cmd package resolve-activity --brief` el componente de pkg (tolera líneas vacías/priority al final) */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * El límite de tiempo de adb install era fijo en 240 s, pero con paquetes de más de 2 GB en discos lentos
 * «push + instalar + dexopt» supera fácilmente 4 minutos: al agotarse se trataba como instalación fallida,
 * y el usuario veía «el paquete grande no responde / falla». Aquí se escala según el tamaño, hasta 20 minutos.
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Interpreta la salida de `find -exec stat -c '%Y|%s|%n'`.
 * Devuelve null si la salida no parece de stat (el dispositivo no lo admite).
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // Hay salida pero ninguna línea se pudo interpretar → no es formato stat
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // Proceso `adb shell` persistente
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // Se deja al PATH
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
    // La imagen de Play Store exige autorización ADB: el servidor adb del equipo y el adbd del invitado deben usar la misma
    // adbkey. Lo oficial es que adb/emulator compartan %USERPROFILE%\.android\adbkey{,.pub};
    // al arrancar, emulator graba adbkey.pub en /data/misc/adb/adb_keys del invitado.
    // Se le indica explícitamente al servidor adb dónde está la clave pública: en algunos entornos ANDROID_SDK_HOME o un runtime portátil
    // hacen que adb la busque en otro lugar, y cada arranque en frío muestra «Permitir depuración USB» → device unauthorized.
    if (!env.ADB_VENDOR_KEYS) {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const keyDir = path.join(home, '.android');
      try { if (home && fs.existsSync(keyDir)) env.ADB_VENDOR_KEYS = keyDir; } catch (_) { /* ignore */ }
    }
    return env;
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // Puerto de servidor adb propio, compartido con el emulador del runtime (por defecto 5044), aislado del 5037
        // que usan WSA / adb de otros emuladores, para que no nos expulsen el registro una y otra vez y el dispositivo quede offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // adb install escribe el motivo del fallo en stdout y sale con código distinto de 0;
          // la versión anterior solo miraba stderr y el usuario solo veía un «falló» genérico.
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} falló: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * Canal de entrada persistente.
   * La rueda y «atrás» son entradas muy frecuentes: lanzar un adb por cada paso de rueda crea montones de procesos
   * y el escritorio se traba. Aquí se reutiliza un mismo `adb shell`, una línea por comando, y al final
   * se hace echo de una marca de fin: así se sabe cuándo terminó de verdad el comando y se genera contrapresión,
   * sin que los comandos de deslizar se acumulen en la shell.
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // La línea debe ser exactamente la marca: algunas shells repiten la línea de comando completa,
          // y con contains se confundiría «recién escrito» con «ya ejecutado», y los deslizamientos se acumularían.
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* Se ignora: quien llama se encarga de casos como el dispositivo desconectado */ });
    p.stdin.on('error', () => { /* Al desconectar, exit lo limpia todo */ });
    p.on('error', () => { this._failWaiters(new Error('No se pudo iniciar adb shell')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell se cerró'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** Ejecuta un comando input de la lista permitida; si falla se recicla la sesión y quien llama puede usar un adb puntual */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('Comando de entrada no válido');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__LANZADORAPK_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('El comando input superó el tiempo de espera'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('El canal de entrada se cerró'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* Puede que ya esté conectado */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state no sirve sin serial; se usa la lista de dispositivos
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  /**
   * Lee el estado real de este serial en `adb devices`: device / unauthorized / offline / no-device.
   * get-state, que usa isOnline(), no distingue authorized de unauthorized (ambos dan 'device');
   * la detección en el arranque usa este método para reconocer «diálogo de autorización atascado» y autocorregirse rápido.
   */
  async deviceState() {
    try {
      const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
      return parseDeviceState(stdout, this.serial);
    } catch (_) {
      return 'no-device';
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * Instala un APK con degradación automática:
   *  - por defecto sin -g (otorgar todos los permisos automáticamente hace fallar PermissionController en algunas imágenes);
   *  - con --bypass-low-target-sdk-block, para que Android 14 no rechace apps con targetSdk antiguo;
   *  - si adb no reconoce el parámetro / ruta con acentos / error de transferencia, reintenta con otra forma;
   *  - NO_MATCHING_ABIS lanza un error con code para que la capa superior cambie automáticamente a la imagen compatible.
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`El APK no existe: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g otorga los permisos de ejecución automáticamente y evita los avisos dentro de la app; si la imagen no lo admite se quita
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* Si no se obtiene el tamaño, se usa el valor por defecto */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // adb antiguo no reconoce el parámetro nuevo / marca de paquete de prueba → otra forma
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // Errores de transferencia (dispositivo desconectado, reinicio del servidor adb): se reintenta una vez
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // Sin código de error claro: se prueba la última forma
        }
      }
      const err = new Error(friendlyInstallError(last || 'Error al instalar, sin una causa clara'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** Los APK divididos (varias partes de .apks / .xapk) usan install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('No hay APK divididos que instalar');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('Error al instalar el APK dividido');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // Algunos dispositivos necesitan indicar el usuario
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  /**
   * Si de verdad quedó instalado: no basta con lo que dice PackageManager.
   *
   * Si la instantánea y la partición de datos no coinciden, `pm path` devuelve
   * `package:/data/app/.../base.apk` (installed=true) porque packages.xml aún guarda el registro, pero ese APK
   * ya se revirtió. Un `am start` solo fallaría. Por eso se revisa con `test -f/-s` cada
   * ruta que da pm; si el archivo no está (o está vacío) se considera «no instalado de verdad» y la capa superior reinstala.
   *
   * @returns {Promise<boolean>}
   */
  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    const paths = parsePmPaths(out);
    if (!paths.length) return false;
    // Todas las partes del APK deben estar; si falta una no arranca. Se juntan en una sola shell para ahorrar un viaje de adb.
    const checks = paths.map((p) => `[ -s "${p}" ]`).join(' && ');
    const probe = await this.shell(`${checks} && echo __LANZADORAPK_PRESENT__`, { timeout: 10000 }).catch(() => '');
    return /__LANZADORAPK_PRESENT__/.test(String(probe));
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** Resuelve con el sistema la Activity de inicio real (respaldo cuando no se puede leer del manifiesto) */
  /** Tras actualizar una app el punto de entrada puede cambiar; antes de resolver se quita ese paquete de la caché */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  async resolveLauncher(pkg) {
    // Resolver la Activity de entrada cuesta un viaje de adb (~200-400 ms) y no cambia durante una sesión.
    // Se guarda en caché y la segunda vez que se abre la misma app se omite; caduca a los 10 minutos y una reinstalación no usará una entrada equivocada.
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* Se recurre a monkey */ }
    return null;
  }

  /** Si la app de verdad está viva: que am start diga éxito ≠ que el proceso no se haya cerrado */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // Sin registro de cierre no se puede afirmar que falló: algunas apps grandes tardan 20-40 s en el primer arranque
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * Inicia la app con tres niveles de degradación:
   *   ventana independiente freeform → pantalla completa normal → monkey como respaldo;
   * cada vez se verifica que el proceso siga vivo; si se cierra se captura logcat y se lanza un error con code para que la capa superior cambie de imagen.
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // Hay que usar el punto de entrada LAUNCHER que resuelve el sistema, no solo la Activity principal leída del APK:
    // muchas apps hacen la inicialización real en la pantalla de inicio; entrar directo a la Activity principal
    // lanza "had you called RpcService.init" y la app parpadea y se cierra.
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved puede ser un componente completo (pkg/class) o solo el nombre de clase (apps.json antiguo);
    // aquí se unifica al componente completo que pide am start -n, para que el sistema no cancele pkg/pkg/class.
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n(la app todavía está cargando)`;
      lastError = alive.crash || lastError;
      // Si el registro de cierre apunta claramente a la capa de traducción ARM no se reintenta; la capa superior cambia a la imagen compatible
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // Respaldo con monkey: en algunas imágenes am start -a/-c/-p no encuentra el launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // Si hay información clara del cierre se usa; si no, se conserva el error original de inicio
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** Activa el soporte freeform (ventanas independientes); si falla no afecta el flujo principal */
  async ensureFreeform() {
    // Se combina en un solo adb shell: 4 execFile independientes tardan más de 600 ms en Windows,
    // y esto ocurre justo durante la espera de «abrir la app».
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // El ls -l de Android tiene dos formatos, «con group» y «sin group», y la fecha puede ser
      // "2026-11-12 18:52" o "Nov 12 18:52"; una expresión regular fija no interpretaría nada.
      // El segundo número tras los permisos es el tamaño del archivo y el último segmento es el nombre.
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // El nombre va después del token «hora:minuto» (la fecha ocupa 2-3 tokens, no es fijo)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * Lista remota con mtime real (toybox stat).
   * La fecha de ls -l es «mes día hora:minuto» y no se puede convertir con fiabilidad: la sincronización creería que «todo cambió siempre».
   * Devuelve null si el dispositivo no admite stat; quien llama debe usar listRemote.
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Borrar datos de la app */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
    // Al borrar los datos también se pierden los permisos; el próximo arranque debe volver a otorgarlos y no usar la caché permGranted
    try { store.upsertApp({ package: pkg, permGranted: false }); } catch (_) { /* ignore */ }
  }

  /** Exporta los datos de la app (run-as en Windows/versiones de depuración; si no, adb backup como respaldo) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/lanzadorapk-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * Otorga de una vez los permisos de ejecución que pide la app.
   * Si no se otorgan hay dos consecuencias: ① el primer arranque muestra el aviso de permisos y el usuario cree que «la app no abrió»;
   * ② tras borrar datos (pm clear) los permisos se pierden y la app se queda en la pantalla de permisos.
   *
   * Rendimiento: `dumpsys package` lanza un app_process en el invitado (probado: 1–3 s),
   * y cada `pm grant` / `cmd appops set` lanza otro. En una app con más de diez permisos,
   * solo esta parte se comía más de 20 s (en el registro, permissions granted pasaba de +18 s a +42 s).
   * Una vez otorgados, los permisos persisten; solo se pierden al reinstalar o con pm clear,
   * así que se anota en apps.json y los siguientes arranques lo omiten; al borrar datos/reinstalar se quita la marca.
   */
  async grantRuntimePermissions(pkg) {
    try {
      const rec = store.getApp(pkg);
      if (rec && rec.permGranted === true) return [];
    } catch (_) { /* Si no se puede leer el registro, se asume que no se otorgaron */ }
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // Sale de la sección runtime permissions
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // Todos los permisos de una vez: cada pm grant es un proceso de más de 150 ms en Windows,
    // cuatro o cinco permisos son 1 s, y estos comandos no dependen entre sí.
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // Los permisos especiales van por appops; si no, igual aparece el aviso
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    // Solo se marca si los comandos terminaron de verdad: si fallan a mitad se reintenta la próxima vez, sin un falso «ya otorgados»
    try { store.upsertApp({ package: pkg, permGranted: true }); } catch (_) { /* ignore */ }
    return granted;
  }

  /**
   * Pone el sistema en modo «esta es la app»:
   *  - quita la pantalla de bloqueo, para que tras arrancar no tape la app;
   *  - oculta la barra de estado (mantiene los botones de navegación inferiores para ir atrás/inicio sin el ratón a mano);
   *  - desactiva las animaciones del sistema; en equipos modestos se nota mucho.
   * Todos son comandos de nivel settings, de unos cientos de milisegundos y sin efectos si se repiten.
   */
  async prepareForeground() {
    // Antes eran 7 comandos en serie, cada uno con un proceso adb nuevo (150–250 ms en Windows),
    // en total 1–1,7 s, todo dentro de la espera de «abrir la app». Juntos en una shell queda un solo viaje.
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // Barra de tareas de pantalla grande: con densidad de tableta, Pixel Launcher deja fija una Taskbar abajo,
      // que tapa el contenido de la app y amontona los botones abajo a la izquierda (los «botones desplazados» que reportaron usuarios).
      // Ver disableLauncherTaskbar(): aquí se corrige en cada arranque; es idempotente y solo cuesta un viaje más.
      'settings put global enable_taskbar 0',
      // Comprobación de conexión: Android decide si «de verdad hay internet» consultando un endpoint de verificación;
      // si no lo alcanza, marca la red con «!» (conectado sin acceso a internet)
      // y algunas apps se consideran sin conexión y no cargan contenido. Se fija el endpoint estándar de Google que responde 204.
      // Se escribe en cada arranque (idempotente, en la misma shell, casi sin costo), así se corrige solo aunque se restaure
      // una instantánea antigua o el usuario haya cambiado los ajustes del sistema.
      'settings put global captive_portal_http_url http://connectivitycheck.gstatic.com/generate_204',
      'settings put global captive_portal_https_url https://www.google.com/generate_204',
      'settings put global captive_portal_mode 0',
      // Atención: aquí ya no se escriben wm user-rotation / accelerometer_rotation.
      // La orientación la fijan setOrientation / resetDisplayOverrides según el estado horizontal/vertical actual;
      // fijar lock 0 aquí devolvería una pantalla horizontal a vertical (imagen acostada).
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** Clic derecho / botones laterales / atajos: por el canal de entrada persistente; «atrás» con clic derecho ya no tiene ~100 ms de retraso */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // Si el runtime acaba de reiniciar y la shell persistente aún no conecta, se usa un adb puntual; no se puede perder este clic
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * Cambia entre «diseño de teléfono / diseño de tableta».
   *
   * Clave: **nunca cambiar wm size**. Cambiar wm size cambia el tamaño físico del framebuffer del invitado
   * (720x1280 -> 1280x720), pero la ventana Qt incrustada mantiene su tamaño/orientación, y la imagen queda
   * aplastada o acostada 90°, con las coordenadas del ratón descuadradas. Peor aún, el cambio de wm size persiste
   * en /data y sigue tras reiniciar: esa era la causa de que los usuarios vieran una y otra vez «bordes negros / no llena / no responde a clics».
   * 
   *
   * Ahora solo se cambia la densidad lógica (wm density); el framebuffer siempre es 720x1280 en vertical:
   *   - 320 dpi -> smallestWidth 360 dp -> diseño de teléfono
   *   - 190 dpi -> smallestWidth 606 dp (>=600 dp) -> diseño de tableta / paneles
   * Tamaño, orientación y mapeo de clics no cambian, así que no se acuesta, no hay bordes negros y los clics siempre coinciden.
   */
  async setOrientation(landscape) {
    try {
      // La rotación automática viene activada por defecto (0.5.9): se escribe accelerometer_rotation=1 en el invitado
      // para que ese interruptor de los ajustes aparezca «activado». La orientación real la deciden wm user-rotation lock 0
      // + set-ignore-orientation-request de abajo, sin influencia de los sensores, así que no gira sola.
      // El usuario puede desactivarla en Configuración → «Rotación automática de la imagen» y volver al bloqueo 0 anterior.
      await this.shell(`settings put system accelerometer_rotation ${guestAutoRotate()}; wm size reset`, { timeout: 15000 });
      // Bloqueo de orientación **0** (no 1). La orientación física de la pantalla ya la fija hw.lcd.width/height
      // (ver doctor.lcdFor); bloquear aquí en 1 volvería a girar la pantalla horizontal a un espacio lógico vertical,
      // y la imagen quedaría acostada 90°: justo la causa directa de «la horizontal no funciona bien».
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      // Paso clave: las apps que declaran portrait son obedecidas por el sistema, así que
      // la pantalla horizontal init=1280x720 se convierte en el espacio lógico vertical cur=720x1280 y la imagen vuelve a acostarse.
      // Con «ignorar las peticiones de orientación de las apps» activado, el sistema diseña según la orientación de la pantalla.
      // En modo vertical hay que desactivarlo explícitamente; si no, el true que dejó el último modo horizontal haría que la pantalla vertical
      // mostrara diseño horizontal. API < 31 no tiene este comando; si falla se ignora.
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // Tras activar freeform / ignorar peticiones de orientación, Android muestra una vez la guía «See and do more»
      // ("Double-tap outside an app to reposition it…"). Aparece encima de la app
      // y el usuario cree que el programa se rompió. Aquí se marca como ya vista de antemano y, por si acaso, se pulsa atrás una vez.
      await this.shell('settings put secure freeform_mode_confirmations confirmed', { timeout: 10000 });
      if (landscape) await this.shell('input keyevent KEYCODE_BACK', { timeout: 8000 });
      await this.shell(`wm density ${tabletDensity()}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Desactiva la barra de tareas de pantalla grande (Taskbar de Android 12L+).
   *
   * Por qué: el diseño de tableta baja la densidad a 190 dpi; 720 de ancho ⇒ sw606dp,
   * por encima del punto de corte de pantalla grande (600 dp). Pixel Launcher entonces deja fija abajo
   * una barra de tareas tipo NAVIGATION_BAR_PANEL: semitransparente, tapa el contenido de la app,
   * y los botones atrás/inicio/recientes quedan amontonados abajo a la izquierda: los «botones desplazados» de las capturas de usuarios.
   *
   * No es la barra de navegación del sistema (la de gestural overlay), así que policy_control immersive
   * no la quita; solo se puede con global enable_taskbar, y Launcher solo lo lee al iniciar,
   * así que si ya está iniciado hay que reiniciarlo. Se hace con los dos paquetes de launcher, para cubrir la versión Play y la AOSP.
   */
  async disableLauncherTaskbar() {
    try {
      await this.shell('settings put global enable_taskbar 0', { timeout: 10000 });
      // grep -c sale con 1 si no hay coincidencias; se agrega || true para que no cuente como fallo
      const out = await this.shell(
        'dumpsys window windows | grep -c "Window #.*Taskbar" || true',
        { timeout: 12000 },
      ).catch(() => '0');
      const alive = parseInt(String(out).trim(), 10) || 0;
      if (alive > 0) {
        await this.shell(
          'am force-stop com.google.android.apps.nexuslauncher; am force-stop com.android.launcher3',
          { timeout: 12000 },
        ).catch(() => '');
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Espera a que la app dibuje de verdad su primer fotograma.
   *
   * «La ventana se enganchó» y «el usuario ve la imagen» son cosas distintas: cuando arranca el proceso Application,
   * Android 12+ pone primero una pantalla Splash del sistema (icono de la app + fondo blanco) y la quita
   * cuando la Activity dibuja su primer fotograma. Si la animación de arranque desaparece antes, el usuario ve un fondo blanco
   * y cree que se colgó; por eso la animación de arranque espera a que desaparezca la Splash del sistema.
   *
   * Criterio: en la lista de ventanas ya no hay registro "Splash Screen" y el foco está en el paquete objetivo.
   * Si se agota el tiempo devuelve false y quien llama cierra la animación igual (un fallo del criterio no puede dejar al usuario atrapado en la animación).
   */
  async waitForAppFirstFrame(pkg, { timeoutMs = 12000, intervalMs = 350 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      // Hay que usar `dumpsys window` (WINDOW MANAGER completo), no
      // `dumpsys window windows`: este último solo lista ventanas y **no tiene la línea mCurrentFocus**,
      // así que focusOnApp siempre sería false y el criterio siempre agotaría el tiempo: la app ya habría dibujado
      // su imagen y la animación de arranque seguiría 12 s más antes de desaparecer.
      const out = await this.shell(
        'dumpsys window | grep -E "Splash Screen|mCurrentFocus" | head -8',
        { timeout: 8000 },
      ).catch(() => '');
      const s = String(out);
      if (s.trim()) {
        const splashAlive = /Splash Screen/.test(s);
        const focusOnApp = s.indexOf(pkg) >= 0;
        if (!splashAlive && focusOnApp) return true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  /** Al arrancar se borran sobrescrituras de wm size / density de versiones anteriores (persisten en /data y dejarían la imagen acostada) */
  async resetDisplayOverrides(landscape = false) {
    try {
      // La densidad tiene que fijarse **antes de iniciar la app**.
      // Antes aquí se hacía `wm density reset` sin condición y luego _healOrientation (1,8 s después de iniciar la app
      // / revisión cada 60 s) volvía a poner 190: un cambio de configuración «con la app en marcha».
      // Las apps que guardan DisplayMetrics en caché calculaban los dp con la densidad anterior y la imagen se encogía
      // en un rectángulo arriba a la izquierda con un gran espacio vacío a la derecha: la queja de «la app no llena la ventana».
      // Ahora se fija aquí junto con size, y en el camino de arranque ya no se cambia la densidad a mitad.
      await this.shell(`wm size reset; wm density ${tabletDensity()}`, { timeout: 15000 });
      await this.shell(`settings put system accelerometer_rotation ${guestAutoRotate()}`, { timeout: 15000 });
      // Igual que setOrientation: manda la orientación de la pantalla y la orientación lógica se bloquea en 0.
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // Al fijar la densidad de tableta aparece la barra de tareas del Launcher (sw>=600dp). Solo lee
      // enable_taskbar al iniciar, así que además de escribir el interruptor hay que reiniciarlo si ya está en marcha.
      await this.disableLauncherTaskbar();
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Garantiza que el teclado en pantalla sea el teclado latino que ya trae la imagen
   * (Gboard o el teclado AOSP «LatinIME»). No instala nada: solo lo activa y lo deja
   * como predeterminado si no hay otro teclado latino activo. Con el idioma del sistema
   * en español, el teclado muestra la distribución en español.
   *
   * Idempotente y no fatal: si la imagen no trae ninguno, devuelve ok:false y sigue.
   * @returns {Promise<{ok:boolean, ime?:string, reason?:string}>}
   */
  async ensureLatinKeyboard() {
    const PREFERRED = [
      'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
      'com.android.inputmethod.latin/.LatinIME',
    ];
    try {
      const all = String(await this.shell('ime list -a -s', { timeout: 10000 }).catch(() => ''))
        .split('\n').map((x) => x.trim()).filter(Boolean);
      const ime = PREFERRED.find((id) => all.includes(id))
        || all.find((id) => /inputmethod\.latin/.test(id));
      if (!ime) return { ok: false, reason: 'La imagen no trae un teclado latino' };
      if (!/^[\w.]+\/[\w.]+$/.test(ime)) return { ok: false, reason: 'Identificador de teclado inesperado' };
      const cur = String(await this.shell('settings get secure default_input_method', { timeout: 8000 }).catch(() => '')).trim();
      const cmds = [`ime enable ${ime}`];
      // Solo se cambia el predeterminado si no hay uno latino (p. ej. quedó el pinyin de una versión anterior).
      if (!/inputmethod\.latin/.test(cur)) cmds.push(`ime set ${ime}`);
      await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
      return { ok: true, ime };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Aplica el idioma del sistema y la zona horaria.
   * persist.sys.locale es una propiedad de solo lectura protegida por SELinux y no se puede cambiar en ejecución (da
   * "Failed to set property"); lo que la aplica de verdad es -change-locale al lanzar el emulador.
   * Aquí se hace lo posible: fijar el idioma a nivel de ajustes y la zona horaria, para que la interfaz y la hora sean correctas de inmediato.
   */
  async ensureChineseLocale(locale = 'es-419', timezone = '') {
    const tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(String(timezone || '')) ? timezone : '';
    const safeLocale = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(locale)) ? locale : 'es-419';
    const cmds = ['settings put system system_locales ' + safeLocale];
    if (tz) cmds.push('setprop persist.sys.timezone ' + tz);
    await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
    return true;
  }

  /** Resolución lógica actual (tras cambiar a horizontal, la ventana calcula su proporción con ella) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** Si el diálogo de autorización sigue al frente (para autocorregirse aunque el usuario no esté frente al equipo), se cierra con atrás */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * Ajuste de pantalla: en pantalla completa la resolución de Android pasa al tamaño del monitor (el contenido se ajusta solo),
   * en modo ventana vuelve al preajuste vertical. Los comandos wm se aplican en ejecución, sin reiniciar Android.
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity, parseDeviceState, isUnauthorizedError, parsePmPaths,
};
