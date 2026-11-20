'use strict';
/**
 * Autoaprovisionamiento del runtime (Provisioning)
 *
 * LanzadorAPK no depende de ningún emulador de terceros: adb, QEMU y la imagen del sistema los descarga/verifica/gestiona él mismo.
 * Todos los archivos del runtime van en %APPDATA%\lanzadorapk\runtime, para que se pueda escribir sin importar dónde se instale.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial } = require('./download');
const { ZipArchive, ZipFile, resolveZipEntry } = require('./zip');
const { Sources } = require('./sources');
const { cmpVer, isReleaseTag, nameHasVersion } = require('./version');

const IS_WIN = process.platform === 'win32';

const BRAND = require('./brand');
const { parseDigest, parseSums, verifyFile, sdkChecksums } = require('./integrity');
const diskspace = require('./diskspace');

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Índice oficial del SDK de Google: las direcciones reales de emulator y de las imágenes se resuelven de ahí al vuelo, sin versiones fijas
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // Respaldo: versiones conocidas que se usan si el índice no está disponible
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Imagen compatible con ARM (versión Google Play, con native bridge integrado)
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2 (x86_64): solo se usa si el usuario ya tiene su propia ISO
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // La versión ligera (sin runtime) obtiene de aquí el «paquete del runtime»: el GitHub Release del propio proyecto.
  // Antes la versión ligera bajaba emulator / imagen del sistema por separado desde dl.google.com, y con ciertas redes
  // se quedaba en decenas de KB/s o daba 404; con un solo paquete + el GitHub del proyecto, la fuente de descarga y la de actualizaciones
  // son el mismo lugar, y si hay un problema solo hay que arreglarlo en un sitio.
  ghReleaseApi: `https://api.github.com/repos/${BRAND.OWNER}/${BRAND.REPO}/releases`,
  ghReleasePage: `https://github.com/${BRAND.OWNER}/${BRAND.REPO}/releases`,
};

/**
 * El <url> del índice del SDK es relativo y la carpeta base varía:
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * por eso la base siempre es «la carpeta del propio archivo de índice». Antes se usaba el nombre de archivo como URL y daba Invalid URL.
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * Solo se conserva una «imagen base universal».
 * La versión anterior usaba por defecto AOSP API30 + una imagen compatible API34 Play opcional, lo que causaba:
 *   - al instalar apps ARM fallaba siempre y había que cambiar de imagen a mano (una barrera práctica);
 *   - dos imágenes de 0,6–3 GB cada una; la carpeta del runtime llegaba a más de diez GB;
 *   - cambiar de imagen exigía wipe-data y se perdían todas las apps.
 * Ahora todo es Android 14 Google Play x86_64: funcionan apps x86, apps ARM y GMS,
 * y el equipo guarda una sola capa base de solo lectura (compartida tipo contenedor), descargada una vez bajo demanda.
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

/**
 * Carpeta de los datos de Android (AVD: partición de datos de 4–24 GB + instantánea de 2–4 GB).
 * La «Carpeta de datos de Android» que el usuario elige en Configuración debe respetarse siempre.
 * Antes, si la carpeta del runtime estaba dentro de %APPDATA% (lo normal en la versión ligera), se ignoraba
 * y el AVD seguía en C: aunque el usuario la hubiera movido a otro disco para ahorrar espacio.
 * Excepción para no «perder» apps: si ya hay un AVD en la ubicación anterior y la nueva todavía está vacía,
 * se sigue usando el existente hasta que el usuario mueva la carpeta lanzadorapk.avd (así lo indica la interfaz).
 */
function avdHomeFor({ root, insideData, explicitAvd, writable }) {
  const legacy = insideData ? path.join(root, 'avd') : writable;
  if (!explicitAvd) return legacy;
  const hasAvd = (dir) => {
    try { return fs.existsSync(path.join(dir, 'lanzadorapk.avd', 'config.ini')); } catch (_) { return false; }
  };
  if (path.resolve(legacy) !== path.resolve(explicitAvd) && hasAvd(legacy) && !hasAvd(explicitAvd)) return legacy;
  return explicitAvd;
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * Detección de escritura en carpetas (el resultado se guarda por carpeta).
 *
 * Por qué no se usa fs.accessSync(dir, W_OK): en Windows solo mira el atributo de «solo lectura»,
 * no las ACL, y con C:\Program Files\WindowsApps\... (carpeta de instalación MSIX) dice por error
 * «se puede escribir», y luego el .img.xz falla a mitad de la descompresión. Aquí se escribe de verdad un archivo de prueba y se borra.
 */
const _dirWritableCache = new Map();
function provisionDirWritable(dir) {
  if (_dirWritableCache.has(dir)) return _dirWritableCache.get(dir);
  let ok = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.lanzadorapk-wtest-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    ok = true;
  } catch (_) {
    ok = false;
  }
  _dirWritableCache.set(dir, ok);
  return ok;
}

/**
 * Verificación de integridad tras la descarga. Si no pasa, **se borra el archivo incompleto**.
 *
 * Antes aquí solo se lanzaba el error sin borrar el archivo, y en tmp siempre quedaba un zip a medias. La próxima vez
 * download() veía el archivo y reanudaba con Range; si el servidor/la fuente había cambiado, los bytes reanudados
 * no encajaban con la primera mitad, volvía a fallar, quedaba otro a medias… el usuario veía «descarga una y otra vez».
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(`${label}Descarga incompleta (${(size / 1048576).toFixed(1)} MB); se limpió, inténtalo de nuevo`);
}

/**
 * Caché en disco del resultado de la detección del entorno.
 *
 * `emulator -version` y `emulator -accel-check` lanzan cada vez un proceso emulator nuevo,
 * que en Windows tarda 1–3 s; y mientras «el motor/el controlador no cambian» el resultado es siempre el mismo.
 * Antes solo se guardaba 30 s en memoria, así que cada arranque en frío lo volvía a pagar, y esos segundos caían justo
 * cuando el usuario abría una app. Aquí se arma una huella con «tamaño + fecha del exe + fecha del controlador AEHD + componente WHPX»
 * y se guarda en %APPDATA%; si cambia el software o el hardware se invalida sola.
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // Un «no disponible» de la aceleración solo se cree 10 minutos: el usuario puede acabar de activar la virtualización

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** Punto de entrada unificado de fuentes/espejos (la caché de velocidad también está aquí y la comparten varios componentes) */
  get sources() {
    return this._sources;
  }

  /** Huella de la caché: si cambia el archivo del motor o el controlador de aceleración, cambia la clave */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* Primera vez */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* Si no se puede escribir la caché no se afecta el flujo principal */ }
  }

  /** Se llama si el arranque falla (problemas de aceleración/imagen): el próximo arranque vuelve a detectar, para no seguir con una conclusión equivocada */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- Rutas ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // ¿Se puede escribir en la carpeta del runtime?
    // La versión de la Store (MSIX) pone emulator / platform-tools / system-images directamente dentro del paquete
    // (C:\Program Files\WindowsApps\...), que es de solo lectura:
    //   - descomprimir .img.xz en el sitio, crear _tmp o qemu/ falla;
    //   - pero ejecutar desde el paquete sí está permitido (y solo así hay identidad de paquete y la vista virtualizada de %APPDATA%
    //     coincide con la del proceso padre).
    // Por eso «ejecutable» y «escribible» se separan: las rutas de ejecución siguen apuntando al paquete, y los datos escribibles
    // (carpeta de descompresión de imágenes / AVD / temporales) van todos a la carpeta de datos del usuario.
    const rootWritable = provisionDirWritable(root);
    // El AVD (datos de usuario, apps instaladas, instantánea quickboot) debe quedar en un lugar escribible que no se limpie.
    // En la versión de un solo archivo el runtime se descomprime en una carpeta temporal; poner el AVD ahí sería perder las apps en cada salida.
    // Siempre que la carpeta del runtime no esté en %APPDATA%, el AVD se fija en la carpeta de datos del usuario.
    // Además: en Configuración se puede indicar aparte la «carpeta de datos de Android», que es lo que de verdad ocupa disco
    // (partición de datos de 6–24 GB + instantánea de 2–3 GB); mover solo el runtime y no esto llenaría igual el disco C.
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // Dónde va la imagen del sistema: **primero la carpeta del runtime**.
    // Antes el orden era «primero la carpeta de datos del usuario», y el resultado era que, si el usuario movía el runtime a D para ahorrar espacio en C,
    // tras descomprimir el paquete de 1,4 GB en D, materializeImages volvía a descomprimir el system.img de 3,3 GB en
    // C://Users//...//AppData//Roaming//lanzadorapk//system-images, y el disco C se llenaba igual, además
    // de guardar la misma imagen dos veces (probado: 1,2 GB + 3,3 GB a la vez).
    // Ahora: si la carpeta del runtime ya tiene system-images (resultado de descomprimir el paquete) se usa esa;
    // solo si no, se vuelve a la carpeta de datos del usuario (versiones antiguas y la de un solo archivo usan esa distribución).
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // Tres casos:
    //  1) la carpeta del runtime ya tiene la imagen (de descomprimir el paquete) → se usa esa;
    //  2) usuarios antiguos/versión de un solo archivo con la imagen en la carpeta de datos del usuario → se usa esa;
    //  3) instalación nueva (no está en ningún lado) → va a la carpeta del runtime, porque la carpeta de datos del usuario podría ser
    //     una carpeta temporal redirigida (al armar el runtime en CI pasa así; si se escribe en otro lugar falla la verificación).
    //  4) carpeta del runtime de solo lectura (dentro del paquete MSIX) → debe ir a la carpeta de datos del usuario; si no, el .img.xz no se descomprime.
    //
    // Además (corrección 0.6.0): se prefiere el lugar con «la imagen ya descomprimida». Antes bastaba que la carpeta del runtime
    // tuviera system-images (aunque solo fuera .img.xz) para elegirla, y aunque en la carpeta de datos del usuario hubiera
    // un system.img utilizable de 3,1 GB, se volvía a descomprimir el paquete cada vez; si el paquete estaba truncado (como en 0.5.9),
    // la descompresión fallaba siempre, con el síntoma «instalado pero ninguna app abre».
    // Ahora: se usa la que se pueda usar directamente; solo si ninguna está completa se elige dónde descargar/descomprimir.
    const expandedImgDir = (base) => path.join(base, `android-${sysApi}`, sysTag, sysAbi, 'system.img');
    const hasExpanded = (base) => {
      try { return fs.statSync(expandedImgDir(base)).size > 100 * 1024 * 1024; } catch (_) { return false; }
    };
    let sysRoot;
    if (!rootWritable) sysRoot = dataImg;
    else if (hasExpanded(rootImg)) sysRoot = rootImg;
    else if (hasExpanded(dataImg)) sysRoot = dataImg;
    else if (fs.existsSync(rootImg)) sysRoot = rootImg;
    else if (fs.existsSync(dataImg)) sysRoot = dataImg;
    else sysRoot = rootImg;
    return {
      root,
      // Las carpetas temporales/auxiliares solo van bajo root si se puede escribir; si no, siempre en la carpeta de datos
      writeRoot: rootWritable ? root : path.join(store.DATA_DIR, 'runtime'),
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // Runtime de emulator (oficial de Google): root también funciona como ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: avdHomeFor({ root, insideData, explicitAvd, writable }),
      aehdDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'aehd'),
      imagesDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), '_tmp'),
      rootWritable,
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      // Tolerancia una por una: en la versión de la Store (MSIX) p.root está en el paquete de solo lectura y es normal que no se pueda crear;
      // las carpetas escribibles ya se redirigieron a la carpeta de datos del usuario (ver paths()). Que una no se pueda crear no debe
      // hacer fallar toda la ruta de arranque.
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* Solo lectura/en uso: se omite */ }
    }
    return p;
  }

  /**
   * Vigilante de disco: antes de descargar / descomprimir un componente grande, comprueba que el disco de destino tenga espacio suficiente.
   * Si no, la descarga llenaría a mitad el disco del sistema o la descompresión fallaría (dejando archivos a medias).
   * Se reserva 1 GB de margen: tras descomprimir el emulador/la imagen, las instantáneas y la partición de datos siguen creciendo.
   * @param {string} component nombre del componente (determina el espacio estimado)
   * @param {string} targetDir carpeta de escritura (para ubicar su disco)
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Paquete del runtime: zip de 1,5 GB + ~3,3 GB de imagen descomprimida, que en el pico coexisten
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // 1 GB extra reservado (instantánea / partición de datos / intermedios de la descompresión)
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw diskspace.diskFullError({ dir, needMB: need + buf, freeMB: free, what: 'instalar este componente del runtime' });
    }
    return free;
  }

  // ---------------- Comprobación del entorno ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: 'No es Windows' }; return this._hypervisor; }
    // Solo comprobaciones de archivos de milisegundos. La respuesta definitiva sobre «si WHPX funciona» la da emulator -accel-check,
    // para no lanzar PowerShell aquí (1-2 s en frío) y ralentizar cada consulta de estado.
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // emulatorAccel() lo sustituye por el valor real
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'El componente de plataforma de máquina virtual existe (la disponibilidad la comprueba el motor del runtime)'
        : 'No se detectó el componente Windows Hypervisor Platform: márcalo en «Activar o desactivar las características de Windows» como «Plataforma de máquina virtual» y reinicia',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // Caché de 30 s, para que las consultas de estado no lancen procesos externos a cada rato
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // Ubicación de instalación por defecto de winget
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** Verifica el descriptor de volumen primario ISO9660 ("CD001" en el desplazamiento 0x8001), para no tomar una página de error o un archivo a medias como imagen */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: 'No descargada' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // Las imágenes de disco raw/ya instaladas importadas por el usuario no tienen sector de arranque ISO; se aceptan por tamaño
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `El archivo solo tiene ${(size / 1048576).toFixed(1)} MB; la descarga no terminó`
        : 'El archivo no es una imagen ISO9660 válida (puede que se descargara una página de error o que esté dañado)';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // La versión completa (runtime integrado) solo trae una imagen API 34 Google Play, que es a la vez la principal y la compatible;
    // ya no depende del interruptor compatImage, para no tener «la imagen está pero como el interruptor no está marcado se considera sin instalar»
    const playImage = this.playImageInfo();
    const compatReady = playImage.ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;
    // Lo que trae el paquete es .xz/.gz: la imagen «existe», solo falta descomprimirla. La capa superior lo usa para decidir
    // «si hay que descargar»: si hay imagen nunca se descarga, solo se descomprime.
    const needsExtract = !!(sysimg.compressed || (compatReady && playImage.compressed));

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : 'No instalado' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? playImage.size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        compressed: needsExtract,
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api} (${(sysimg.size / 1073741824).toFixed(2)} GB${sysimg.compressed ? ', versión comprimida incluida; se descomprime en el primer arranque' : ''})`
          : (compatReady
            ? `Android ${PLAY_SYSIMG.api} (${playImage.compressed ? 'Versión comprimida incluida; se descomprime en el primer arranque' : 'Imagen compatible con ARM'})`
            : (sysimg.note || 'No descargada')),
      },
      // true = la imagen está en local (en el paquete) y solo hay que descomprimirla una vez; la capa superior **prohíbe** entonces cualquier descarga
      needsExtract,
      playImage,
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : 'No descargada',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : 'Todavía no creada',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: 'Descargando Android platform-tools (unos 8 MB)…', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, 'Paquete de adb');

    onProgress({ stage: 'extract', message: 'Descomprimiendo adb…', percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb no se puede ejecutar después de descomprimirlo; revisa si el antivirus lo bloquea');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} listo`, percent: 100 });
    return v;
  }

  /**
   * Descomprime con el lector ZIP propio (para no depender de herramientas de descompresión del sistema)
   * Las entradas grandes (system.img de varios GB) van en flujo y las pequeñas se leen enteras, para no chocar con el límite de un Buffer de Node.
   */
  // ---------------- Paquete del runtime en el GitHub del proyecto (versión ligera) ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * Resuelve la dirección de descarga del «paquete del runtime».
   * Convención de nombres: LanzadorAPK-runtime-<tag>.zip (lo genera .github/workflows/release.yml,
   * y contiene lo mismo que build/runtime: emulator/ + platform-tools/ + aehd/ + system-images/).
   * Se revisan las versiones de GitHub y se toma la más alta que tenga suma SHA-256 verificable; si no hay, se lanza un error para que la capa superior pase
   * a la descarga por componentes oficial de Google.
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const apis = [];
    apis.push({ api: SOURCES.ghReleaseApi, page: SOURCES.ghReleasePage, name: 'GitHub' });

    // Consulta la lista de versiones; si falla, no bloquea el respaldo
    const lists = await Promise.all(apis.map(async (a) => {
      const j = await this._fetchJson(`${a.api}?per_page=15`).catch(() => null);
      return { ...a, list: Array.isArray(j) ? j : null };
    }));

    const cands = [];
    for (const item of lists) {
      if (!item.list) continue;
      for (const rel of item.list) {
        if (!rel || rel.draft) continue;
        const relTag = String(rel.tag_name || rel.name || '');
        if (!isReleaseTag(relTag)) continue; // etiqueta mal escrita (p. ej. v0.71): no cuenta como versión
        const hits = (rel.assets || []).filter((x) => /^LanzadorAPK-runtime-.*\.zip$/i.test(x.name || ''));
        const hit = hits.find((x) => nameHasVersion(x.name, relTag)) || hits[0];
        if (!hit) continue;
        cands.push({
          url: hit.browser_download_url || hit.url,
          name: hit.name,
          size: hit.size || 0,
          sha256: parseDigest(hit.digest),
          rawTag: String(rel.tag_name || rel.name || ''),
          tag: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
          page: rel.html_url || item.page,
          from: item.name,
        });
      }
    }
    if (!cands.length) {
      const errs = lists.filter((x) => !x.list).map((x) => `${x.name} no accesible`).join(',');
      throw new Error(`No hay paquete de runtime en GitHub ${errs ? ` (${errs})` : ''}`);
    }
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    const best = cands[0];
    if (!best.sha256) {
      const sums = await this.sources.fetchSums(best.rawTag).catch(() => new Map());
      best.sha256 = sums.get(best.name) || '';
    }
    // Without a published checksum the pack is not trusted: the caller falls back to
    // downloading the official components from dl.google.com instead.
    if (!best.sha256) throw new Error('El paquete de runtime no publica suma SHA-256; se usará la descarga oficial de Google');
    this._cache.pack = best;
    return this._cache.pack;
  }

  /**
   * Instalación con un clic de la versión ligera: descarga el paquete del runtime desde el GitHub del proyecto y lo descomprime.
   * La imagen del sistema va en el paquete como .xz y materializeImages() la descomprime en el primer arranque (una sola vez).
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // Primero un mensaje de progreso: buscar la versión + medir velocidades no tiene bytes, y sin aviso el usuario creería que «se colgó».
    onProgress({ stage: 'download', message: 'Obteniendo la información de versión del runtime…', percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: `Eligiendo la fuente de descarga más rápida (${pack.from || 'GitHub'} · ${pack.tag})…`, percent: 1 });
    // Candidatos = fuente original + prefijo de espejo. Primero se baja una muestra de cada uno para medir la velocidad real y decidir:
    // «adivinar por el dominio» falla a menudo en la práctica: la misma dirección da 30 KB/s por la mañana y 5 MB/s por la noche.
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    const asDiskFull = (e) => {
      if (diskspace.isDiskFullError(e) && e.code !== 'DISK_FULL') {
        throw diskspace.diskFullError({ dir: p.root, needMB: 6024, freeMB: doctor.freeDiskMB(p.root), what: 'descargar e instalar el runtime de Android' });
      }
      throw e;
    };
    onProgress({ stage: 'download', message: `Descargando el runtime (unos 1,5 GB, solo una vez, ${conn} conexiones)…`, percent: 2 });
    // Bloques en paralelo (8 conexiones) es mucho más rápido que un solo flujo: GitHub suele limitar cada conexión, y un solo flujo
    // daba en pruebas solo uno o dos cientos de KB/s; con 8 conexiones se aprovecha todo el ancho de banda. Si se corta, vuelve a un solo flujo con reanudación.
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` · quedan unos ${Math.ceil(pr.eta / 60)} min` : '';
        onProgress({
          stage: 'download',
          message: `Descargando el runtime ${mb}${sp}${eta}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    }).catch(asDiskFull);
    assertComplete(zip, 200 * 1024 * 1024, 'paquete del runtime');
    if (pack.sha256) {
      onProgress({ stage: 'verify', message: 'Verificando la integridad del runtime (SHA-256)…', percent: 90 });
      await verifyFile(zip, pack.sha256, 'sha256', pack.name);
    }

    onProgress({ stage: 'extract', message: 'Descomprimiendo el runtime (cerca de 1 minuto)…', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `Descomprimiendo ${done}/${all}` });
        }
      },
    }).catch(asDiskFull);
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* Si no se puede escribir la marca, no se afecta el uso */ }

    // El system.img del paquete está comprimido en .xz (igual que el instalador completo). Aquí se descomprime de inmediato;
    // si no, el checkEnv() siguiente creería que «no hay imagen del sistema» y volvería a bajar 1,4 GB de Google.
    // Si falla la descompresión, la instalación debe fallar con el motivo: la versión anterior lo convertía en 0, el usuario veía el progreso
    // quedarse en 99 % y luego volver a «completar desde la fuente oficial», bajando 1,4 GB en vano.
    onProgress({ stage: 'extract', message: 'Descomprimiendo la imagen del sistema (cerca de 1 minuto, solo una vez)…', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: 'Runtime listo', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  /**
   * Candidatos de descarga: primero directo, luego el prefijo de espejo.
   * Pasa por Sources para centralizar: el prefijo de espejo personalizado del usuario
   * se mantiene en un solo lugar y comparte la caché de velocidad con la descarga multiconexión.
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  /** Stores the SHA-1 values Google publishes for each archive URL in an SDK XML block. */
  _rememberSha1(xmlBlock, base) {
    if (!this._cache.sha1) this._cache.sha1 = new Map();
    for (const [u, v] of sdkChecksums(xmlBlock, (x) => absUrl(x, base))) this._cache.sha1.set(u, v.sha1);
  }

  /** Verifies a Google SDK download when its SHA-1 is known (URLs resolved from the index). */
  async _verifySdk(file, url, label) {
    const sha1 = this._cache.sha1 && this._cache.sha1.get(url);
    if (sha1) await verifyFile(file, sha1, 'sha1', label);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // Los paquetes grandes (emulator / imagen del sistema) usan la versión por archivo: no cargan un zip de 1,5 GB en memoria,
    // así se descomprime de forma estable en equipos con poca memoria; los pequeños siguen en memoria, que es más rápido.
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        // Protección zip-slip (issue #2 P0-4): el paquete del runtime viene de la red y los nombres de las entradas no son de confianza.
        // Tanto las entradas de carpeta como las de archivo deben ser rutas relativas válidas dentro de destDir.
        const target = resolveZipEntry(destDir, name);
        if (!target) {
          if (opts.onUnsafeEntry) opts.onUnsafeEntry(name);
          continue;
        }
        if (name.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator (runtime oficial de Google) ----------------

  /** Descarga un texto XML (con límite de tamaño; el índice pesa unos 400 KB) */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    // issue #2 P1-1: si al superar el límite destroy() no emite 'end' y el error no se captura,
    // esta Promise nunca se resuelve y el asistente de instalación queda para siempre en «analizando el índice».
    // Con un cerrojo de resolución única + tiempo límite fijo, cualquier camino se resuelve una sola vez.
    return new Promise((resolve) => {
      let d = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => { try { res.destroy(); } catch (_) {} finish(); }, 30000);
      res.on('data', (c) => {
        if (done) return;
        d += c;
        if (d.length > limit) {
          d = '';                       // El contenido que supera el límite no sirve; no tomar un índice a medias como completo
          try { res.destroy(); } catch (_) {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
  }

  /** Resuelve al vuelo, desde el índice del SDK, la dirección del paquete de emulator para Windows más reciente */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        this._rememberSha1(block[0], base);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* Se usa el respaldo */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** Resuelve desde el índice sys-img la dirección de la imagen del sistema AOSP por defecto */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          this._rememberSha1(block[0], base);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* Probar el siguiente índice */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // Detectado en la sesión anterior y los archivos del motor no cambiaron: se usa el resultado en disco (ahorra lanzar un proceso de más de 1 s)
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * En el primer arranque descomprime la imagen comprimida incluida en la carpeta del usuario (una sola vez).
   * En la versión de un solo archivo system.img es .gz (3,1 GB → unos 580 MB); sin descomprimir el emulador no funciona.
   * Se descomprime en %APPDATA% y no en el paquete: en la versión portátil la carpeta del runtime es una carpeta temporal nueva en cada inicio,
   * y ponerla ahí sería descomprimir otra vez en cada arranque.
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // El destino debe seguir las mismas reglas que paths().sysImgRoot; si no, aparece
    // la duplicación «paquete descomprimido en D e imagen descomprimida otra vez en APPDATA de C» (probado: 1,2 GB + 3,3 GB).
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // Los archivos que no son la imagen comprimida (kernel-ranchu / ramdisk / .img sin comprimir, etc.) deben ir también a la carpeta de destino
    const found = new Map(); // dest -> job (si coexisten .xz/.gz de la misma imagen, se prefiere .xz)
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // Admite .img.xz (LZMA2, ~25 % más pequeño que .gz) y el .img.gz anterior
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // Primero se completan los archivos que no son imagen (el emulador usa kernel-ranchu, etc. para ubicar/arrancar; si faltan dice «falta la imagen del sistema»)
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // Se descomprime en el sitio, sin copiar
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`Error al copiar componentes de la imagen: ${e.message}`); }
    }

    // Comprobación de espacio ANTES de descomprimir: la imagen del sistema ocupa unos 3,3 GB descomprimida.
    // Antes no se miraba y, si el disco se llenaba a mitad, el usuario solo veía «Error al descomprimir… ENOSPC»
    // y luego «faltan componentes del runtime», sin saber que el problema era el espacio.
    const pending = jobs.filter((j) => {
      const have = fileSize(j.dest);
      const srcSize = fileSize(j.src);
      return !(have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize));
    });
    if (pending.length) {
      const needBytes = pending.reduce((sum, j) => sum + diskspace.uncompressedSize(j.src).bytes, 0);
      const needMB = Math.ceil(needBytes / 1048576) + 512; // margen para la partición de datos / registros
      const freeMB = doctor.freeDiskMB(destRoot);
      if (freeMB && freeMB < needMB) {
        onLog(`Espacio insuficiente para descomprimir la imagen: hacen falta ${needMB} MB y quedan ${freeMB} MB en ${destRoot}`);
        throw diskspace.diskFullError({ dir: destRoot, needMB, freeMB, what: 'descomprimir la imagen del sistema Android' });
      }
    }
    // Paquete del runtime descargado de internet (tiene la marca .runtime-pack.json): tras descomprimir bien,
    // el .img.xz ya no hace falta (si algún día falta la imagen, autoDeploy vuelve a bajar el paquete).
    // Borrarlo libera alrededor de 1 GB. En el instalador completo / la Store NO se borra: ese .xz es parte de la instalación
    // y es la única copia local para recuperar la imagen sin internet.
    const downloadedPack = fs.existsSync(path.join(this.root, '.runtime-pack.json'));
    const rootAbs = path.resolve(this.root).toLowerCase() + path.sep;

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // Para saber si «ya se descomprimió» no basta con 32 MB: las versiones antiguas no usaban .part y una interrupción podía dejar
      // una imagen a medias de cientos de MB que superaba el umbral, se daba por completa y el arranque fallaba por imagen dañada.
      // Una imagen real descomprimida siempre es más grande que el comprimido, así que «menor que el comprimido» = no terminó de descomprimirse.
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // Primero se descomprime a .part y si sale bien se renombra: si se interrumpe a mitad (cerrar el programa / corte de luz / disco lleno)
      // no queda un system.img a medias que «parezca terminado»; si no, la próxima vez se saltaría la descompresión
      // y el arranque fallaría por imagen dañada; el usuario tendría que borrar datos y empezar de nuevo.
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`Primer arranque: descomprimiendo la imagen del sistema ${path.basename(j.dest)} (cerca de 1 minuto, solo una vez)`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // Descompresión LZMA2: hay que cargar directamente el enlace nativo index.js.
            // Los puntos de entrada por defecto main.js / xz.js hacen require('stream-polyfill.mjs') por dentro,
            // y el Node 20 de Electron no admite require(ESM) y lanza un error; además exports no permite
            // escribir directamente '@napi-rs/lzma/index.js', así que se ubica la carpeta con require.resolve y se carga por ruta de archivo.
            const path0 = require('path');
            let lzmaDir;
            try {
              lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            } catch (_) {
              // Si al empaquetar falta node_modules/@napi-rs, se llega aquí. Antes se lanzaba
              // "Cannot find module '@napi-rs/lzma'" + una larga pila de require,
              // que el usuario no entendía y solo pensaba «instalado pero ninguna app abre».
              // Se le dice claramente que el instalador está incompleto, no que su equipo tiene un problema.
              const e2 = new Error('El instalador está incompleto: falta el componente de descompresión @napi-rs/lzma y la imagen del sistema no se puede descomprimir. Vuelve a descargar la versión completa o usa la versión de la Store.');
              e2.code = 'LZMA_MISSING';
              throw e2;
            }
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
        if (downloadedPack && path.resolve(j.src).toLowerCase().startsWith(rootAbs)
          && path.resolve(j.src) !== path.resolve(j.dest) && fileSize(j.dest) > 32 * 1024 * 1024) {
          try {
            const freed = fileSize(j.src);
            fs.rmSync(j.src, { force: true });
            onLog(`Se borró la copia comprimida ${path.basename(j.src)} (se liberaron ${(freed / 1048576).toFixed(0)} MB)`);
          } catch (_) { /* Si no se puede borrar solo ocupa espacio; no afecta el arranque */ }
        }
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        if (diskspace.isDiskFullError(e)) {
          throw diskspace.diskFullError({
            dir: destRoot, needMB: Math.ceil(diskspace.uncompressedSize(j.src).bytes / 1048576) + 512,
            freeMB: doctor.freeDiskMB(destRoot), what: 'descomprimir la imagen del sistema Android',
          });
        }
        // Ya no se puede ocultar en silencio: quien llama (instalación con un clic / arranque) debe saber que la imagen no se descomprimió,
        // si no, «bajaría otros 1,4 GB de la fuente oficial» o el arranque fallaría directamente.
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`Error al descomprimir la imagen: ${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`Error al descomprimir la imagen del sistema (${failures.join(';')})`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /**
   * Si la imagen del sistema está completa.
   *
   * «Completa» tiene dos formas:
   *   1. un `system.img` ya descomprimido (caché local / la carpeta del runtime que el usuario indicó en Configuración);
   *   2. **el `system.img.xz` / `.gz` que trae el paquete**: la versión de la Store (MSIX) y el instalador completo
   *      usan esta forma, y materializeImages() lo descomprime en el sitio en el primer arranque.
   *
   * La forma 2 debe contar como ok; si no, checkEnv().ready sería false, autoDeploy creería
   * que «el usuario aún no bajó la imagen» y descargaría 1,5 GB: justo la causa de «instalé con la imagen incluida
   * y aun así está descargando». La marca compressed del resultado indica que «falta descomprimir una vez».
   */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // Primero se busca en la ubicación por defecto (API34 Play) y luego «cualquier imagen».
    // La versión de un solo archivo puede traer solo una imagen AOSP más pequeña; fijar API34 haría que
    // la imagen estando en el paquete se reportara como «no descargada» y el usuario tuviera que descargar otra.
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    let packed = null;   // Solo se encontró el comprimido: cuenta como «existe», pero hay que descomprimirlo
    for (const dir of candidates) {
      const kernel = path.join(dir, 'kernel-ranchu');
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      // Primero las descomprimidas
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi, compressed: false };
      }
      // Luego los comprimidos (lo habitual en las imágenes del paquete)
      if (fs.existsSync(kernel)) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            if (!packed) packed = { ok: true, dir, size: cs, api, tag, abi, compressed: true, file: name };
            break;
          }
        }
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? 'Imagen incompleta' : 'Falta system.img' };
      }
    }
    // Si hay comprimido se usa: hay que descomprimirlo, pero **no falta la imagen**; nunca debe disparar una descarga
    if (packed) return packed;
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: 'No descargada' };
  }

  /**
   * Estado de la aceleración por hardware.
   * En Windows emulator admite dos aceleraciones: WHPX (función del sistema, requiere reiniciar) y AEHD (controlador de Google, funciona al instalarlo).
   */
  async emulatorAccel() {
    // El estado se consulta cada pocos segundos y -accel-check lanza un proceso emulator; hay que guardarlo en caché
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: 'emulator no instalado' };

    // Caché en disco: en el arranque en frío ya no se lanza emulator para esto.
    // La conclusión «no disponible» solo se cree 10 minutos: el usuario puede acabar de activar la virtualización/instalar AEHD y debe reflejarse enseguida.
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'Aceleración por hardware WHPX activada' : 'Aceleración por hardware AEHD activada' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // Algunos paquetes de runtime reducidos olvidan emulator-check.exe y -accel-check no da conclusión.
      // En ese caso, si el controlador AEHD está instalado se considera «disponible»: al arrancar emulator monta el controlador por su cuenta,
      // evitando que se tome por «sin aceleración» y se fuerce -accel off (en algunos equipos la emulación por software falla directamente).
      result = { ok: true, kind: 'aehd', note: 'Aceleración por hardware AEHD activada (falta emulator-check; se decide por el controlador)' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'Aceleración por hardware AEHD activada' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'Aceleración por hardware WHPX activada' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'Sin aceleración por hardware: se usará emulación por software (funciona, pero muy lento). Instala el controlador AEHD o activa «Plataforma de máquina virtual»',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** Descarga e instala emulator (el nivel superior del zip ya es emulator/; se descomprime directo en la raíz del SDK) */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: 'Descargando el motor del runtime (unos 440 MB, desde la fuente oficial de Google)…', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando el motor del runtime ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, 'motor del runtime');
    await this._verifySdk(zip, url, 'emulator');

    onProgress({ stage: 'extract', message: 'Descomprimiendo el motor del runtime…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // La raíz del SDK también debe tener platform-tools; si no, emulator se niega a arrancar
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('emulator no se puede ejecutar después de descomprimirlo; revisa si el antivirus lo bloquea');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `Motor del runtime ${v.version} listo`, percent: 100 });
    return v;
  }

  /** emulator exige una carpeta platform-tools en la raíz del SDK; si no, FATAL directo */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** Solo se descarga una imagen base universal (Android 14 Play x86_64); ya no hay dos, «normal/compatible» */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** Si la imagen compatible con ARM (versión Google Play) ya está en su lugar */
  playImageInfo() {
    const p = this.paths();
    const rel = `android-${PLAY_SYSIMG.api}/${PLAY_SYSIMG.tag}/${PLAY_SYSIMG.abi}`;
    // Se miran ambos lugares: el destino de descompresión (carpeta de datos escribible) y la ubicación original en el paquete.
    // Los instaladores de la Store/completo traen system.img.xz, que se descomprime en el primer arranque; aquí hay que
    // reconocerlo, o installSystemImage / autoDeploy descargarían otra copia de internet.
    const dirs = [path.join(p.sysImgRoot, rel), path.join(this.root, 'system-images', rel)];
    let packed = null;
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, 'kernel-ranchu'))) continue;
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg) {
        return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: false };
      }
      if (!packed) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            packed = { ok: true, dir, size: cs, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: true, file: name };
            break;
          }
        }
      }
    }
    if (packed) return packed;
    const size = fileSize(path.join(dirs[0], 'system.img'));
    return { ok: false, dir: dirs[0], size, note: size ? 'Imagen incompleta' : 'No descargada' };
  }

  /** Resuelve la dirección de la imagen Google Play (<url> relativo a la carpeta del archivo de índice) */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        this._rememberSha1(block[0], base);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* Se usa el respaldo */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** Descarga e instala la imagen compatible con ARM (versión Google Play, unos 1,5 GB) */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: 'Descargando la imagen compatible con ARM (Android 14, unos 1,5 GB)…', percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando la imagen compatible ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, 'imagen compatible');
    await this._verifySdk(zip, url, 'system image (Play)');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: 'Descomprimiendo la imagen compatible (3 GB, unos segundos)…', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `Descomprimiendo la imagen compatible ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('La imagen compatible no pasó la verificación tras descomprimirla');
    // La imagen compatible antigua (API 30) ya no se usa; tras instalar bien se borra para liberar espacio
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'Imagen compatible con ARM lista; reinicia el runtime para aplicarla', percent: 100 });
    return info;
  }

  /** Descarga el controlador AEHD (archivo pequeño); instalarlo requiere administrador y lo hace el flujo guiado */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: 'Descargando el controlador AEHD…', percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('Error al descomprimir el paquete del controlador AEHD');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'Controlador AEHD listo; se necesitan permisos de administrador para instalarlo', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** Obtiene el nombre del instalador más reciente del directorio oficial (sin versiones fijas) */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* Se usa la fuente alternativa */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: 'Buscando la última versión de QEMU…', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `Descargando QEMU (unos 200 MB)…`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, 'Instalador de QEMU');

    onProgress({ stage: 'install', message: 'Instalando QEMU (en silencio)…', percent: 96 });
    // qemu-w64-setup es un instalador NSIS: /S silencioso, /D indica la carpeta (debe ir al final y sin comillas)
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('No se encontró qemu-system-x86_64.exe tras instalar QEMU: puedes descargar QEMU manualmente y descomprimirlo en engine/qemu/');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} listo`, percent: 100 });
    return v;
  }

  // ---------------- Imagen del sistema ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: 'Descargando Android-x86 9.0-r2 (unos 900 MB, 8 conexiones por bloques)…', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Descargando la imagen del sistema… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`Imagen del sistema no disponible: ${info.reason}${info.size && info.size < MIN_SIZE.iso ? '; puedes pulsar de nuevo para reanudar la descarga' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `Imagen del sistema lista (${(info.size / 1073741824).toFixed(2)} GB)`, percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** Valida la imagen/ISO importada por el usuario */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('El archivo no existe o está vacío');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || 'El archivo de imagen no está disponible');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- Disco virtual ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `Creando disco virtual de ${sizeGB} GB…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`qemu-img no pudo crear el disco virtual: ${r.stderr || r.stdout}`);
    } else {
      throw new Error('No se encontró qemu-img.exe; instala QEMU primero');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: 'Disco virtual creado', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- Comprobación previa de acceso a la imagen del sistema ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf, avdHomeFor };
