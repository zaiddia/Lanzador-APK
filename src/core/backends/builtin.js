'use strict';
/**
 * Backend: el Google Android Emulator integrado (virtualización completa con QEMU)
 *
 * Es el backend por defecto de LanzadorAPK y el único «totalmente autosuficiente»:
 * adb / emulator / imagen del sistema los descarga y gestiona LanzadorAPK, sin depender de
 * qué emulador tenga instalado el usuario.
 *
 * La implementación real está en core/engine.js (Runtime) y core/emulator.js (EmulatorEngine);
 * este archivo es solo una adaptación delgada que traduce sus interfaces a las convenciones de esta capa, así la capa superior no necesita saber
 * lo complejo que es el backend propio por dentro.
 *
 * Atención: este backend depende de una instancia de Runtime, que se inyecta al construirlo con deps.runtime.
 */
const fs = require('fs');
const path = require('path');
const { Backend, CAPS } = require('./base');
const { freeDiskMB } = require('../doctor');
const { diskRequiredMB, diskVerdict, hostProfile, memoryLimits, memVerdict, diskLimits } = require('../resources');

class BuiltinBackend extends Backend {
  static get id() { return 'builtin'; }

  static get label() { return 'Runtime integrado (Android Emulator + QEMU)'; }

  static get summary() {
    return 'Sin dependencias de terceros: lanzadorapk descarga y gestiona la imagen de Android 14; las apps ARM usan la capa de traducción de la imagen. '
      + 'El primer arranque tarda unos 25 s; después, la instantánea quickboot lo hace casi instantáneo.';
  }

  static get embedCapable() { return true; }

  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    this.rt = deps.runtime || null;
  }

  get caps() {
    return new Set([
      CAPS.provision, CAPS.snapshot, CAPS.resizeData,
      CAPS.resetData, CAPS.rotatePanel, CAPS.priority, CAPS.shutdown,
    ]);
  }

  // serial es un campo escribible y no un getter: el constructor de la clase base hace `this.serial = ''`,
  // y si aquí se definiera un getter, la asignación lanzaría TypeError (un getter del prototipo no es escribible).
  // Cuando hace falta el valor actual, ensure() lo toma del Runtime y lo escribe.
  syncSerial() {
    if (this.rt) this.serial = this.rt.emuSerial || '';
    return this.serial;
  }

  running() { return !!(this.rt && this.rt.emuRunning); }

  async probe() {
    if (!this.rt) return { ok: false, found: false, detail: 'Runtime no inicializado' };
    const p = this.rt.provisioner.paths();
    const found = fs.existsSync(p.emulatorExe) || fs.existsSync(p.adbExe);
    return { ok: true, found, path: p.emulatorExe, detail: p.root };
  }

  async check() {
    if (!this.rt) return { ok: false, reason: 'Runtime no inicializado' };
    const env = await this.rt.provisioner.checkEnv().catch(() => null);
    if (!env) return { ok: false, reason: 'Error al detectar el runtime' };
    if (!env.adb.ok) return { ok: false, reason: 'Falta adb', needs: 'adb' };
    if (!env.emulator.ok) return { ok: false, reason: 'Falta Android Emulator', needs: 'emulator' };
    if (!env.sysimg.ok) return { ok: false, reason: 'Falta la imagen del sistema', needs: 'sysimg' };
    return { ok: true, env };
  }

  async resolveAdb() { return this.rt ? this.rt.adbPath() : ''; }

  async ensure({ onLog = () => {} } = {}) {
    if (!this.rt) return { ok: false, error: 'Runtime no inicializado' };
    const r = await this.rt.ensure({ onLog });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'El runtime de Android no pudo arrancar' };
    // serial es un campo escribible (ver la explicación de syncSerial); se sincroniza una vez tras un ensure exitoso
    this.syncSerial();
    this.adbPath = this.rt.adbPath();
    return {
      ok: true, serial: this.serial, adbPath: this.adbPath, reused: !!r.reused, client: r.client, engine: 'emulator',
    };
  }

  /**
   * La ventana del emulator integrado no da identificadores candidatos: la busca FindEmulator() de WinAgent por ámbito
   * de carpeta del proceso (ver core/win/agent.ps1), así no se confunde aunque cambie el título de la ventana.
   */
  async windowTargets() { return []; }

  /**
   * Si la ventana de imagen ya está incrustada en el anfitrión.
   * WinAgent inyecta isEmbedded (pregunta a agent.ps1 si el padre actual de _emu es el anfitrión);
   * sin inyección devuelve true por prudencia: el backend integrado siempre usa la ruta antigua y no necesita este control.
   */
  async windowReady({ isEmbedded } = {}) {
    if (typeof isEmbedded !== 'function') return { ok: true };
    return { ok: !!isEmbedded };
  }

  async stop({ graceful = true } = {}) {
    if (!this.rt) return { ok: false, error: 'Runtime no inicializado' };
    const ok = await this.rt.stop({ graceful }).catch((e) => ({ error: e.message }));
    return { ok: ok !== false };
  }

  async install(component, onProgress = () => {}) {
    if (!this.rt) return { ok: false, error: 'Runtime no inicializado' };
    const prov = this.rt.provisioner;
    switch (component) {
      case 'runtime': return prov.installRuntimePack(onProgress);
      case 'adb': return prov.installAdb(onProgress);
      case 'emulator': return prov.installEmulator(onProgress);
      case 'sysimg': return prov.installSystemImage(onProgress);
      case 'playimg': return prov.installPlayImage(onProgress);
      case 'aehd': return prov.installAehd(onProgress);
      case 'qemu': return prov.installQemu(onProgress);
      default: return { ok: false, error: `Componente desconocido ${component}` };
    }
  }

  usage() { return this.rt ? this.rt.usage() : { total: 0, items: [] }; }

  dataInfo() { return this.rt ? this.rt.emulator.dataInfo() : { ok: false }; }

  /**
   * Para mostrar en la configuración: límite del anfitrión + asignación actual.
   * La memoria/CPU del runtime integrado van en la línea de comandos de qemu y se aplican al próximo arranque de Android;
   * la partición de datos se puede ampliar en el sitio (resizeData) sin perder las apps instaladas.
   */
  resources() {
    const info = this.dataInfo() || {};
    const host = hostProfile();
    const eng = (this.rt && this.rt.settings && this.rt.settings.engine) || {};
    const freeMB = info.avdDir ? freeDiskMB(info.avdDir) : 0;
    const memMB = Number(eng.memoryMB) || 0;
    return {
      backend: 'builtin',
      host,
      limits: { ...memoryLimits(host.totalMB), ...diskLimits(freeMB) },
      wanted: { memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0, cores: Number(eng.cores) || 0 },
      current: {
        memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0,
        cores: Number(eng.cores) || 0,
        dataGB: Number(info.configuredGB) || 0,
        imageGB: Number(info.imageGB) || 0,
      },
      freeMB,
      pending: false,
      verdict: memVerdict(memMB, host.totalMB),
      note: 'La memoria/CPU del runtime integrado se aplican al próximo arranque de Android; tras aumentar la partición de datos pulsa «Ampliar ahora»:'
        + 'si se puede ampliar en el sitio se conservan las apps instaladas; si Android usa el disco diferencial de arranque rápido, te pedirá restablecer y recrear con la nueva capacidad.',
    };
  }

  /**
   * Comprobación previa para paquetes grandes: además del disco físico, hay que ver si alcanza la partición /data.
   * La causa más común de que no quepa un juego de 50 GB no es la descarga, sino que la imagen userdata sigue
   * con los 6/8 GB por defecto, y falla con INSTALL_INSUFFICIENT_STORAGE recién en la fase dexopt.
   */
  checkDiskFor(bytes) {
    const info = this.dataInfo() || {};
    const need = diskRequiredMB(bytes);
    const phys = diskVerdict(info.avdDir ? freeDiskMB(info.avdDir) : 0, need);
    if (!phys.ok) return phys;
    const capGB = Number(info.configuredGB) || 0;
    if (capGB && capGB * 1024 < need) {
      return {
        ok: false,
        message: `La partición de datos de Android es insuficiente: ahora ${capGB} GB, este juego recomienda al menos ${Math.ceil(need / 1024)} GB libres. `
          + 'En Configuración → Motor aumenta la «Capacidad de la partición de datos» y reinicia Android (se amplía en el sitio, sin perder apps instaladas).',
      };
    }
    return { ok: true, requiredMB: need };
  }

  async resizeData(mb) { return this.rt ? this.rt.emulator.resizeDataPartition(mb) : { ok: false }; }

  async resetData() { return this.rt ? this.rt.resetAndroidData() : { ok: false }; }

  dispose() {
    // Se delega a Runtime.dispose(): conserva el proceso qemu para tomarlo en el próximo arranque
  }

  diagnose() {
    const p = this.rt ? this.rt.provisioner.paths() : {};
    return {
      backend: 'builtin',
      serial: this.serial,
      root: p.root || '',
      emulator: p.emulatorExe || '',
      running: this.running(),
    };
  }
}

module.exports = { BuiltinBackend, BACKEND_ROOT: path.dirname(__dirname) };
