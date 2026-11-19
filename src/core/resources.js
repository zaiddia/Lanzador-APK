'use strict';
/**
 * Lógica pura de asignación de recursos (memoria / CPU / almacenamiento).
 *
 * Por qué va en una capa aparte: «cuánta memoria dar a Android» termina en la línea de comandos de qemu (-memory / -cores)
 * y se aplica en el próximo arranque; pero «cuánto puede poner el usuario» y «qué pasa si se pasa» son funciones puras,
 * separadas sin depender de electron, para probarlas directamente con require en CI.
 *
 * Tres restricciones firmes (todas salieron de pruebas reales):
 *   1. La memoria no puede agotar al anfitrión: Windows + el programa en primer plano necesitan al menos un 25 %; si no, todo el equipo pagina
 *      y Android muestra largos periodos en negro y animaciones congeladas, como si «el emulador estuviera roto».
 *   2. El almacenamiento se estima como «paquete × 1,8 + 2 GB»: un juego en línea de 50 GB descomprimido suele ocupar 80–90 GB;
 *      permitirlo solo por el tamaño del paquete hace que falle a mitad de la instalación.
 *   3. Todo valor automático debe poder calcularse: si no hay información del anfitrión se usa un valor conservador; nunca devolver NaN.
 */

const DEFAULT_STEP_MB = 512;
const MIN_MEM_MB = 1024;
/** Proporción reservada para el anfitrión (Windows + programas en primer plano) */
const HOST_RESERVE_RATIO = 0.25;
/** Por debajo de esta proporción se avisa «justo» */
const TIGHT_RATIO = 0.8;
/** Mínimo absoluto totalmente insuficiente (ni el sistema arranca) */
const ABSOLUTE_MIN_MB = 768;

function toInt(v, fallback = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Capacidades del anfitrión. Los parámetros se pueden inyectar para pruebas; si no, se lee este equipo.
 * @returns {{ totalMB:number, cores:number }}
 */
function hostProfile(sys) {
  let totalMB = 0;
  let cores = 0;
  const src = sys || {};
  if (Number(src.totalMB) > 0) {
    totalMB = toInt(src.totalMB);
  } else if (Number(src.totalmem) > 0) {
    totalMB = Math.round(Number(src.totalmem) / 1048576);
  } else {
    try {
      // require('os') va dentro de la función: así no se toca el entorno del anfitrión al cargar el módulo
      const os = require('os');
      totalMB = Math.round(os.totalmem() / 1048576);
      cores = os.cpus() ? os.cpus().length : 0;
    } catch (_) { totalMB = 0; }
  }
  if (Number(src.cores) > 0) cores = toInt(src.cores);
  return { totalMB, cores: Math.max(1, cores || 1) };
}

/**
 * Rango de memoria permitido. Si no se lee la memoria del anfitrión se da un límite conservador, para que la interfaz no muestre 0.
 * @returns {{ minMB:number, maxMB:number, stepMB:number, totalMB:number }}
 */
function memoryLimits(totalMB) {
  const total = toInt(totalMB);
  if (total <= 0) return { minMB: MIN_MEM_MB, maxMB: 8192, stepMB: DEFAULT_STEP_MB, totalMB: 0 };
  const usable = Math.floor((total * (1 - HOST_RESERVE_RATIO)) / DEFAULT_STEP_MB) * DEFAULT_STEP_MB;
  const maxMB = Math.max(MIN_MEM_MB, Math.min(usable, 65536));
  return { minMB: MIN_MEM_MB, maxMB, stepMB: DEFAULT_STEP_MB, totalMB: total };
}

/**
 * Ajusta la memoria indicada por el usuario a un valor válido. 0 = automático, se devuelve 0 tal cual (cada backend lo deduce).
 * @returns {{ mb:number, capped:boolean, reason:string }}
 */
function clampMemoryMB(mb, totalMB) {
  const want = toInt(mb);
  if (want <= 0) return { mb: 0, capped: false, reason: 'auto' };
  const lim = memoryLimits(totalMB);
  const rounded = Math.round(want / lim.stepMB) * lim.stepMB;
  if (rounded > lim.maxMB) {
    return {
      mb: lim.maxMB,
      capped: true,
      reason: `Memoria del equipo ${Math.round(lim.totalMB / 1024)} GB; se pueden asignar como máximo ${Math.round(lim.maxMB / 1024)} GB (hay que dejar el 25 % para Windows)`,
    };
  }
  if (rounded < lim.minMB) return { mb: lim.minMB, capped: true, reason: `Android necesita al menos ${lim.minMB} MB para arrancar` };
  return { mb: rounded, capped: rounded !== want, reason: rounded !== want ? 'Ajustado a múltiplos de 512 MB' : '' };
}

/**
 * Ajusta la cantidad de núcleos de CPU. 0 = automático.
 * El límite es «núcleos físicos - 1», dejando al menos 1 al anfitrión; un equipo de un núcleo recibe 1.
 */
function clampCores(n, hostCores) {
  const want = toInt(n);
  const total = Math.max(1, toInt(hostCores) || 1);
  const max = total > 1 ? total - 1 : 1;
  if (want <= 0) return { cores: 0, capped: false, reason: 'auto' };
  if (want > max) {
    return { cores: max, capped: true, reason: `Este equipo: ${total} núcleos; se pueden asignar como máximo ${max} núcleos (se deja 1 para Windows)` };
  }
  return { cores: Math.max(1, want), capped: false, reason: '' };
}

/**
 * Si la asignación de memoria es razonable (para avisos en la interfaz + recordatorio antes de instalar paquetes grandes).
 * @returns {{ level:'ok'|'tight'|'insufficient'|'unknown', ratio:number, note:string }}
 */
function memVerdict(allocMB, hostMB) {
  const alloc = toInt(allocMB);
  const host = toInt(hostMB);
  if (!alloc || !host) return { level: 'unknown', ratio: 0, note: '' };
  if (alloc < ABSOLUTE_MIN_MB) {
    return { level: 'insufficient', ratio: alloc / host, note: `Solo se asignan ${alloc} MB; puede que Android no arranque` };
  }
  const ratio = alloc / host;
  if (ratio > 1 - HOST_RESERVE_RATIO) {
    return {
      level: 'insufficient',
      ratio,
      note: `Usa el ${Math.round(ratio * 100)} % de la memoria del equipo; Windows empezará a paginar y el emulador irá aún más lento`,
    };
  }
  if (ratio > TIGHT_RATIO * (1 - HOST_RESERVE_RATIO)) {
    return { level: 'tight', ratio, note: `Usa el ${Math.round(ratio * 100)} % de la memoria del equipo; conviene cerrar pestañas del navegador a la vez` };
  }
  return { level: 'ok', ratio, note: '' };
}

/** Espacio real de la partición de datos que ocupa instalar un paquete (incluye la descompresión y el margen de actualizaciones) */
function diskRequiredMB(packageBytes, ratio = 1.8, reserveMB = 2048) {
  const bytes = Math.max(0, Number(packageBytes) || 0);
  if (!bytes) return reserveMB;
  return Math.ceil((bytes / 1048576) * ratio) + reserveMB;
}

/**
 * Límite permitido de la partición de datos. Con poco disco no se puede dejar poner 64 GB y que falle a mitad de la instalación.
 * @returns {{ maxGB:number, warnGB:number, freeMB:number }}
 */
function diskLimits(freeMB) {
  const free = Math.max(0, toInt(freeMB));
  // La propia imagen de la partición ocupa espacio del anfitrión (una imagen dinámica crece hasta casi el tamaño de la partición); se deja un 20 % de margen
  const maxGB = Math.max(0, Math.floor((free / 1024) * 0.8));
  return { maxGB, warnGB: Math.max(0, maxGB - 8), freeMB: free };
}

/**
 * Ajusta el tamaño de la partición de datos indicado por el usuario (GB). 0 = automático.
 * @returns {{ gb:number, capped:boolean, reason:string }}
 */
function clampDataGB(gb, freeMB) {
  const want = toInt(gb);
  if (want <= 0) return { gb: 0, capped: false, reason: 'auto' };
  const lim = diskLimits(freeMB);
  if (!lim.freeMB) return { gb: want, capped: false, reason: '' };
  if (want > lim.maxGB) {
    return {
      gb: Math.max(0, lim.maxGB),
      capped: true,
      reason: `El disco solo tiene ${(lim.freeMB / 1024).toFixed(1)} GB libres; se pueden asignar como máximo ${lim.maxGB} GB`,
    };
  }
  return { gb: want, capped: false, reason: '' };
}

/**
 * Si el almacenamiento alcanza para este paquete.
 * @returns {{ ok:boolean, needMB:number, freeMB:number, shortMB:number, note:string }}
 */
function storageVerdict(freeMB, packageBytes) {
  const need = diskRequiredMB(packageBytes);
  const free = Math.max(0, toInt(freeMB));
  if (!free) return { ok: true, needMB: need, freeMB: 0, shortMB: 0, note: 'No se pudo leer el espacio libre del disco; se omite la comprobación previa' };
  if (free >= need) return { ok: true, needMB: need, freeMB: free, shortMB: 0, note: '' };
  const short = need - free;
  return {
    ok: false,
    needMB: need,
    freeMB: free,
    shortMB: short,
    note: `Se necesitan unos ${(need / 1024).toFixed(1)} GB y solo quedan ${(free / 1024).toFixed(1)} GB; faltan ${(short / 1024).toFixed(1)} GB`,
  };
}

/**
 * Si el espacio en disco alcanza para este paquete (el punto de fallo más común de los juegos de 50 GB).
 * Diferencia con storageVerdict: este solo mira «si alcanza» y el texto es para bloquear antes de instalar.
 * @returns {{ ok:boolean, unknown?:boolean, freeMB:number, requiredMB:number, message:string }}
 */
function diskVerdict(freeMB, requiredMB) {
  const free = Math.max(0, toInt(freeMB));
  const need = Math.max(0, toInt(requiredMB));
  if (!free) return { ok: true, unknown: true, freeMB: 0, requiredMB: need, message: '' };
  if (free >= need) return { ok: true, freeMB: free, requiredMB: need, message: '' };
  return {
    ok: false,
    freeMB: free,
    requiredMB: need,
    message: `Espacio en disco insuficiente: se necesitan unos ${Math.ceil(need / 1024)} GB más, pero el disco del runtime de Lanzador APK solo tiene ${(free / 1024).toFixed(1)} GB libres. `
      + 'En Configuración mueve la carpeta del runtime a una partición con más espacio, o libera espacio e inténtalo de nuevo.',
  };
}

module.exports = {
  DEFAULT_STEP_MB,
  MIN_MEM_MB,
  HOST_RESERVE_RATIO,
  hostProfile,
  memoryLimits,
  clampMemoryMB,
  clampCores,
  memVerdict,
  diskRequiredMB,
  diskVerdict,
  diskLimits,
  clampDataGB,
  storageVerdict,
};
