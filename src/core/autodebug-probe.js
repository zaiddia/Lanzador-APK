'use strict';
/**
 * Comprobación automática · capa de recolección (solo en el proceso principal)
 *
 * Función: toma el estado real del equipo como una instantánea de **datos puros** obs y se la pasa a src/core/autodebug.js para evaluarla.
 * La recolección puede fallar: si no obtiene algo lo deja vacío y la capa de evaluación «no lo sabe»; nunca inventa conclusiones.
 *
 * Elementos recolectados y presupuesto de tiempo (una pasada completa tarda ~2–5 s):
 *   - estado del runtime (status del motor: entorno + adb en línea)
 *   - autorización de adb del dispositivo
 *   - espacio libre en disco, capacidad de la partición de datos, permiso de escritura en la carpeta compartida
 *   - bloqueos restantes del AVD, instantáneas vacías, procesos huérfanos del emulador
 *   - líneas de error en el registro reciente
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AVD_NAME, SNAPSHOT_NAME } = require('./emulator');

/** Cronómetro de la fase de arranque: el momento en que se vio por primera vez «en marcha pero no listo» */
let bootingSince = 0;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/** Cuenta los .lock que quedan en la carpeta del AVD (archivos o carpetas) */
function countLocks(avdDir) {
  try {
    return fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Si la instantánea es un «cascarón vacío»: está snapshot.pb pero la imagen de memoria falta o es demasiado pequeña.
 * Una instantánea así hace que cada arranque «falle al cargar y arranque en frío», y ocupa varios GB de disco en vano.
 * Solo se evalúa en modo lectura; aquí no se borra: el borrado queda para la confirmación del usuario o una acción de reparación.
 */
function inspectSnapshot(avdHome, avdName, snapshotName) {
  const base = path.join(avdHome, `${avdName}.avd`, 'snapshots', snapshotName);
  const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
  const pb = size(path.join(base, 'snapshot.pb'));
  const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
  if (pb === 0 && ram === 0) return { present: false, stale: false, mb: 0 };
  const mb = Math.round((pb + ram) / 1048576);
  const stale = !(pb > 1024 && ram > 1024 * 1024);
  return { present: true, stale, mb };
}

/** Cuenta los procesos huérfanos del emulador aún vivos (emulator.exe / qemu-system*.exe) */
function countOrphanProcesses() {
  return new Promise((resolve) => {
    let out = '';
    try {
      execFile('tasklist.exe', ['/NH', '/FO', 'CSV'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(null); return; }
        out = String(stdout || '');
        const lines = out.split(/\r?\n/).filter((l) => /emulator\.exe|qemu-system/i.test(l));
        resolve(lines.length);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/** Lee las líneas de error del archivo de registro reciente (como máximo las últimas 300 líneas) */
function recentLogErrors(files, max = 300) {
  const out = [];
  for (const file of files) {
    let text = '';
    try {
      const size = fs.statSync(file).size;
      const take = Math.min(size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) { continue; }
    const lines = text.split(/\r?\n/).slice(-max);
    for (const line of lines) {
      if (/\b(ERROR|FATAL|FATAL ERROR|Exception|FATAL:|panic:)\b/i.test(line)) {
        out.push(line.trim().slice(0, 240));
      }
    }
  }
  return out.slice(-20);
}

/**
 * Toma una instantánea
 * @param {object} ctx { runtime, store, doctor }
 * @returns {Promise<object>} obs
 */
async function collect(ctx) {
  const { runtime, store, doctor } = ctx;
  const obs = {
    at: Date.now(),
    runtime: {},
    device: { checked: false },
    storage: {},
    settings: {},
    network: {},
    logs: {},
    accel: { checked: false },
  };

  // ---- Configuración (lo más barato, primero) ----
  let settings = {};
  try { settings = store.getSettings() || {}; } catch (_) { settings = {}; }
  obs.settings = {
    orientationMode: (settings.display && settings.display.orientationMode) || 'auto',
    landscape: !!(settings.display && settings.display.landscape),
    // Desde 0.6.0 la ventana nativa es el valor por defecto: solo true explícito cuenta como modo incrustado
    windowEmbed: !!(settings.display && settings.display.windowEmbed === true),
    autoFullscreen: !!(settings.display && settings.display.autoFullscreenOnLaunch),
    keepSnapshot: !(settings.engine && settings.engine.keepSnapshot === false),
    resourceMode: (settings.engine && settings.engine.resourceMode) || '',
  };

  // ---- Estado del runtime ----
  let status = null;
  try {
    status = await withTimeout(runtime.status(), 20000, null);
  } catch (_) { status = null; }

  let paths = null;
  try { paths = runtime.provisioner.paths(); } catch (_) { paths = null; }

  const running = !!(status && status.vmRunning)
    || (() => { try { return !!(runtime.emulator && runtime.emulator.running()); } catch (_) { return false; } })();

  const phase = status ? (status.phase || '') : '';
  const ready = !!(status && status.ready);
  if (running && !ready) {
    if (!bootingSince) bootingSince = Date.now();
  } else {
    bootingSince = 0;
  }

  const lastFailure = status ? status.lastFailure : null;
  obs.runtime = {
    running,
    phase,
    ready,
    bootMs: bootingSince ? Date.now() - bootingSince : 0,
    error: (status && status.error && !/缺少 adb|Falta adb/.test(status.error)) ? status.error : '',
    lastFailure: lastFailure ? { error: lastFailure.error || lastFailure.reason || '' } : null,
    locks: paths ? countLocks(paths.avdHome) : 0,
    orphans: null,
    snapshotStale: false,
  };

  // ---- Autorización de adb del dispositivo ----
  try {
    const client = runtime.client();
    if (client && typeof client.deviceState === 'function') {
      const state = await withTimeout(client.deviceState(), 10000, null);
      if (state) {
        obs.device = { checked: true, state };
      }
    }
  } catch (_) { /* Si no se puede detectar se deja checked:false */ }

  // ---- Almacenamiento ----
  try {
    const root = paths ? paths.root : null;
    if (root) {
      const freeMB = doctor.freeDiskMB(root);
      obs.storage.freeMB = Number(freeMB) || 0;
    }
  } catch (_) { /* ignore */ }

  try {
    const backend = runtime.backend;
    const info = (backend && typeof backend.dataInfo === 'function') ? (backend.dataInfo() || {}) : {};
    obs.storage.configuredGB = Number(info.configuredGB) || 0;
    obs.storage.actualGB = Number(info.actualGB) || 0;
    obs.storage.needsReset = !!(info.pendingGB || info.needsReset);
  } catch (_) { /* ignore */ }

  try {
    const shared = String(settings.sharedDir || '').trim();
    if (shared) {
      let ok = true;
      try {
        fs.accessSync(shared, fs.constants.W_OK);
      } catch (_) { ok = false; }
      obs.storage.sharedOk = ok;
      obs.storage.sharedPath = shared;
    }
  } catch (_) { /* ignore */ }

  // ---- Instantáneas / bloqueos / huérfanos ----
  try {
    if (paths) {
      const snap = inspectSnapshot(paths.avdHome, AVD_NAME, SNAPSHOT_NAME);
      obs.runtime.snapshotStale = snap.stale;
      obs.runtime.snapshotMB = snap.mb;
    }
  } catch (_) { /* ignore */ }

  const orphans = await countOrphanProcesses();
  if (orphans !== null) {
    // La máquina en marcha ya son dos procesos, emulator.exe + qemu; no son restos.
    const expected = running ? 2 : 0;
    obs.runtime.orphans = Math.max(0, orphans - expected);
  }

  // ---- Red ----
  try {
    const snap = typeof runtime._networkSnapshot === 'function' ? runtime._networkSnapshot() : null;
    if (snap) obs.network = { ok: !!snap.ok, reason: snap.reason || '', ip: snap.ip || '' };
  } catch (_) { /* ignore */ }

  // ---- Aceleración ----
  try {
    if (status && status.accel) {
      obs.accel = { checked: true, ok: !!status.accel.ok, note: status.accel.note || '' };
    }
  } catch (_) { /* ignore */ }

  // ---- Registro ----
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const files = [path.join(store.DATA_DIR, 'app.log'), path.join(dir, 'emulator.log')];
    const errors = recentLogErrors(files);
    obs.logs = { errors, count: errors.length };
  } catch (_) { /* ignore */ }

  return obs;
}

module.exports = { collect, inspectSnapshot, countLocks, recentLogErrors, countOrphanProcesses };
