'use strict';
/**
 * Capas tipo contenedor: imagen base de solo lectura + runtime reducido + capa temporal recuperable
 *
 * Comparación (igual que Docker):
 *   system-images/  = capa base de solo lectura, una sola copia compartida por todas las apps y sesiones, nunca se duplica
 *   avd/*.avd/      = capa delgada escribible (diferencial qcow2 + instantánea quickboot), solo guarda los cambios
 *   _tmp/ snapshots = capa de trabajo recuperable
 *
 * Este módulo solo «hace inventario» y «recupera según una lista explícita»; por defecto dryRun, sin tocar archivos personales del usuario.
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/**
 * Hace inventario del uso del runtime y lista los elementos que «se pueden recuperar sin riesgo».
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, { keepAvd = 'lanzadorapk.avd', aggressive = false, keepSnapshots = false } = {}) {
  const groups = [];
  const candidates = [];
  if (!exists(root)) return { total: 0, groups, candidates };

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file') => candidates.push({ path: p, size, reason, kind });

  groupOf('motor del emulador', path.join(root, 'emulator'));
  groupOf('imagen del sistema (capa base de solo lectura)', path.join(root, 'system-images'));
  groupOf('capa escribible del AVD / instantáneas', path.join(root, 'avd'));
  groupOf('platform-tools', path.join(root, 'platform-tools'));

  // 1) QEMU solo necesita el destino x86_64; los binarios de las otras 7 arquitecturas del paquete son puro desperdicio
  const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (exists(qemuDir)) {
    for (const f of walk(qemuDir)) {
      if (/qemu-system-(aarch64|armel|i386)/i.test(path.basename(f.path))) {
        add(f.path, f.size, 'destinos de QEMU que no son x86_64; el runtime no los usa');
      }
    }
  }

  // 2) textos de licencia / carpetas redundantes del paquete de imagen
  for (const f of walk(path.join(root, 'system-images'))) {
    if (/^(NOTICE\.txt|source\.properties)$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) {
      add(f.path, f.size, 'archivos de documentación grandes dentro del paquete de imagen');
    }
  }

  // 3) una sola imagen del sistema: con la imagen Play API 34 lista, todas las imágenes API 30 antiguas sobran
  const play34 = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img');
  if (exists(play34)) {
    const legacy = path.join(root, 'system-images', 'android-30');
    if (exists(legacy)) add(legacy, dirSize(legacy), 'imagen antigua API 30 (con una capa de traducción ARM obsoleta)', 'dir');
  }
  const stray = path.join(root, 'x86_64');
  if (exists(stray)) add(stray, dirSize(stray), 'carpetas de imagen duplicadas por una descompresión mal ubicada', 'dir');

  // 4) AVD inactivos: el producto solo usa lanzadorapk; los restos de pruebas lanzadorapk-arm / -houdini, etc. se pueden borrar
  const avdHome = path.join(root, 'avd');
  if (exists(avdHome)) {
    for (const e of fs.readdirSync(avdHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.avd') || e.name === keepAvd) continue;
      add(path.join(avdHome, e.name), dirSize(path.join(avdHome, e.name)),
        'AVD inactivos (con imágenes antiguas de datos de 8-16 GB)', 'dir');
    }
    // 5) archivos de bloqueo: si quedan provocan «AVD is already running»
    for (const f of walk(avdHome)) {
      if (/\.lock$/i.test(f.path)) add(f.path, f.size, 'archivos de bloqueo de una salida anormal anterior');
    }
    // 6) instantánea de arranque rápido: ram.img ≈ la memoria asignada a la máquina virtual; si se daña o cambia la configuración hay que descartarla
    const activeAvd = path.join(avdHome, keepAvd);
    if (exists(activeAvd) && !keepSnapshots) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        // Tanto las instantáneas normales como las viejas renombradas tras un borrado fallido se pueden recuperar
        if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
        const p = path.join(activeAvd, e.name);
        add(p, dirSize(p), 'instantáneas quickboot antiguas (se recrean al cambiar la configuración)', 'dir');
      }
    }
  }

  // 7) caché de descargas / ISO heredada de QEMU
  for (const d of ['_tmp', 'images']) {
    const p = path.join(root, d);
    if (exists(p)) {
      const size = dirSize(p);
      if (size > 0) add(p, size, d === '_tmp' ? 'archivos temporales de descarga' : 'restos antiguos de QEMU/ISO', 'dir');
    }
  }

  // 8) recorte agresivo: solo al compilar el paquete de distribución.
  // Ojo: Qt6WebEngineCoreAndroidEmu.dll es una dependencia de carga de qemu-system-x86_64.exe;
  // probado: sin ella no arranca, nunca debe ir en la lista; qsn/netsim pueden usarse bajo demanda por las instantáneas y la red, se conservan por prudencia.
  if (aggressive) {
    const extras = [
      ['emulator/crashreport.exe', 'herramienta de informes de fallos (no hace falta sin ventana)'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * Recupera. Hay que pasar apply:true explícitamente; quien llama (interfaz/script de compilación) debe mostrar antes la lista y obtener confirmación.
 * Restricción de seguridad: todo objetivo debe estar dentro de root, y no se puede borrar root mismo.
 */
function prune(root, { apply = false, keepAvd, aggressive = false, keepSnapshots = false, onRemove = () => {} } = {}) {
  const report = analyze(root, { keepAvd, aggressive, keepSnapshots });
  const rootAbs = path.resolve(root);
  const removed = [];
  let saved = 0;
  for (const c of report.candidates) {
    const p = path.resolve(c.path);
    if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;
    if (!exists(p)) continue;
    if (apply) {
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* Los archivos en uso se omiten; se limpian la próxima vez */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** Resumen breve para la configuración */
function summary(root) {
  const a = analyze(root);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // Además de la carpeta del runtime, al usuario le importa sobre todo «cuánto disco ocupa todo esto»:
  // cuentan el AVD (datos de apps + instantáneas), la caché de APK, los iconos y los registros.
  const store = require('./store');
  const extra = [
    { key: 'avd', label: 'datos de Android (apps + instantáneas)', path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: 'caché de instaladores APK', path: store.APK_DIR },
    { key: 'icons', label: 'caché de iconos del escritorio', path: store.ICON_DIR },
    { key: 'logs', label: 'Registro', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: 'runtime (motor + imagen del sistema)', size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
