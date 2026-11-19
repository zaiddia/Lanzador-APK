'use strict';
/**
 * Adaptación al dispositivo / diagnóstico automático (backend sin configuración)
 *
 * Objetivo: que en ningún equipo el usuario tenga que ajustar parámetros.
 *  - chooseProfile()  deduce los parámetros de arranque según la memoria física, CPU, disco, aceleración y versión de emulator;
 *  - planVariants()   da el plan de reintentos «degradando paso a paso tras un fallo» (GPU → aceleración → memoria → arranque en frío);
 *  - diagnose()       convierte el stderr en inglés de emulator en sugerencias de reparación concretas;
 *  - shortPath()      maneja rutas de instalación con acentos/espacios (el QEMU de emulator es muy sensible a rutas no ASCII).
 *
 * Este módulo son funciones puras + detecciones de solo lectura; no escribe la configuración ni arranca Android, fácil de probar.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { memoryLimits } = require('./resources');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Perfil del equipo (milisegundos, solo lectura) */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** Espacio libre (MB) del disco de la carpeta; si no se puede obtener devuelve 0 */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Detecta el fabricante de la GPU (NVIDIA / AMD / Intel) para ajustar la prioridad de los motores de renderizado.
 * Solo consulta WMI en Windows; en otras plataformas devuelve 'unknown'.
 * El resultado se guarda 10 minutos, para no lanzar wmic en cada chooseProfile.
 */
let _gpuVendorCache = { vendor: 'unknown', at: 0 };
function detectGpuVendor() {
  if (process.platform !== 'win32') return 'unknown';
  if (Date.now() - _gpuVendorCache.at < 600000) return _gpuVendorCache.vendor;
  try {
    const { execFileSync } = require('child_process');
    // wmic se quitó en Win11 24H2+; se usa Get-CimInstance de PowerShell
    let names = '';
    try {
      names = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController).Name -join "|"',
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch (_) {
      // Respaldo con wmic (sigue disponible en sistemas antiguos)
      try {
        names = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name', '/format:list'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      } catch (__) { /* ignore */ }
    }
    const lower = String(names).toLowerCase();
    let vendor = 'unknown';
    // Primero las GPU dedicadas (NVIDIA/AMD); los adaptadores de pantalla virtuales al final
    if (/nvidia|geforce|rtx\s|gtx\s/.test(lower)) vendor = 'nvidia';
    else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/.test(lower)) vendor = 'amd';
    else if (/intel|uhd\s|iris|arc\s/.test(lower)) vendor = 'intel';
    _gpuVendorCache = { vendor, at: Date.now() };
    return vendor;
  } catch (_) {
    _gpuVendorCache = { vendor: 'unknown', at: Date.now() };
    return 'unknown';
  }
}

/**
 * Desde emulator 36.4.9 swiftshader_indirect está obsoleto y se agregó -gpu software.
 * En 37.x, pasar swiftshader_indirect da fallos de inicialización de GL o cierra directamente (varía mucho según el equipo).
 * Por eso los candidatos se eligen según la versión, y cada uno tiene una alternativa.
 *
 * Ajuste de prioridad según el fabricante de la GPU:
 *   NVIDIA: host casi siempre es lo mejor (controladores maduros), swangle de respaldo
 *   AMD: host falla con algunos controladores (sobre todo antiguos), swangle pasa a segunda opción
 *   Intel: host suele ir bien, pero con gráficos integrados débiles swangle es más estable
 *   unknown: se mantiene el orden por defecto
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  const base = modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
  const vendor = detectGpuVendor();
  if (vendor === 'amd' && modern) {
    // Con algunas versiones del controlador AMD el modo host falla al iniciar GL; swangle va primero
    return ['swangle', 'host', 'software', 'swiftshader'];
  }
  return base;
}

/** Ruta corta 8.3 de Windows: con nombre de usuario / carpeta de instalación con acentos, emulator no encuentra los archivos */
/**
 * Especificación de pantalla. Con landscape=true da una pantalla realmente horizontal (1280x720).
 *
 * Por qué hay que cambiar el tamaño de la pantalla y no wm size en ejecución: el LCD del emulador es la «pantalla física»,
 * y Qt abre la ventana con ese tamaño y pega la imagen arriba a la izquierda. Cambiar wm size en ejecución solo cambia la
 * resolución lógica de Android y la pantalla física sigue vertical: la imagen queda acostada 90°, en una franja arriba a la izquierda,
 * con grandes bordes negros y clics desplazados. Solo cambiando de verdad hw.lcd.width/height a horizontal y reiniciando
 * se obtiene una horizontal «derecha y a pantalla llena».
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* Si 8.3 está desactivado se conserva la ruta original */ }
  return p;
}

/**
 * Deduce los parámetros de arranque sin configuración.
 * Si la configuración del usuario da explícitamente engine.memoryMB / cores / gpuMode, se usan como límite/sustitución,
 * pero ya no se rompen los equipos con poca memoria usando 4 GB/4 núcleos fijos «porque no se configuró».
 */
/**
 * Cuota de «contenedor ligero»: solo limita lo que más afecta la fluidez del equipo, la cantidad de vCPU.
 *
 * La lógica anterior daba 4 núcleos en un equipo de 16, y los 4 hilos vCPU de qemu ocupaban núcleos físicos todo el tiempo;
 * el escritorio de Windows, el ratón y el navegador solo tenían el tiempo restante: «se traba apenas se abre».
 * Para una app Android 2 vCPU sobran; dar más solo ralentiza el equipo.
 *
 * La memoria y la resolución no se tocan a propósito: el límite de memoria ya es de 2–3 GB, y bajar la resolución
 * cambiaría la huella de la instantánea quickboot y obligaría a un arranque en frío en cada cambio de modo; no compensa.
 *
 * Función pura; con settings null devuelve null (no cambia el comportamiento de llamadores/pruebas antiguos).
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // La lógica anterior era floor(núcleos/4) limitado a 2–3: un equipo de 8 núcleos solo recibía 2 vCPU, y el video decodificado por software
    // (apps de videos cortos) iba como presentación de diapositivas. Ahora es «la mitad de los núcleos físicos, máximo 4»:
    // 8 núcleos dan 4, 4 dan 2; al escritorio le sobran núcleos y el video también alcanza.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3 GB bastan para Android 14 y las apps habituales; más solo aumenta el uso de memoria y el tamaño de la instantánea quickboot
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // Modo «ahorro»: cargas ligeras como ver videos o leer no necesitan 3 GB; el límite baja a 2 GB.
  // Efecto directo: qemu residente usa ~1 GB menos de memoria y la instantánea quickboot también 1 GB menos (mejora la sincronización de disco).
  // Solo se reduce si el usuario no fijó la memoria a mano; el valor manual siempre tiene prioridad.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // Si no alcanza la memoria física disponible se reduce; Android 14 necesita al menos 2 GB; por debajo solo puede ir lento con TCG
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) {
    // El límite sigue al anfitrión: antes estaba fijo en 8192 y un equipo de 32 GB solo podía asignar 8 GB,
    // y en juegos grandes (sobre todo con paquetes HD) se liberaban texturas constantemente: tirones/pantalla negra.
    const lim = memoryLimits(host.totalMB);
    memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, lim.maxMB);
  }

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) {
    // También según el anfitrión: al menos 1 núcleo para Windows; en equipos de un núcleo se sigue dando 1
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // Solo si el usuario no fijó los núcleos a mano los ajusta el modo ligero; el valor manual siempre tiene prioridad
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /Capacidad de data: las apps, los paquetes de recursos de juegos y sus «actualizaciones» van aquí; 4 GB se llenan enseguida
  // (el síntoma es «espacio en disco insuficiente» al actualizar dentro de la app). Por defecto 6/8 GB según el espacio libre;
  // el usuario también puede fijarlo en Configuración (al aumentarlo se amplía en el sitio en el próximo arranque, sin perder datos).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // El valor automático también sigue al espacio libre: un juego de 50 GB descomprimido se acerca a 90 GB; con mucho espacio se empieza en 16 GB,
  // para que no diga «espacio insuficiente» tras instalar el primer juego grande.
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // Si lo fija el usuario se limita al «80 % del disco»: pedir 128 GB con solo 20 GB libres fallaría a mitad de instalación
  const dataMaxMB = disk ? Math.max(2048, Math.floor((disk * 0.8) / 1024) * 1024) : 262144;
  const dataMB = wantGB > 0
    ? clamp(Math.round(wantGB * 1024), 2048, Math.min(262144, dataMaxMB))
    : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Resolución de renderizado: en auto se elige según la aceleración (con emulación por software baja a 540x960 para que vaya fluido)
  // Prioridad horizontal: la horizontal la decide el «tamaño de la pantalla física», que hay que escribir en el AVD y reiniciar,
  // así que primero se fija la orientación con settings.display.landscape y luego se aplica renderSize.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // Si la resolución explícita del usuario no coincide con la orientación actual, se corrige (en horizontal el lado largo es el ancho)
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // La emulación solo por software sin aceleración sí arranca en Windows, pero el arranque en frío de Android 14 puede tardar 5–10 minutos
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Convierte la configuración de «Parámetros avanzados» del usuario en overrides.
 * 0 / auto / sin configurar se consideran «sin sustitución» y se sigue deduciendo automáticamente;
 * solo tienen efecto si el usuario desactiva la memoria automática y pone un valor concreto.
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * Punto de entrada único para mostrar / diagnosticar: calcula los mismos parámetros que el arranque real sin iniciar Android.
 * Antes la configuración llamaba directo a chooseProfile() (sin versión ni estado de aceleración), y en equipos con 37.x
 * mostraba por error swiftshader_indirect obsoleto / emulación por software, distinto de los parámetros reales.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // host se puede inyectar: las pruebas/diagnóstico pueden simular «un equipo pequeño de 4 núcleos» sin cambiar de equipo.
    // Sin indicarlo se calcula con el equipo real (en ejecución normal siempre es este caso).
    host: host || hostInfo(),
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Matriz de reintentos por fallo: de «lo mejor» a «lo más conservador», como máximo 4 intentos.
 * En orden: cambiar el motor de GPU → desactivar la aceleración por hardware y usar TCG → bajar memoria y forzar arranque en frío sin instantánea.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'aceleración por hardware' : 'Emulación por software'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Emulación por software sin aceleración (lenta, pero la más compatible)',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Arranque en frío conservador (memoria mínima + sin instantánea)',
    // Aquí **nunca** se puede hacer wipe: antes estaba wipe:true, y con el disco lleno cada intento fallaba,
    // así que los reintentos seguidos «borraban instantáneas + datos» junto con las apps y partidas del usuario;
    // así ocurría «el disco se llenó y al abrir LanzadorAPK desaparecieron todas las apps».
    // Si hay que recrear userdata lo decide ensureDataPartition (solo lo recrea si la imagen está dañada),
    // no el -wipe-data de los parámetros de arranque.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Deduplicate: never retry the same gpu/accel/wipe/memory/snapshot combination twice.
  // On low-RAM hosts (memoryMB already 2048) the "software" step and the last-resort step
  // used to be identical, wasting a full boot timeout (up to 4 min). When they collide, the
  // last-resort step (smaller data partition, flagged lastResort) replaces the earlier one.
  const byKey = new Map();
  for (const v of out) {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}`;
    if (!byKey.has(k) || v.lastResort) byKey.set(k, v);
  }
  return out.filter((v) => byKey.get(`${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}`) === v);
}

/** Busca un par de puertos libres (la consola de emulator + el puerto de registro adb deben ser par/impar consecutivos) */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * Puerto del servidor adb: fijo, sin buscar otro.
 * Antes se «buscaba un puerto libre desde 5044 hacia arriba», pero el servidor adb es residente y ocupa ese puerto,
 * así que cada vez que se iniciaba LanzadorAPK aparecía otro servidor adb (probado: 6 en una sola sesión),
 * y como el puerto cambiaba, al iniciar no se podía tomar el emulador anterior.
 * 5044 es el puerto exclusivo de LanzadorAPK (el adb del usuario usa 5037); se usa fijo.
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.LANZADORAPK_ADB_PORT) || start;
}

/**
 * Huella de configuración: solo los cambios de «imagen / partición de datos / versión del motor» invalidan la instantánea.
 * A propósito no incluye GPU, aceleración ni memoria: son parámetros que los reintentos automáticos cambian a menudo,
 * y si estuvieran, cada reintento dispararía -wipe-data y borraría las apps instaladas del usuario.
 */
/**
 * «Huella de configuración» de la instantánea quickboot: solo estos cambios invalidan la anterior (pantalla negra/no arranca al cargarla).
 *
 * A propósito **no incluye dataMB**: tras ampliar la partición de datos la instantánea anterior sigue sirviendo (qemu monta
 * con el nuevo tamaño); incluirlo haría que «el usuario solo quería ampliar y terminó con la instantánea invalidada + arranque en frío +
 * datos borrados»: pasó una vez en pruebas y se perdieron todas las apps del equipo.
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * La «identidad» de la imagen del sistema: solo la parte después de `system-images/...`.
 *
 * No importa en qué disco esté la imagen; la misma imagen en otra carpeta no debe tomarse como «otra imagen»;
 * si no, cuando el usuario mueve el runtime del disco C al D (como recomendamos en la propia configuración),
 * el sysdir del AVD no coincide con la nueva ruta → se cree que la imagen cambió → -wipe-data → se pierden todas las apps.
 * Esto pasa de verdad en pruebas, así que en ambos lugares (configuración del AVD, huella de la instantánea) se usa la identidad y no la ruta absoluta.
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // En Windows emulator/qemu salen con 0xC0000005 (decimal 3221225477):
    // en pruebas suele ser «el controlador gráfico / backend Vulkan falla justo cuando el invitado empieza a arrancar»,
    // sin relación con CPU, memoria o imagen (en el mismo equipo, cambiar a -gpu software suele bastar).
    // Debe ir antes que GPU_INIT: el registro del fallo suele traer también información de inicialización del renderizado; detectar primero el fallo es más preciso.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'El motor de renderizado falló (violación de acceso 0xC0000005)',
    hint: 'Se reintentó automáticamente con un motor de renderizado más conservador, y se recordará para no volver a probar el anterior primero. '
      + 'Si se repite, actualiza el controlador de la tarjeta gráfica; o baja la calidad en Configuración → Rendimiento y recursos, y desactiva el escritorio remoto o el paso de GPU a máquinas virtuales.',
  },
  {
    code: 'GPU_INIT',
    // Solo coincide en contexto de «fallo»: en registros normales también aparecen Vulkan/EGL/ANGLE y no deben tomarse como error fatal
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'No se pudo iniciar el motor de renderizado de la GPU',
    hint: 'Se cambió automáticamente a renderizado por software. Si sigue fallando, actualiza el controlador de la tarjeta gráfica o desactiva el escritorio remoto o el paso de GPU a máquinas virtuales.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'El runtime actual no acepta este modo de GPU',
    hint: 'Se reintentó automáticamente con un modo de GPU compatible con la versión del runtime (swiftshader_indirect en versiones antiguas, software en las nuevas).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: 'Aceleración por hardware no disponible',
    hint: 'Se pasó automáticamente a emulación por software (el primer arranque será bastante más lento). Para que vaya fluido, marca «Plataforma de máquina virtual» en «Características de Windows» o instala el controlador AEHD y reinicia.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足|memoria insuficiente/i,
    title: 'Error al asignar memoria',
    hint: 'Se redujo automáticamente la memoria y los núcleos asignados a Android. Cierra programas que usen mucha memoria e inténtalo de nuevo.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'El puerto del emulador está ocupado',
    hint: 'Se cambió automáticamente a un puerto libre. Si se repite, cierra otros emuladores (BlueStacks, Nox, MuMu, etc.) o reinicia el equipo.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'La ejecución anterior dejó archivos de bloqueo',
    hint: 'Se borraron automáticamente los archivos de bloqueo del AVD y se volvió a iniciar.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'La imagen del sistema falta, está dañada o no es compatible con los datos de usuario anteriores',
    hint: 'Se reinició automáticamente con datos de usuario limpios. Si sigue fallando, borra la imagen en «Runtime» y vuelve a descargarla.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: 'El antivirus borró componentes del runtime o falta Microsoft Visual C++ Redistributable',
    hint: 'Agrega la carpeta de Lanzador APK a las exclusiones del antivirus, vuelve a descomprimir el instalador e instala Microsoft VC++ 2015-2022.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足|espacio en disco insuficiente/i,
    title: 'No hay espacio en disco suficiente para iniciar Android',
    hint: 'Mueve la carpeta del runtime (Configuración → Integración con el sistema → Carpeta de datos del runtime) a un disco con espacio suficiente, '
      + 'o desactiva «Conservar instantánea de arranque rápido» / reduce la partición de datos en Configuración. Los datos de Android no se borran automáticamente.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
    title: 'La ruta de instalación tiene acentos o caracteres especiales',
    hint: 'Se usó automáticamente la ruta corta de Windows. Si sigue fallando, mueve Lanzador APK a una carpeta con nombre solo en ASCII (p. ej. C:\\LanzadorAPK).',
  },
  {
    // Tras un cierre forzado quedan hardware-qemu.ini.lock / multiinstance.lock en la carpeta del AVD,
    // el emulador se niega a arrancar y el mensaje se confunde fácilmente con un problema de CPU. Debe ir antes que las reglas de CPU.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'La ejecución anterior no se cerró bien y dejó archivos de bloqueo',
    hint: 'Lanzador APK borrará los bloqueos y lo reintentará; si se repite, revisa si otro emulador está usando el mismo runtime.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'A la CPU le faltan instrucciones que el runtime necesita',
    hint: 'En algunas CPU antiguas esto es solo una advertencia y Android arranca igual; si de verdad no arranca, usa en «Runtime» una versión del motor más antigua y compatible, o un equipo con VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Instantánea de arranque rápido dañada',
    hint: 'Se descartó automáticamente la instantánea y se hizo un arranque en frío; la próxima salida normal generará una nueva.',
  },
];

/** Convierte el registro en {code,title,hint} para mostrarlo en la interfaz y decidir los reintentos automáticos */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'El runtime no terminó de arrancar',
    hint: 'Se reintentó automáticamente con varias combinaciones de parámetros. Pulsa «Exportar informe de diagnóstico» y envía el registro al equipo de soporte para revisarlo.',
  };
}

/** Resumen legible de una línea, en la configuración, para que los usuarios avanzados sepan qué se eligió automáticamente */
function describeProfile(p) {
  return `Automático: ${(p.memoryMB / 1024).toFixed(1)}GB de memoria · ${p.cores} núcleos · ${p.gpu} renderizado · `
    + `${p.accelOk ? 'aceleración por hardware' : 'Emulación por software'} · ${p.snapshot ? 'instantánea bajo demanda' : 'arranque en frío'}`
    + `${p.lite ? ' · contenedor ligero' : ''} · puerto ${p.port}`;
}

/** Exporta el informe de diagnóstico (texto plano, fácil de enviar por correo/pegar en una issue) */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'Informe de diagnóstico de Lanzador APK',
    `Generado: ${new Date().toLocaleString()}`,
    '',
    '== Este equipo ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Configuración automática ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Diagnóstico ==',
    `${d.code}: ${d.title}`,
    d.hint,
    '',
    '== Información adicional ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Registro del runtime (últimas 300 líneas) ==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * Comprueba si está instalado Microsoft VC++ 2015-2022 x64.
 * El emulador de Android (Qt6) y qemu dependen de él; si falta, en otros equipos no arrancan
 * (da 0xc0000135 / falta MSVCP140). El instalador ya incluye vc_redist.x64.exe;
 * aquí solo se detecta, para avisar claramente antes de arrancar y ofrecer la instalación con un clic.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // Primero las DLL: msvcp140 / vcruntime140 son justo los dos archivos que necesitan Qt6 y qemu.
  // Comprobar por archivo evita lanzar reg.exe (algunos programas de seguridad lo bloquean y retrasa la comprobación de cada 60 s),
  // y no da un falso «no instalado» si una herramienta de limpieza borró la clave del registro.
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* Respaldo con el registro */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* Si la clave no existe = no instalado */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, detectGpuVendor, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
