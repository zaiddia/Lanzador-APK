'use strict';
/**
 * Motor Emulator: maneja el Android Emulator oficial de Google como runtime de LanzadorAPK.
 *
 * La gran diferencia con la versión anterior: aquí ya no se supone que «un conjunto de parámetros funciona en todos los equipos».
 *  1. doctor.chooseProfile() deduce los parámetros según memoria/CPU/disco/aceleración/versión del motor;
 *  2. si el arranque falla, planVariants() reintenta degradando automáticamente (motor de GPU → emulación por software → arranque en frío con memoria mínima);
 *  3. elige puertos libres al vuelo, limpia bloqueos del AVD, convierte rutas con acentos a rutas cortas e invalida la instantánea si cambia la imagen;
 *  4. instantánea quickboot + partición de datos pequeña, para compartir «como un contenedor» una capa base de solo lectura y recuperar en segundos.
 *
 * El callback probe lo da la capa superior (Runtime) y sirve para decidir si Android está realmente listo.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const drivers = require('./drivers');
const userdata = require('./userdata');
const sparse = require('./sparse');

const AVD_NAME = 'lanzadorapk';
const SNAPSHOT_NAME = 'lanzadorapk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * En Windows traduce los códigos de salida de emulator/qemu a lenguaje humano.
 * 0xC0000005 (3221225477) es el fallo más común: violación de acceso; en pruebas casi siempre lo causa
 * el controlador gráfico / backend Vulkan que falla justo al arrancar el invitado; cambiar a renderizado por software lo evita.
 */
function describeExitCode(code) {
  // Si el proceso termina por señal, code es null (en Windows pasa con taskkill / adb emu kill),
  // no se puede reportar como 0 «salida normal», pero tampoco es una anomalía; se devuelve una cadena vacía para que quien llama lo muestre tal cual.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'Salida normal';
    case 1: return 'Error en los parámetros de inicio o en el entorno';
    case 3221225477: return '0xC0000005 violación de acceso: el motor de renderizado falló';
    case 3221225725: return '0xC00000FD desbordamiento de pila';
    case 3221225781: return '0xC0000135 falta una DLL (VC++ Redistributable, o el antivirus borró componentes del runtime)';
    case 3221225506: return '0xC0000022 acceso denegado (problema de controladores o permisos)';
    case 3221225595: return '0xC000007B la arquitectura de la imagen no coincide o hay una DLL dañada';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    /**
     * Efecto de los controladores (parches de compatibilidad) aplicados en este arranque y la lista de los que coincidieron.
     * Lo rellena _resolveDrivers() en start(); buildArgs / env / ensureAvd solo lo leen.
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // El ram.bin de la instantánea ≈ la memoria asignada a la máquina virtual (2-4 GB).
    // Los equipos que ya arrancan rápido en frío no deberían pagar varios GB de disco por ella; solo se guarda si «de verdad es lento».
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Guarda en disco «el último fallo de arranque».
   * La versión anterior solo lo tenía en memoria (this.attempts); si el usuario reiniciaba LanzadorAPK y luego exportaba el informe de diagnóstico,
   * el informe salía vacío con attempts: [], bootLog: [], y solo quedaba buscar en el registro; esa era
   * la causa directa de «adjunté el informe pero no se ve el motivo» de las issues #20/#25.
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* Si falla la escritura en disco no se afecta el flujo principal */ }
  }

  /** Lee el último registro de fallo (para el informe de diagnóstico / avisos antes de arrancar) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** Carpetas de emulator.exe y de la imagen del sistema (primero la carpeta del runtime del usuario, luego engine/ del repositorio) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Elección de imagen: si existe la imagen universal (API 34 Play) se usa; el usuario ya no cambia a «modo compatible» */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Invalida la instantánea quickboot.
   * La instantánea guarda memoria e imagen de disco; si tras instalar una app/borrar datos se carga la instantánea vieja,
   * el usuario ve que «la app recién instalada desapareció al reiniciar».
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Limpia los bloqueos que dejó una salida anormal anterior.
   * Ojo: hardware-qemu.ini.lock es una **carpeta**, no un archivo; un rmSync(force) estilo bsdtar no la borra,
   * y el emulador sigue diciendo "Running multiple emulators with the same AVD" sin arrancar
   * (pasa tras un solo cierre forzado); hay que borrarla recursivamente.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* Si está en uso se omite; se limpia la próxima vez */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Si la carpeta del AVD tiene de verdad una instantánea quickboot **completa**.
   * No basta con «la carpeta no está vacía»: si se interrumpe el guardado queda un cascarón con un snapshot.pb de 12 bytes,
   * emulator intenta cargarlo, falla (registro "does not have the requested snapshot") y vuelve al arranque en frío,
   * perdiendo unos segundos. Aquí se valida por tamaño y de paso se borran cascarones y el default_boot heredado (3 GB por sí solo).
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // El emulator nuevo (37.x) escribe ram.bin; las versiones antiguas ram.img.
    // Aceptar solo ram.img tenía consecuencias graves: la instantánea de 3 GB recién guardada se tomaba por vacía y se borraba,
    // y siempre se pasaba -no-snapshot-load, arrancando en frío para siempre: la mitad de la causa de «abre muy lento».
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // La carpeta ni existía; no hay que borrar nada
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Borra carpetas de instantáneas heredadas/de renombrados fallidos (el ram.img de default_boot puede pesar 3 GB) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Elimina los emuladores huérfanos que retienen el bloqueo del AVD.
   * emulator.exe solo es un lanzador; el qemu real se lanza como proceso independiente (detached),
   * así que matar solo nuestro identificador proc suele dejar un huérfano reteniendo multiinstance.lock,
   * y el siguiente arranque da FATAL "Running multiple emulators with the same AVD".
   * Se limpian por dos fuentes: «el pid del bloqueo del AVD» + «qemu/emulator cuya línea de comandos lleva el nombre de este AVD».
   */
  /**
   * Si la pantalla del AVD actual es horizontal o vertical.
   *
   * Por qué preguntarlo: la horizontal **solo se logra con la pantalla física**: `wm size` solo cambia la resolución lógica y la imagen
   * queda acostada 90°; `adb emu rotate` solo gira el contenido y el sistema sigue en vertical. Lo que funciona es
   * intercambiar `hw.lcd.width/height` + reiniciar. Y config.ini se escribe en cada arranque con la configuración de ese momento,
   * así que leerlo dice qué orientación tiene **la máquina que está corriendo ahora**.
   *
   * @returns {boolean|null} true = pantalla horizontal, false = vertical, null = no se pudo leer
   */
  panelLandscape() {
    try {
      const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
      const cfg = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
      const w = Number((/^hw\.lcd\.width=(\d+)$/m.exec(cfg) || [])[1]);
      const h = Number((/^hw\.lcd\.height=(\d+)$/m.exec(cfg) || [])[1]);
      if (!w || !h) return null;
      return w > h;
    } catch (_) {
      return null;
    }
  }

  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Ruta rápida (se pasa por aquí en cada arranque en frío):
    //  - sin .lock → no puede haber un emulator vivo usando este AVD; se vuelve directamente;
    //  - hay lock pero nadie escucha en el puerto → solo es una carpeta que dejó un cierre forzado; se borra.
    // Antes siempre se ejecutaba wmic (1–3 s y mucha CPU), lo que retrasaba notablemente el arranque en frío.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) El pid que el propio emulator escribió en el bloqueo (lo más fiable)
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) Respaldo: buscar el qemu vivo por nombre de proceso + puerto (tasklist/netstat es un orden de magnitud más rápido que wmic)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* Si no se obtiene la lista de procesos, solo se usa el pid del bloqueo */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`Limpiar ${pids.size} procesos del emulador sin cerrar`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** Si hay una consola de emulator escuchando entre 5554 y 5620 (si rechaza la conexión vuelve al instante, costo mínimo) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Informe de controladores para la interfaz/diagnóstico: cuáles se usaron en este arranque, cuáles se omitieron y por qué.
   * @returns {{ applied:Array, effect:object|null, errors:Array, host:object|null }}
   */
  driverReport() {
    const pick = (d) => ({
      id: d.id, name: d.name, version: d.version, author: d.author || '',
      description: d.description || '', priority: d.priority, hits: d.hits || [],
      dir: d.dir || '', file: d.file || '',
    });
    return {
      applied: (this._driversApplied || []).map(pick),
      effect: this._driverEffect ? {
        gpuMode: this._driverEffect.gpuMode,
        forceTcg: this._driverEffect.forceTcg,
        notes: this._driverEffect.notes || [],
        ini: this._driverEffect.ini || {},
        env: this._driverEffect.env || {},
        args: (this._driverEffect.args || []).map((a) => (a.value ? `${a.flag}=${a.value}` : a.flag)),
      } : null,
      errors: this._driverErrors || [],
      host: this._driverHost || null,
    };
  }

  /**
   * Aplica sobre la configuración por defecto las claves de config.ini que declaran los controladores.
   * Las claves que ya existen se reemplazan en su lugar (sin líneas duplicadas); las que no, se agregan al final.
   * Solo se procesan claves de la lista permitida de drivers.js; las inválidas ya se rechazan al validar.
   */
  _iniWithDrivers(text) {
    const over = (this._driverEffect && this._driverEffect.ini) || {};
    const keys = Object.keys(over);
    if (!keys.length) return text;
    const seen = new Set();
    const out = String(text).split('\n').map((line) => {
      const m = /^([A-Za-z0-9_.]+)=/.exec(line);
      if (!m || !(m[1] in over)) return line;
      seen.add(m[1]);
      return `${m[1]}=${over[m[1]]}`;
    });
    for (const k of keys) if (!seen.has(k)) out.push(`${k}=${over[k]}`);
    return out.join('\n');
  }

  /**
   * Lee la carpeta de controladores, elige los que coinciden con este equipo y guarda el efecto para este arranque.
   *
   * El orden de carpetas es la prioridad: primero los ejemplos integrados (solo lectura, enabled:false por defecto), luego los del usuario;
   * con el mismo id la carpeta del usuario sobrescribe al integrado: si el usuario edita un ejemplo se aplica directamente, sin tocar la carpeta de instalación.
   *
   * @returns {{ applied:Array, skipped:Array, errors:Array } | null}
   */
  _resolveDrivers({ accel, emulatorVersion }) {
    const s = this.settings || {};
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let gpuName = '';
    let osBuild = 0;
    try {
      const release = require('os').release() || '';
      const m = /(\d+)\s*$/.exec(release);
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* Si no se obtiene se toma como 0; los controladores con osBuild en sus condiciones no se aplicarán */ }
    const host = drivers.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (require('os').cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      gpuName,
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const loaded = drivers.loadAll([
      drivers.bundledDir(this.appRoot),
      drivers.userDir(store),
    ]);
    const r = drivers.resolve({ drivers: loaded.drivers, host, disabled, state });
    this._driverEffect = r.effect;
    this._driversApplied = r.applied;
    this._driverErrors = loaded.errors;
    this._driverHost = host;
    return { ...r, errors: loaded.errors, host };
  }

  /**
   * Prepara el AVD: escribe config.ini. Se reescribe en cada arranque con la configuración automática actual, para que los reintentos degradados se apliquen al instante.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Resolución: con aceleración por hardware 720x1280@320 se ve nítido y sin texto borroso;
    // con emulación solo por software baja a 540x960, priorizando los fotogramas (es solo el 56 % del área; a simple vista la diferencia es mucho menor que la de fluidez).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (compatible con ARM)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // Se compara la «identidad de la imagen» y no la ruta absoluta: la misma imagen en otro disco/carpeta no cuenta como otra imagen;
      // si no, al cambiar la carpeta del runtime se borrarían todas las apps instaladas (ver el comentario de doctor.imageIdentity).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // El userdata antiguo no es compatible con la imagen nueva (bucle de arranque de APEX); hay que recrearlo
        this.wipePending = true;
      }
    }

    // Cambió la huella de configuración → la instantánea quickboot anterior fallará al cargar o dará pantalla negra; se invalida.
    // Ojo: aquí solo se invalida la **instantánea**; nunca se hace -wipe-data de paso: los datos del usuario son las apps instaladas y sus partidas.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* Primera vez */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // El sistema/un programa de seguridad puede bloquear el borrado (la carpeta de instantáneas suele pesar varios GB).
      // Si falla, se renombra para que emulator no la cargue; nunca se interrumpe el arranque por un fallo de limpieza.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // Solo si «cambió la imagen» (cambia tag / sysdir) hace falta -wipe-data: el APEX del userdata anterior
    // no es compatible con la imagen nueva y sin recrearlo se queda en un bucle de arranque. Cambiar capacidad / resolución / motor de renderizado no cuenta.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch debe ser la propia ABI (x86_64 no se puede recortar a x86)
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=LanzadorAPK',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // La versión anterior fijaba 16 GB, creando archivos enormes en discos pequeños/con cuota y ralentizando el primer arranque
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      // El Wi-Fi virtual debe activarse explícitamente. En la imagen Play Store de API 34 la red va por
      // wlan0 (tarjeta virtual netsim), no por el eth0 de antes. Si falta esta línea en config.ini,
      // el emulador no crea el enlace de wlan0: wlan0 queda siempre en NO-CARRIER,
      // `dumpsys connectivity` muestra Active default network: none, y dentro de las apps aparece
      // siempre «Error de red, inténtalo más tarde». -netdelay/-netspeed/-dns-server de la línea de comandos
      // son solo parámetros del NAT en modo usuario de QEMU y no tienen que ver con que la tarjeta del invitado se active.
      'hw.wifi=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // La instantánea se controla totalmente con -snapshot lanzadorapk en la línea de comandos: nombre propio, para no cargar nunca por error
      // el default_boot heredado (estado de memoria de la imagen API30; cargarlo siempre entra en bucle de arranque).
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // Los sensores de orientación/aceleración deben estar apagados: si se activan, Android gira según el sensor y pone
      // el contenido vertical en horizontal (imagen acostada 90°, texto de lado, bordes negros). El cambio de diseño ahora solo usa
      // wm density (cambia smallestWidth); no hace falta ni se permite que intervenga el sensor.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, this._iniWithDrivers(cfg));

    // /La partición data tiene que «funcionar de verdad» primero; si no, todo lo demás es esperar en vano (ver el comentario de ensureDataPartition)
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Garantiza que la partición userdata sea un ext4 **realmente utilizable**: es la base de «abrir una app y llegar al escritorio en 30 s».
   *
   * Por qué hay que hacerlo nosotros (las tres razones salieron de pruebas reales):
   *  1. El userdata.img del paquete de imagen es un marcador de 1 MB de ceros; el formateo real lo hace avdmanager con el
   *     mke2fs del SDK. LanzadorAPK escribe config.ini y lanza emulator directamente, saltándose ese paso → /data todo en ceros →
   *     el kernel da "Invalid ext4 superblock on /dev/block/vdc" → el invitado cae en un bucle de reinicio de recovery →
   *     adbd nunca se conecta → el probe superior queda en pending y agota los 240 s. Síntoma original: varios minutos para abrir.
   *  2. e2fsck/resize2fs que trae emulator son e2fsprogs 1.42.12 versión cygwin, **no reconocen la característica
   *     encrypt**; con ese bit salen con exit 8 sin hacer nada, así que «ampliar el sistema de archivos» debe ir antes de poner el bit.
   *  3. El sistema de archivos debe ser ≥ el tamaño de la partición: con solo 64 MB, descomprimir APEX + dexopt lo llena de inmediato,
   *     después todo setxattr devuelve ENOSPC → no se escriben las etiquetas SELinux → netd/media/tombstoned
   *     salen con exit 1 → el arranque se queda en la animación y adb siempre offline.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* No existe */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // Solo si el archivo es lo bastante grande + el sistema de archivos realmente llegó a ese tamaño cuenta como «no hace falta tocarlo».
      // Mirar solo el tamaño del archivo deja pasar un fallo real: qemu-img agrandó el archivo pero resize2fs falló,
      // y queda un archivo de 6 GB con un Android de 64 MB: el usuario ve «al instalar un juego dice que no hay espacio».
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // Aumentó la capacidad configurada (o el sistema de archivos no creció): se amplía en el sitio, sin recrear, conservando las apps instaladas
      try {
        userdata.clearEncryptFlag(img);
        // Disperso antes de agrandar: si no, NTFS reserva todo el tamaño nuevo aunque sean ceros
        if (size < wantBytes) sparse.flag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`Ampliación de userdata: archivo ${size} → ${wantBytes}, sistema de archivos ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`No se pudo ampliar userdata (se sigue usando la partición actual): ${e.message}`);
        // La partición anterior sigue sirviendo, pero hay que decirle claramente a quien llama que «esta vez no se amplió»; la configuración no puede mostrar éxito
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // Primera vez / marcador de ceros heredado / imagen dañada: se crea uno nuevo
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Primero sin el bit encrypt (solo así trabajan e2fsck/resize2fs antiguos)
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      // Disperso antes de agrandar a 4–16 GB: así la partición solo ocupa en disco lo que Android escribe de verdad
      const sp = sparse.flag(img);
      if (sp && sp.ok === false && !sp.skipped) this.log(`No se pudo marcar userdata como disperso: ${sp.error || '?'}`);
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`userdata recreada: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (bloques de 4K, compatible con FBE)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Lo posible: aunque falle la ampliación, se vuelve a poner el bit encrypt para que FBE pueda inicializarse (la partición quedará más pequeña)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`No se pudo recrear userdata: ${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /**
   * Recupera espacio en disco antes de arrancar (el emulador todavía no tiene los archivos abiertos):
   *  1. borra las instantáneas viejas renombradas (snapshots.stale-*): quedan cuando no se pudo borrar una instantánea
   *     invalidada y cada una pesa lo mismo que la memoria de Android (2–8 GB); antes nadie las borraba solo;
   *  2. en Windows, convierte la partición de datos en archivo disperso y devuelve al disco los bloques en cero
   *     (la imagen de 4–16 GB ocupaba todo su tamaño aunque Android solo usara una parte). Tiene tope de tiempo
   *     y continúa en el siguiente arranque si no terminó; el contenido de la imagen no cambia.
   */
  async reclaimDiskSpace(avdDir, onLog = () => {}) {
    let names = [];
    try { names = fs.readdirSync(avdDir); } catch (_) { return; }
    for (const n of names) {
      if (!/^snapshots\.stale-\d+$/i.test(n)) continue;
      try {
        fs.rmSync(path.join(avdDir, n), { recursive: true, force: true });
        this.log(`Se borró una instantánea vieja: ${n}`);
      } catch (_) { /* en uso: se intenta en el próximo arranque */ }
    }
    if (process.platform !== 'win32') return;
    const img = path.join(avdDir, 'userdata-qemu.img');
    const markerFile = path.join(avdDir, 'userdata.sparse.json');
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch (_) { marker = null; }
    const p = sparse.plan(img, marker);
    if (!p.run) return;
    onLog('Liberando el espacio que no usan los datos de Android (solo la primera vez puede tardar hasta un minuto)…');
    const r = await sparse.compact(img, { start: p.start, maxSeconds: 60 });
    let st = null;
    try { st = fs.statSync(img); } catch (_) { /* ignore */ }
    if (r && r.ok && st) {
      try {
        fs.writeFileSync(markerFile, JSON.stringify({
          size: st.size, mtimeMs: st.mtimeMs, done: !!r.done, next: r.next || 0, at: Date.now(),
        }));
      } catch (_) { /* ignore */ }
      const freedMB = Math.max(0, Math.round(((r.before || 0) - (r.after || 0)) / 1048576));
      this.log(`userdata disperso: ${Math.round((r.before || 0) / 1048576)} MB → ${Math.round((r.after || 0) / 1048576)} MB en disco${r.done ? '' : ' (continúa en el próximo arranque)'}`);
      if (freedMB > 100) onLog(`Se liberaron ${(freedMB / 1024).toFixed(1)} GB de disco`);
    } else if (r && !r.skipped) {
      this.log(`No se pudo compactar userdata: ${(r && r.error) || '?'}`);
    }
  }

  /** emulator trae qemu-img.exe: agranda el archivo de imagen raw al tamaño objetivo (disperso, instantáneo)
   *  Ojo con el orden de parámetros: `qemu-img <comando> -f raw <archivo> <tamaño>`.
   *  Si -f va antes del comando se toma como parámetro global y da unrecognized option. */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} falló: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator trae resize2fs.exe (versión cygwin; hay que ejecutarlo dentro de bin64 para que encuentre las DLL) */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('Falta resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs falló: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator usa estas variables de entorno para ubicar el SDK / AVD; las rutas con acentos se convierten a rutas cortas 8.3 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // La carpeta del AVD debe coincidir con provisioner.paths().avdHome: con el runtime incluido de solo lectura (junto al EXE en
    // resources/runtime) root/avd no existe ni se puede escribir, y el AVD debe ir a la carpeta de datos del usuario.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      // Variables de entorno declaradas por controladores: solo se permiten los prefijos ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ (ver drivers.js)
      ...((this._driverEffect && this._driverEffect.env) || {}),
    };
  }

  /**
   * Idioma del sistema que se inyecta. Por defecto español latinoamericano (es-419); el usuario puede cambiarlo en Configuración (engine.locale);
   * con 'en-US' u 'off' vuelve al inglés original de la imagen.
   */
  _guestLocale() {
    const v = String(this.settings?.engine?.locale || 'es-419').trim();
    if (!v || v === 'off' || /^false$/i.test(v)) return '';
    return v;
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    // Los controladores pueden fijar el motor de renderizado / forzar emulación por software. Va primero y cuenta para gpu/accel,
    // así toda la lógica posterior (-accel off, hw.gpu.mode de config.ini) lo sigue.
    const eff = this._driverEffect || null;
    const drvGpu = eff ? drivers.gpuModeToArg(eff.gpuMode) : '';
    if (drvGpu) gpu = drvGpu;
    if (eff && eff.forceTcg) accel = 'off';
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Audio: activado por defecto (para que suenen los avisos y el audio de video de las apps Android).      // Solo si el usuario lo desactiva explícitamente en Configuración se pasa -no-audio para ahorrar algo de CPU.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Desactiva los informes de fallos: si hay informes anteriores, emulator muestra un diálogo modal de «aceptar envío»,
      // el hilo principal se bloquea y nunca arranca (en el registro aparece Showing crashdialog to get consent).
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      // AMD + emulator 37.x: la inicialización de Vulkan del backend host falla, y el proceso, tras unos segundos,
      // sale con exit 1; se registra como «host no disponible» y se vuelve para siempre a swangle (renderizado por software),
      // con video y desplazamiento perdiendo fotogramas. Desactivando Vulkan va por GL y aprovecha de verdad la aceleración por hardware.
      // El backend por software no usa Vulkan; agregarlo solo añade incertidumbre, así que solo se aplica a host.
      ...(gpu === 'host' && process.platform === 'win32' && doctor.detectGpuVendor() === 'amd'
        ? ['-feature', '-Vulkan'] : []),
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // Red: el emulador AOSP usa por defecto el NAT en modo usuario de QEMU (-netdev user); Android recibe
    // una dirección virtual 10.0.2.x y sale reutilizando el NAT de la tarjeta de red física del equipo.
    // Este modo **no** crea ninguna tarjeta de red / conmutador virtual en Windows
    // (eso solo pasa con -netdev tap o con puente, que nunca usamos).
    // Así, las apps Android son «un dispositivo detrás del NAT del equipo»; la pila de red del equipo no se toca,
    // no hay que instalar controladores ni aparece otro adaptador de red.
    // Se declara explícitamente sin límite de velocidad: aunque el valor por defecto es full, algunas combinaciones de -gpu / -net arrastran
    // la configuración conservadora del emulador, y las apps de video tardan visiblemente más en mostrar la primera pantalla.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // Idioma del sistema: por defecto español latinoamericano (es-419).
    // Probado: `-prop persist.sys.locale=...` no tiene ningún efecto: el emulador intercepta propiedades protegidas
    // como persist.sys.*, y ro.product.locale lo sobrescribe el build.prop de la imagen; con getprop
    // no se ve ninguna en el invitado. El parámetro oficial es -change-locale: cambia de verdad el idioma del sistema y reinicia el framework,
    // y se guarda en /data, así que se conserva al restaurar desde una instantánea.
    // El usuario puede cambiarlo en Configuración a otro idioma o desactivarlo (engine.locale='off').
    const locale = this._guestLocale();
    if (locale) args.push('-change-locale', locale);
    // DNS: por defecto Android usa 10.0.2.3 (reenvía al DNS del equipo). Con VPN / red corporativa / algunos proveedores
    // una resolución puede tardar cientos de milisegundos: «la página da vueltas un buen rato antes de cargar». Opcionalmente se ponen
    // los DNS públicos de Cloudflare y Google como preferidos; si fallan el sistema vuelve al otro. Desactivado por defecto (dominios internos).
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '1.1.1.1,8.8.8.8');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // Ojo: **ya no se puede pasar -no-skin**. Anula el -skin de arriba y el tamaño de la pantalla vuelve
      // al valor viejo de config.ini: el síntoma es «en Configuración cambié a horizontal y sigue vertical»,
      // y «la imagen solo ocupa una franja arriba a la izquierda». El tamaño de la pantalla lo debe decidir -skin.
      // El marco del dispositivo ya no se dibuja (ShowDeviceFrame=no + el grupo de parámetros de estilo de abajo).
      // Ojo: no se puede usar -qt-hide-window. Hace que el emulador **no cree** la ventana Qt,
      // y el agente de ventanas usa justo SetParent para incrustar esa ventana en la ventana de la app y mostrar la imagen;
      // con ese parámetro probe nunca encuentra la ventana y el usuario ve una ventana de app totalmente negra.
      // El ocultamiento de la ventana lo hace la supresión persistente del agente de ventanas (ver QuietSweep en win/agent.ps1).
    }
    // Solo se pasa -snapshot si la instantánea existe de verdad: con un AVD nuevo (o una instantánea recién invalidada),
    // qemu esperaría un estado de memoria que no existe: el proceso vive pero nunca arranca;
    // la capa superior solo ve «tiempo de arranque agotado», reintenta con otros parámetros y termina bloqueada por el AVD con
    // "Running multiple emulators with the same AVD".
    // Los parámetros de instantánea deciden si «el próximo arranque tarda 8 s o 90 s»; este es el segundo punto crítico:
    // la implementación anterior pasaba «-no-snapshot si no hay instantánea», pero -no-snapshot también desactiva **el guardado al salir**,
    // así que tras el primer arranque en frío nunca se generaba una instantánea y cada vez que el usuario abría era un arranque completo.
    // Lo correcto es -no-snapshot-load: esta vez no se carga (para no esperar una instantánea inexistente),
    // pero al salir el estado de memoria se guarda igual como lanzadorapk y la próxima vez se restaura directamente.
    // La instantánea ocupa un ram.bin de unos 2–3 GB (los usuarios con poco disco pueden desactivarla; solo afecta la velocidad de arranque)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // Al restablecer datos no se puede cargar la instantánea vieja (los datos ya no coinciden), pero **sí hay que permitir guardar una nueva**:
      // reparar la red depende de la cadena «primer arranque tras restablecer con red → guardar instantánea al momento → restaurar la próxima vez»;
      // la forma anterior pasaba -no-snapshot aquí, desactivando también el guardado, y la instantánea nunca se guardaba.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // La autocorrección de red pide este arranque en frío: la instantánea pudo guardarse «sin red» y al restaurarla seguiría sin red.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    // Otros parámetros declarados por controladores: -gpu / -accel ya los maneja arriba gpu/accel; aquí se omiten,
    // para que el mismo parámetro no aparezca dos veces (el comportamiento de emulator con parámetros repetidos varía entre versiones).
    for (const a of ((eff && eff.args) || [])) {
      if (a.flag === '-gpu' || a.flag === '-accel') continue;
      if (a.value === '') args.push(a.flag);
      else args.push(a.flag, a.value);
    }
    return args;
  }

  /** Lanza un solo proceso (sin esperar el arranque; la espera está en el bucle probe de start()) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: el emulador queda independiente del grupo de procesos de LanzadorAPK.
      // Al salir, Electron cierra el objeto job que creó y de paso mata los procesos hijos:
      // el síntoma era «cerrar LanzadorAPK y volver a abrirlo obliga a otro arranque en frío de más de 20 s». Independiente, el emulador sigue vivo
      // y el próximo inicio lo toma directamente (ver Runtime.adoptExisting): abre al instante.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? ` (${meaning})` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? ` (${meaning})` : ''}\n`);
      this.proc = null;
      onLog(`El runtime se cerró (code=${code}${meaning ? `, ${meaning}` : ''})`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu es un proceso independiente (detached); se espera a que arranque de verdad y luego se baja su prioridad.
    // Si no se baja, los 2–4 hilos vCPU compiten por la CPU con el escritorio de Windows con prioridad Normal,
    // y lo que nota el usuario es «al abrir LanzadorAPK el ratón flota y todo el equipo se traba».
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Escribe el registro del emulador con rotación por tamaño, para no llenar el disco con el uso prolongado */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Estado real de la imagen /data actual (para la configuración; se puede obtener sin arrancar Android) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* Aún no se creó */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* Aún no se creó o está dañado */ }
    const configuredGB = Number(this.settings?.engine?.dataPartitionGB || 0);
    const fsGB = fsBytesNow ? Number((fsBytesNow / 1073741824).toFixed(1)) : 0;
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      // Tamaño real del sistema de archivos (≠ tamaño del archivo de imagen): si se amplió la imagen pero resize2fs no terminó, estos dos números difieren
      fsGB,
      configuredGB,
      // El usuario fijó un objetivo pero el sistema de archivos todavía no llegó
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // quickboot crea una capa qcow2 sobre userdata; el invitado ve esa capa, no la imagen base
      overlay: this._hasDataOverlay(img),
    };
  }

  /** Si userdata está tomada por la capa qcow2 de quickboot (en ese caso solo se puede restablecer, no ampliar en el sitio) */
  _hasDataOverlay(img) {
    try { return fs.existsSync(`${img}.qcow2`); } catch (_) { return false; }
  }

  /**
   * Amplía de inmediato la partición /data al tamaño indicado (el emulador debe estar detenido; si no, la imagen está en uso).
   *
   * Dos caminos; la decisión salió de pruebas reales:
   *  - sin capa quickboot: se amplía en el sitio (qemu-img resize + resize2fs), sin perder las apps instaladas;
   *  - con capa: lo que monta de verdad el invitado es `userdata-qemu.img.qcow2`; aunque la base se amplíe a 8 GB
   *    y el sistema de archivos también, `df /data` en el invitado sigue en 5,7 GB (la capa conserva el tamaño anterior),
   *    y el sistema de archivos dentro de la capa no se puede cambiar sin root. En ese caso hay que devolver con honestidad «hay que restablecer»,
   *    no éxito como antes: el usuario creería que se amplió y el juego de 50 GB seguiría fallando a mitad.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    const wantGB = Math.max(1, Math.round(Number(dataMB || 0) / 1024));
    if (this._hasDataOverlay(img)) {
      return {
        ok: false,
        needsReset: true,
        fsGB: this.dataInfo().fsGB,
        error: `Android usa el disco diferencial de arranque rápido y la ampliación en el sitio no lo alcanza (objetivo ${wantGB} GB). `
          + 'Hay que «Restablecer datos de Android» para recrear /data con la nueva capacidad; se borrarán las apps instaladas y las partidas guardadas, confírmalo primero.',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // ensureDataPartition devuelve ok:false si falla resize2fs; se verifica otra vez el tamaño del sistema de archivos,
    // para que «el archivo creció pero el sistema de archivos no» no cuente como éxito (el usuario vería «no hay espacio» al instalar un juego).
    let fsAfter = 0;
    try { fsAfter = userdata.fsBytes(img); } catch (_) { /* ignore */ }
    const wantBytes = Math.max(1024, Math.round(Number(dataMB || 0))) * 1048576;
    if (r && r.ok && fsAfter < wantBytes * 0.95) {
      return {
        ok: false,
        ...r,
        fsGB: Number((fsAfter / 1073741824).toFixed(1)),
        error: `La imagen se amplió a ${wantGB} GB, pero el sistema de archivos solo llega a ${(fsAfter / 1073741824).toFixed(1)} GB (resize2fs no lo logró). `
          + 'Puedes pulsar «Ampliar ahora» otra vez, o liberar espacio en disco e intentarlo de nuevo.',
      };
    }
    return r;
  }

  /**
   * Ajusta la prioridad de los procesos qemu/emulator de este equipo (solo los que llevan el nombre de este AVD en la línea de comandos).
   * level: idle (contenedor en reposo) | below (hay una app en primer plano) | normal (prioridad al rendimiento).
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Mata a la fuerza el intento actual (incluido el árbol de procesos de qemu) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // El identificador proc a menudo ya no existe (emulator.exe sale tras lanzar, y qemu es un proceso independiente);
    // si no se limpia por nombre de proceso, la siguiente ronda se topa con el bloqueo del AVD y da FATAL.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Reconstruye el servidor adb en nuestro puerto exclusivo.
   *
   * Este era el principal culpable de «abrir una app tarda dos minutos»; la implementación anterior solo hacía kill-server y volvía:
   * al arrancar, emulator se conecta al demonio adb en ANDROID_ADB_SERVER_PORT,
   * y si no puede, **nunca registra este dispositivo**: en adb devices no aparece emulator-5554,
   * o se queda siempre offline (en el registro: "Unable to connect to adb daemon on port: 5044").
   * Entonces el probe superior nunca obtiene sys.boot_completed, espera 3 minutos hasta agotarse y reintenta,
   * cada reintento es un arranque en frío completo, y la instantánea tampoco se guarda porque «el dispositivo no está en línea»: un bucle sin salida.
   *
   * Por eso hay que hacer primero kill (limpia los registros de dispositivos viejos) y luego start, y esperar a que el puerto escuche de verdad antes de volver.
   */
  /** Para que la capa superior reinicie el servidor una vez cuando la transferencia adb se atasca (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* Se usa el del PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // En algunos equipos adb start-server vuelve muy rápido, pero el puerto aún no escucha de verdad;
    // aquí se espera hasta poder conectar (máximo ~3 s; normalmente decenas de ms).
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Espera por el caso de «sale justo después del spawn».
   * Con parámetros erróneos/DLL faltantes emulator suele salir en menos de 1 s; si el proceso sigue vivo se vuelve de inmediato,
   * sin esperar 2,5 s fijos: al restaurar desde instantánea, ese tiempo alcanza para la mitad del arranque.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Hace que «el próximo arranque» sea en frío (sin cargar la instantánea de arranque rápido).
   *
   * La instantánea guarda también el estado de la tarjeta de red: si se guardó «sin red», cada restauración
   * seguirá sin red. En la autocorrección de red, un arranque en frío evita esa instantánea defectuosa.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Hace que «el próximo arranque» lleve -wipe-data (solo lo usa «Reparar red» cuando fallaron varios intentos).
   * «Borrar el archivo de imagen userdata» no equivale al `-wipe-data` de emulator; hay que usar este último.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Comprueba si la máquina virtual tiene internet de verdad.
   *
   * Por qué este paso: la configuración Wi-Fi de la máquina virtual Android está en /data; si se daña (lo típico es que
   * en `cmd wifi list-networks` el mismo AndroidWifi aparezca dos veces con ids de red en conflicto),
   * wlan0 queda siempre en NO-CARRIER y no obtiene IP. Entonces «las páginas que necesitan internet» en la app quedan
   * en negro: así se producía «pantalla negra tras aceptar en la app», sin ninguna relación con la GPU/el renderizado.
   *
   * @param {string} [adbPath] ejecutable adb explícito (Runtime tiene una resolución más fiable)
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    // Igual que repairWifi: protege contra el error de llamada de «pasar una función como ruta»
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() solo busca el «archivo de versión», que en muchas instalaciones está vacío;
      // buscar el platform-tools incluido en la raíz del runtime es más fiable.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Las múltiples tablas de rutas de Android hacen que la tabla principal de `ip route` parezca vacía (la ruta por defecto está en la tabla de cada interfaz),
    // y el uid de shell no está en el grupo network de las apps, así que `ping` suele decir por error "Network is unreachable",
    // aunque el Wi-Fi esté conectado y las apps naveguen bien. Por eso aquí solo cuenta «si se obtuvo una dirección IPv4»,
    // confirmada con el estado de conexión de `cmd wifi status`, sin usar ping.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // La asociación Wi-Fi + DHCP suele terminar decenas de segundos después de sys.boot_completed.
      // Si quien llama da waitMs se sigue esperando; no se concluye «sin red» en este instante.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    // Tener IP no significa tener internet. En pruebas, con 10.0.2.16 pero DNS/rutas cortadas, la portada de la app seguía
    // con «error de red» y la capa superior creía que la red estaba bien. Aquí se hace además una prueba HTTP real.
    // Se usa nc directo al puerto 80 y no ping: el NAT en modo usuario de QEMU bloquea ICMP y ping siempre daría un falso error.
    // Solo en la ruta de «esperar a que la red esté lista» (waitMs>0); el sondeo rápido lo omite; si no, cada 3 s
    // se gastarían 4 s en la prueba y se retrasaría el arranque. El resultado va en reachable, sin cambiar ok: con IP primero
    // se deja arrancar la app; una inestabilidad puntual del DNS no debe bloquear todo el arranque.
    let reachable = null;
    if (waitMs > 0) {
      const probe = await sh(
        "echo -e 'GET /generate_204 HTTP/1.0\\r\\nHost: connectivitycheck.gstatic.com\\r\\n\\r\\n' "
        + "| nc -w 4 connectivitycheck.gstatic.com 80 2>/dev/null | head -1",
        7000,
      );
      reachable = /HTTP\/1\.[01]\s+204/.test(probe);
    }
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected, reachable };
  }

  /**
   * Conecta activamente el AndroidWifi que está «guardado pero no se conecta solo».
   *
   * Esto salió de equipos reales: el punto de acceso virtual AndroidWifi del emulador puede quedar en la configuración como
   * dos registros (open + owe), y el sistema lo marca como
   *   «Saved / Won't automatically connect»
   * así que tras arrancar wlan0 queda siempre en NO-CARRIER y las apps muestran errores de red.
   *
   * El problema es que shell (uid 2000) no tiene el permiso NETWORK_SETTINGS,
   * y `cmd wifi connect-network` lanza SecurityException; no se puede hacer por línea de comandos.
   * En cambio se abre la página de ajustes Wi-Fi y se pulsa esa red guardada, con el mismo efecto que si lo hiciera el usuario.
   *
   * @returns {Promise<boolean>} si ya está conectado
   */
  async repairWifi(adbPath = '') {
    const fs = require('fs');
    const path = require('path');
    // Defensa: quien llama podría pasar por error la función misma (rt.adbPath es un método).
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 10000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Tras conectar, de paso se fija la dirección de prueba de «comprobación de conexión».
    // Android decide si «de verdad hay internet» consultando un endpoint de verificación; si no lo alcanza,
    // marca la red con «!» (conectado sin acceso a internet) y algunas apps
    // se consideran sin conexión y no cargan contenido. Se fija el endpoint estándar de Google que responde 204.
    const tune = async () => {
      await sh('settings put global captive_portal_http_url http://connectivitycheck.gstatic.com/generate_204');
      await sh('settings put global captive_portal_https_url https://www.google.com/generate_204');
      await sh('settings put global captive_portal_mode 0');
    };
    // Si ya está conectado no hay que hacer nada
    if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
      await tune();
      return true;
    }
    // Si el interruptor está apagado (el usuario lo apagó sin querer / un -svc wifi disable anterior) primero se enciende
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 1500));

    // Abre la página de ajustes Wi-Fi, busca con uiautomator la fila de AndroidWifi y la pulsa.
    // Es más estable que pulsar por coordenadas: con distintas resoluciones / idiomas las coordenadas cambian.
    await sh('am start -a android.settings.WIFI_SETTINGS');
    await new Promise((r) => setTimeout(r, 2500));
    await sh('uiautomator dump /sdcard/ui.xml');
    const xml = await new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', 'cat', '/sdcard/ui.xml'],
          { timeout: 10000, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 },
          (e, out) => resolve(e ? '' : String(out || '')));
      } catch (_) { resolve(''); }
    });
    // El nodo tiene la forma <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
    const re = /<node[^>]*\btext="([^"]*)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m = re.exec(xml);
    while (m) {
      const label = m[1];
      if (/AndroidWifi/i.test(label)) {
        const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
        const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
        await sh(`input tap ${cx} ${cy}`);
        await new Promise((r) => setTimeout(r, 6000));
        if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
          await tune();
          return true;
        }
      }
      m = re.exec(xml);
    }
    // Respaldo: intenta reconectar directamente una vez (en algunas versiones el dump no trae text, solo content-desc)
    await sh('svc wifi disable');
    await new Promise((r) => setTimeout(r, 1500));
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 6000));
    const ok = /Wifi is connected/i.test(await sh('cmd wifi status'));
    if (ok) await tune();
    return ok;
  }

  /**
   * Arranque + reintentos automáticos.
   * @param {Function} probe callback asíncrono que devuelve 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      // Clave: emulator.exe solo es un lanzador y sale tras lanzar qemu, pero este objeto proc
      // sigue existiendo (killed sigue en false). Mirar solo eso trataría una «máquina ya apagada» como
      // viva; justo después de reiniciar para cambiar la pantalla, ensure() cayó en esto: start() devolvía
      // reused, quien llamaba usaba en adb un serial ya muerto y daba `device not found`,
      // y el síntoma era «cambiar a una app con otra orientación falla directamente».
      // Por eso hay que confirmar además que hay una máquina corriendo en el puerto de la consola antes de reutilizarla.
      if (await this._consoleAlive()) {
        return { ok: true, reused: true, serial: this.serial, port: this.port };
      }
      onLog('El emulador anterior ya se cerró; arrancando de nuevo…');
      this.proc = null;
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('El motor del runtime no está instalado; complétalo primero en la página «Runtime»');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('La imagen del sistema no está lista; descarga primero la imagen de Android en la página «Runtime»');
    }

    const s = this.settings;
    // Antes de arrancar se revisa el disco: el emulador escribe el AVD (partición de datos + instantánea, varios GB),
    // así que solo el espacio libre de su disco decide si puede arrancar; la carpeta del runtime solo escribe registros y necesita mucho menos.
    // Antes se tomaba el mínimo de ambos, y «la carpeta de datos ya está en D y en C solo quedan 400 MB»
    // se tomaba por falta de disco; mover de disco no servía de nada.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Espacio en disco insuficiente: el disco de la carpeta de datos de Android (${avdHome}) solo tiene ${(avdFreeMB / 1024).toFixed(1)} GB libres; `
        + `el runtime necesita al menos ${(needMB / 1024).toFixed(1)} GB. En «Configuración → Integración con el sistema → Carpeta de datos de Android» `
        + 'muévela a un disco con espacio suficiente (por ejemplo D:), o libera espacio. Tus apps y partidas guardadas no se borran automáticamente.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `La carpeta del runtime (${loc.root}) solo tiene ${(diskMB / 1024).toFixed(1)} GB libres; `
        + 'no tiene espacio ni para registros y archivos temporales. Libera espacio o mueve también la «Carpeta de datos del runtime» a otro disco.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Todas las llamadas adb de este proceso usan el mismo puerto de servidor que emulator
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // Estas cuatro tareas no dependen entre sí y se hacen en paralelo: antes iban en serie «comprobar aceleración → versión → buscar puertos → limpiar servidor adb»,
    // y antes del arranque en frío se esperaban 3–5 s en vano, justo mientras el usuario mira la ventana de carga tras abrir la app.
    // El servidor adb de la ejecución anterior puede seguir con registros de dispositivos viejos (y dejar el nuevo emulador offline),
    // así que limpiar el servidor sigue haciéndose, solo que sin esperarlo por separado.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Controladores (parches de compatibilidad): primero se ve cómo es este equipo y luego si alguien le escribió un parche.
    // Este paso solo lee JSON y no ejecuta código; si nada coincide el efecto es vacío y el comportamiento es igual que antes.
    let drv = { applied: [], skipped: [], errors: [], effect: null };
    try {
      drv = this._resolveDrivers({ accel: accelInfo, emulatorVersion: emuVersion });
    } catch (e) {
      this.log(`Error al cargar controladores: ${e.message}`);
      onLog(`Error al cargar controladores (se ignora y se arranca con parámetros por defecto): ${e.message}`);
    }
    if (drv.applied.length) {
      onLog(`Controladores aplicados: ${drv.applied.map((d) => `${d.name} v${d.version}`).join(',')}`);
      for (const n of (this._driverEffect.notes || []).slice(0, 4)) onLog(`· ${n}`);
    } else {
      onLog('Ningún controlador coincide; se arranca con parámetros por defecto');
    }
    if (drv.errors && drv.errors.length) {
      onLog(`Hay ${drv.errors.length} archivos de controlador no se cargaron (en Configuración → Controladores verás el motivo)`);
    }

    // Mismo punto de entrada que la configuración / el informe de diagnóstico, para garantizar que «lo que se muestra» es «lo que corre»
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    let variants = doctor.planVariants(profile).slice(0, maxAttempts);
    // Si un controlador fija el motor de renderizado / pide emulación por software, se sigue en todas las rondas:
    // el usuario instala el controlador justo porque «este equipo solo funciona con esta opción»; volver a probar primero el motor que falló solo hace esperar.
    if (drv.applied.length && this._driverEffect) {
      const gpuFixed = drivers.gpuModeToArg(this._driverEffect.gpuMode);
      if (gpuFixed) {
        variants = variants.map((v) => ({ ...v, gpu: gpuFixed }));
        onLog(`El controlador fija el motor de renderizado en ${gpuFixed}`);
      }
      if (this._driverEffect.forceTcg) {
        variants = variants.map((v) => ({ ...v, accel: 'off', label: `${v.gpu} / el controlador pide emulación por software` }));
        onLog('El controlador pide desactivar la aceleración por hardware (emulación por software)');
      }
    }

    // Recuerda el motor de GPU que «falló al lanzarse la última vez» y la próxima lo pone al final.
    // Probado: en una AMD Radeon 780M `-gpu host` pasa la comprobación de hardware del propio emulator,
    // pero unos segundos después de arrancar la VM el proceso sale con exit 1 (en el registro solo "AEHD is operational"),
    // y cada vez había que esperar más de 20 s para pasar a swangle. La clave incluye la versión de emulator,
    // así que al actualizar el runtime se le da automáticamente otra oportunidad.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    // Con Vulkan desactivado host puede llegar a funcionar: se reintenta una vez por versión de emulator,
    // para que un registro viejo no deje al usuario para siempre en renderizado por software (una de las causas de «siempre va lento»).
    const vulkanRetried = String(this.settings.engine.badGpuVulkanTried || '');
    const retryHostWithoutVulkan = badGpu === 'host' && badVer === emuVersion && vulkanRetried !== emuVersion;
    if (retryHostWithoutVulkan) {
      store.saveSettings({ engine: { badGpu: '', badGpuVulkanTried: emuVersion } });
      onLog('El fallo anterior del renderizado host parece deberse a Vulkan; esta vez se reintenta la aceleración con -feature -Vulkan');
    } else if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`La última vez el motor de renderizado ${badGpu} falló al iniciar; esta vez se prueba primero ${variants[1].gpu}`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);
    this._logWrite(logFile, `drivers: ${drv.applied.length ? drv.applied.map((d) => `${d.id}@${d.version}`).join(', ') : '(none)'}\n`);

    // La especificación de pantalla se mantiene durante todo el arranque; si cada reintento cambiara la resolución se borrarían instantáneas sin parar.
    // La resolución sale del profile de doctor (se puede cambiar la «Calidad» en Configuración); en auto se elige según la aceleración.
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Antes del arranque en frío se limpian los huérfanos: si un qemu de la ejecución anterior sigue reteniendo el bloqueo del AVD,
    // todos los intentos darán FATAL de inmediato con "Running multiple emulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // Un puerto ocupado también causa fallos; se vuelve a detectar en cada reintento
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // El código de salida se reinicia en cada ronda: el 0xC0000005 de la ronda anterior no puede pasar al diagnóstico de la siguiente
      this.lastExitCode = null;
      // El registro también se separa por ronda: el registro en memoria se acumula entre rondas, y si la línea del fallo de la ronda 1 quedara al final,
      // la ronda 2 (por ejemplo, un conflicto de puerto tras cambiar de motor) se diagnosticaría como el mismo fallo.
      const logStart = this._log.length;
      onLog(`Iniciando el runtime (intento ${i + 1}/${variants.length}: ${plan.label})…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe también participa en «borrar la instantánea vieja»: tras restablecer datos la instantánea vieja siempre falla al cargar
        // (probado: da Failed to load snapshot y vuelve al arranque en frío); hay que borrarla antes de recrear.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      if (i === 0) {
        // eslint-disable-next-line no-await-in-loop
        await this.reclaimDiskSpace(avd.avdDir, onLog).catch(() => {});
      }
      // Punto de enganche: la capa superior (main) lo usa para activar la supresión de ventanas negras **antes** de lanzar el emulador.
      // La consola aparece decenas de milisegundos después del spawn; un escaneo posterior siempre la dejaría parpadear,
      // así que aquí hay que activarla primero y luego lanzar el proceso.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot solo aplica a este spawn, para que los arranques siguientes no se conviertan todos en arranques en frío largos
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Con parámetros erróneos / DLL faltantes sale de inmediato
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}: ${d.hint}`;
        // Un disco lleno no es un problema que «se arregle con otros parámetros»: seguir reintentando solo falla una y otra vez,
        // y en el pasado la última combinación llevaba wipe, que borraba los datos del usuario. Se termina y se informa el error tal cual.
        if (d.code === 'DISK_FULL') {
          onLog('Espacio en disco insuficiente; se detuvieron los reintentos (no se tocan tus apps ni partidas guardadas).');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Las conclusiones de aceleración/imagen pueden ser datos viejos de la caché; se invalidan y se vuelven a detectar en el próximo arranque
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}; reintentando automáticamente con otros parámetros…`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // Al restaurar desde una instantánea suele estar listo en pocos segundos; consultar cada 3 s fijos significa esperar en promedio 1,5 s más para «descubrir»
      // que ya está listo. Aquí se empieza con 200 ms y se va ampliando hasta 1,2 s: al principio del arranque se detecta al instante,
      // y en arranques largos no se gasta CPU en sondeos.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // Si adb ya puede ejecutar shell, el kernel está arrancando; la información normal de Vulkan/EGL en el registro no cuenta como fallo
        if (state === 'booting') sawBooting = true;
        // 45 s sin ninguna conexión y con un error fatal claro en el registro → cambiar de plan antes, sin esperar 4 minutos
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // Un mensaje de progreso cada 15 s: antes se usaba el «módulo», y con intervalos adaptativos salían dos o tres repetidos seguidos
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Arrancando… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // Esta vez arrancó de verdad: se borra el registro del fallo anterior para que el «diagnóstico» no saque problemas viejos
        this._clearFailure();
        // Siempre hay que guardar la instantánea quickboot: el proceso del emulador termina al salir de LanzadorAPK (el objeto job de
        // Electron mata los procesos hijos), y que haya o no instantánea decide si la próxima apertura tarda 25 s o 7 s.
        // Al instalar una app nueva, el instalador invalida la instantánea para evitar que «la app desaparezca tras reiniciar».
        this.snapshotWorthSaving = true;
        onLog(`Runtime listo (${Math.round(bootMs / 1000)} s, ${plan.label})`);
        // Arrancar bien no significa que funcione: de paso se revisa la red. Si la máquina virtual no tiene red, las páginas que la necesitan quedan en negro,
        // y el usuario solo dirá «esta app se ve en negro», sin pensar en la red. Aquí se comprueba activamente y se explica claramente.
        //
        // Pero no se puede «concluir con una sola comprobación»: la asociación Wi-Fi + DHCP suele llegar
        // 5–20 s después de sys.boot_completed; antes aquí solo se llamaba a checkNetwork() una vez, y **en cada arranque en frío** aparecía
        // «⚠ sin red, restablece los datos de Android», cuando a los 5 s la red estaba lista; quien seguía el consejo
        // perdía todas sus apps. Ahora hay una ventana de espera de 12 s (vuelve en cuanto está lista), solo avisa si de verdad se agota,
        // y ya no sugiere operaciones destructivas.
        let network = null;
        try {
          network = await this.checkNetwork('', { waitMs: 12000, interval: 3000 });
        } catch (_) { /* Un fallo de la comprobación no cuenta como fallo de arranque */ }
        if (network && !network.ok) {
          onLog('⚠ La máquina virtual Android todavía no tiene internet (Wi-Fi no asociado o sin dirección). '
            + 'Las apps que necesitan internet pueden quedarse en negro; vuelve a abrirlas en un momento; '
            + 'si sigue sin red, reconéctala en «Configuración → Reparar red» (no borra apps instaladas).');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}: ${d.hint}` : 'Tiempo de arranque agotado (puede que el primer arranque sea lento o que la aceleración por hardware no esté activa)';
      onLog(`${lastError}; reintentando automáticamente con otros parámetros…`);
      // Un diálogo de autorización atascado no es un problema del motor de renderizado; no hay que poner la GPU actual en la lista negra de «falla al arrancar»,
      // o el próximo arranque se saltaría sin motivo un motor que funciona en el equipo del usuario.
      if (d.code !== 'ADB_UNAUTHORIZED') this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `El runtime no arrancó tras varios intentos (${d.title}).\n${d.hint}\n\n`
      + `Intentos: ${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join(';')}\n`
      + `Informe de diagnóstico: ${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Guarda la instantánea quickboot (el próximo arranque restaura directamente el estado de memoria, como el arranque rápido de WSA y similares).
   *
   * El momento importa: la implementación anterior guardaba 6 s después de arrancar, justo cuando el usuario abría una app y competía por E/S de disco
   * (la instantánea escribe 1–3 GB), y se sentía más lento. Ahora se guarda «en reposo», y el Runtime lo dispara
   * al cerrarse la última ventana de app; si antes de apagar aún no se guardó, se guarda entonces.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // El comando save de emulator puede responder OK a mitad de la escritura; aquí se confirma otra vez por la integridad de los archivos,
    // y solo cuenta si snapshot.pb quedó realmente en disco (si no, la próxima carga fallaría y se esperarían unos segundos en vano).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Programa un «guardado de instantánea en reposo».
   * Se programa una sola vez; si al llegar el momento el contenedor sigue con una app en primer plano, se pospone hasta que esté realmente en reposo.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // Si no hay espacio suficiente para la instantánea (tamaño de memoria + 1 GB de margen) se omite: forzarlo solo llenaría el disco
        // y haría fallar el siguiente arranque. La instantánea solo afecta la velocidad de arranque; no guardarla no afecta los datos.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Se omite guardar la instantánea: quedan ${(freeMB / 1024).toFixed(1)} GB en disco < se necesitan ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Detención ordenada: en equipos lentos primero se guarda la instantánea quickboot, luego se apaga por la consola y al final se mata el árbol de procesos */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // Una instancia tomada no tiene identificador proc, pero hay una máquina corriendo en el puerto; no se puede devolver true y salir
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    // Antes de apagar se comprueba si el invitado está sano; solo en esta comprobación se pregunta a adb:
    //  - sano → se guarda otra instantánea (si la ruta de reposo no alcanzó, la próxima vez igual abre al instante);
    //  - no sano (adb atascado en unauthorized / arranque sin terminar) → no se guarda y **se invalida la instantánea tras salir**:
    //    `adb emu kill` hace que emulator guarde por su cuenta un estado de memoria quickboot, que también
    //    congelaría el estado sin autorizar. Si no se borra aquí, la próxima restauración sería otra instantánea defectuosa que «siempre agota el arranque».
    const healthy = adbPath ? await this._adbGuestHealthy(adbPath) : false;
    if (adbPath && this.snapshotWorthSaving !== false && healthy) {
      // Escribir 3 GB de memoria a disco tarda de unos segundos a más de veinte; se da tiempo de sobra para que la instantánea no se mate a medias.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (!healthy && this.snapshotWorthSaving !== false) {
      this.log('Al apagar, el sistema invitado no estaba autorizado/listo: se invalida la instantánea y el próximo arranque en frío volverá a inyectar la autorización de depuración');
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // Se espera a que complete por su cuenta el flujo «escribir a disco → salir». Antes se esperaban 6 s fijos y se mataba,
    // cortando justo la escritura de la instantánea y dejando un cascarón con ram.img pero sin snapshot.pb.
    //
    // Ojo: no se puede esperar a this.proc: emulator.exe solo es un lanzador y sale tras lanzar qemu;
    // tomar su salida como «apagado completo» llevaría de inmediato a la rama de matar a la fuerza. Aquí manda el puerto de la consola.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    // Si se apagó limpiamente se descarta el identificador del lanzador. Conservarlo haría que running() siempre devuelva true
    // y que start() crea que se puede reutilizar (ver el comentario en start()).
    this.proc = null;
    // El proceso ya salió; ahora se invalida la instantánea defectuosa que pudo guardar al salir. El orden importa: debe ir
    // después de emu kill + cierre del puerto; si no, volvería a escribir la instantánea recién borrada.
    if (!healthy && this.snapshotWorthSaving !== false) {
      try { this.invalidateSnapshot(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
   * Anota el motor de GPU que «falla al lanzarse» y lo pone al final en el próximo arranque.
   * Solo en modo auto: si el usuario eligió un motor explícitamente, se respeta y no se cambia a escondidas.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // El renderizado por software es el respaldo: ya es la opción más lenta/estable y no hay una peor a la que pasar
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** Si sigue habiendo una máquina en el puerto de consola de esta instancia (5554): para saber si «de verdad se apagó del todo» */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /**
   * Si el invitado está en estado sano para «guardar la instantánea sin riesgo»: adb authorized + arranque completo.
   * Si en el arranque en frío el diálogo «¿Permitir la depuración USB?» sigue abierto, state es unauthorized; si se guardara entonces
   * memoria + disco, el invitado no tendría la adbkey.pub del equipo, la próxima restauración seguiría en unauthorized,
   * cada shell de detección lanzaría una excepción, se esperarían 240 s en vano y se diagnosticaría mal como problema de GPU/virtualización.
   */
  async _adbGuestHealthy(adbPath) {
    if (!adbPath) return false;
    try {
      const { AdbClient } = require('./adb');
      const probe = new AdbClient({ adbPath, serial: this.serial });
      const state = await probe.deviceState();
      const out = await probe.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '');
      return state === 'device' && String(out).trim() === '1';
    } catch (_) {
      return false; // Si no se puede leer se trata como no sano
    }
  }

  /**
   * Dispara con adb un guardado de instantánea (si falla devuelve false y quien llama decide si reintenta).
   * Solo se guarda con el invitado sano; mejor un arranque en frío de más de 20 s la próxima vez que guardar una instantánea defectuosa que «siempre falla al arrancar».
   */
  async _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    if (!(await this._adbGuestHealthy(adbPath))) {
      this.log('Se omite guardar la instantánea: el sistema invitado no estaba autorizado o no terminó de arrancar (para no guardar una instantánea defectuosa)');
      return false;
    }
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Toma solo las líneas de registro de «este intento de arranque».
   * El registro en memoria se acumula entre rondas (el informe de diagnóstico debe ver todos los intentos), pero la conclusión del diagnóstico solo debe mirar esta ronda;
   * si no, el `emulator exit 3221225477` de la ronda 1 haría que cualquier fallo de la ronda 2 se diagnosticara como el mismo fallo.
   * Si esta ronda no tiene ninguna línea (el proceso ni siquiera arrancó) se usa el final general, para dar al menos una conclusión.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Lee las últimas n líneas del archivo emulator.log (cuando el búfer en memoria está vacío).
   * Si el usuario reinicia LanzadorAPK y luego exporta el informe de diagnóstico, this._log en memoria ya está vacío,
   * y por eso el informe anterior solo decía UNKNOWN, aunque la causa real del fallo estaba en el archivo de registro.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // Si no se lee desde el principio la primera línea puede estar cortada; se descarta
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
