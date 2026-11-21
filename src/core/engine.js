'use strict';
/**
 * Motor del runtime: la máquina virtual QEMU + Android-x86 integrada en LanzadorAPK
 *
 * Principios de diseño:
 *  - totalmente autosuficiente por defecto (builtin): LanzadorAPK gestiona adb / QEMU / imagen del sistema sin depender de emuladores de terceros
 *  - todas las operaciones sobre Android van por adb, así que el motor es reemplazable
 *  - la máquina virtual arranca bajo demanda y se libera en reposo; tras arrancar se mantiene y reutiliza, así instalar/abrir apps casi no tiene espera
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient, isUnauthorizedError } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const backends = require('./backends');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** Si alguien escucha en un puerto TCP (para saber si el emulador de la vez anterior sigue vivo) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // Sesión del contenedor: ventanas de apps abiertas
    // Apps en segundo plano suspendidas en modo multiventana (force-stop conservando datos); al volver a abrirlas se recuperan en caliente.
    this._tombstoned = new Set();
    // Resultado de la última comprobación de red. La barra de estado debe mostrar «red OK / sin internet», pero el estado se consulta muy seguido,
    // y no se puede ejecutar una shell en el invitado cada vez; aquí solo se guarda la conclusión y si caduca (>5 minutos) no se usa.
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // El puerto se elige al vuelo y el serial cambia con él
    /**
     * Capa de adaptación de backends: saca de esta clase la cuestión de «de dónde sale Android».
     *
     * Desde 0.5.6 aquí **solo hay una implementación**: builtin (emulator + imagen del sistema integrados).
     * Ya no existen las ramas mumu / fydeos / attach: cualquier equipo, configuración o configuración heredada
     * solo obtiene el runtime integrado, garantizando que LanzadorAPK siempre funcione de forma independiente, sin relación con emuladores de terceros.
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * Instancia actual del backend (solo una: builtin).
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    if (!this._backend) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /**
   * Si el backend que pide la configuración existe en este equipo.
   *
   * Ahora solo existe el runtime integrado y siempre está disponible (si falta la imagen es cosa de la fase de provisión, no de «el backend no existe»).
   * El método se conserva para no cambiar los puntos de llamada superiores.
   */
  async backendAvailable() {
    return { ok: true, id: 'builtin' };
  }

  /** id del backend, siempre 'builtin'; lo usan la interfaz y los registros */
  get backendId() { return this.backend.id; }

  /** Descarta las conexiones y supuestos de puertos anteriores (se llama tras cambiar la carpeta del runtime o restablecer datos) */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** Si el motor emulator está en ejecución */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- Básico ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    // El adb propio siempre va primero: un mismo dispositivo solo tiene un estado de adb y no hay cortes offline repetidos.
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // Al cambiar de puerto/de adb no se deja la adb shell persistente anterior ocupando la conexión en segundo plano
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- Estado ----------------

  /**
   * Instantánea de red para la barra de estado (conclusión de la última comprobación).
   * Si tiene más de 5 minutos no se usa: pudo cortarse la red entretanto; mejor mostrar «desconocido» que engañar al usuario diciendo que va bien.
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * Comprobación de red en segundo plano (no bloquea la respuesta de status).
   * La barra de estado muestra el estado de la red, pero status() se consulta muy seguido y no puede ejecutar una shell en el invitado cada vez.
   * Por eso la primera vez (o al caducar) se ejecuta en segundo plano, la conclusión se guarda en _lastNetwork y la siguiente consulta ya la muestra.
   */
  _probeNetworkInBackground() {
    if (this._netProbing) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // Se comprobó hace menos de un minuto; no repetir
    this._netProbing = true;
    this.emulator.checkNetwork(this.adbPath())
      .then((r) => {
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* Si no se puede comprobar se deja igual y se reintenta en la siguiente ronda */ })
      .finally(() => { this._netProbing = false; });
  }

  async status() {
    const backend = this.backend;
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // «Por qué no arrancó la última vez»: si no está en memoria se usa el registro guardado en disco; la configuración/el diagnóstico muestran la causa real
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'Falta adb: pulsa «Completar con un clic» para descargarlo';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // La «falta de aceleración por hardware» ya no bloquea: doctor pasa automáticamente a emulación por software,
    // y si el arranque falla reintenta en orden con combinaciones de GPU/aceleración/memoria.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /**
   * Lista de dispositivos conectados al adb de este equipo (solo para diagnóstico).
   *
   * Desde 0.5.6 ya no existe el modo «conectar un runtime existente»: aquí no se hace connect a puertos de otros emuladores,
   * solo se listan tal cual los dispositivos que ve adb, para confirmar al diagnosticar «si es nuestro emulator-5554».
   */
  async probe() {
    try {
      const devices = await this.client().devices();
      return devices
        .filter((d) => d.state === 'device')
        .map((d) => ({ name: d.serial, serial: d.serial }));
    } catch (_) {
      return [];
    }
  }

  // ---------------- Iniciar / detener la máquina virtual ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'LanzadorAPK Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // Preferido: el emulator oficial (con modelo de dispositivo y traducción de GPU propios, la mejor experiencia)
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Inicia Android con el emulator oficial.
   * A diferencia de QEMU+ISO, aquí no hay paso de «instalar el sistema»: la imagen es el sistema y arranca desde la primera vez.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('No se detectó aceleración por hardware: se usará emulación por software automáticamente (el primer arranque será bastante más lento; no hace falta configurar nada)');
    }

    this.vmStarting = true;
    try {
      // probe se delega al bucle de arranque de EmulatorEngine: si el proceso sale/hay registros fatales reintenta con otros parámetros
      // Un solo comando adb por ronda: antes eran tres procesos (get-state + getprop + pm path),
      // y al restaurar desde instantánea cada ronda sumaba 300–500 ms, justo durante la sensación de «abrir la app».
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let authHealed = false;  // Si este start() ya invalidó la instantánea anterior por «no autorizado» y arrancó en frío
      const diagUnauthorized = () => ({
        code: 'ADB_UNAUTHORIZED',
        title: 'La autorización de depuración de Android no se completó (hay que pulsar «Permitir» una vez)',
        // El texto anterior mandaba borrar %USERPROFILE%\.android\adbkey; en pruebas eso es **contraproducente**:
        // con una clave nueva, la clave pública vieja guardada en el sistema sigue vigente, no coinciden y nunca se autoriza
        // (Android solo escribe la nueva clave pública si adb_keys no existe). Lo correcto es, en la ventana del emulador,
        // pulsar «Permitir» una vez, o borrar los datos de Android para que el sistema recree la tabla de autorizaciones.
        hint: 'El emulador está detenido en el diálogo «¿Permitir la depuración USB?». En esa ventana del emulador pulsa «Permitir»;'
          + 'marca «Permitir siempre desde este equipo» antes de pulsar y no volverá a preguntar. '
          + 'Si la ventana no responde o no aparece: Configuración → Runtime → borra los datos de Android y vuelve a intentarlo '
          + '(se borran las apps instaladas; solo vuelve a instalarlas, los archivos APK no se ven afectados).',
      });
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (e) {
          errStreak += 1;
          // Rama clave: un error de adb shell puede ser «todavía no arrancó» o «el diálogo de autorización está atascado».
          // En el segundo caso cada shell lanza una excepción; la implementación anterior lo trataba como un offline normal: reiniciaba el servidor y seguía
          // esperando 240 s × 4 combinaciones de parámetros, y al final decía «el runtime no terminó de arrancar», haciendo creer al usuario que era la GPU/virtualización.
          // Aquí se confirma unauthorized dos veces, primero por el texto del error y luego por la columna state de devices (get-state no distingue authorized),
          // y si coincide se invalida la instantánea, se arranca en frío y se da un diagnóstico preciso, sin esperar en vano.
          const raw = String((e && (e.raw || e.stdout || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st = await c.deviceState().catch(() => '');
            unauthorized = st === 'unauthorized';
          }
          if (unauthorized) {
            this.emulator.lastDiagnosis = diagUnauthorized();
            if (!authHealed) {
              authHealed = true;
              onLog('adb está bloqueado en el diálogo «Permitir depuración USB»; invalidando la instantánea anterior y arrancando en frío para volver a inyectar la clave pública…');
              try { this.emulator.invalidateSnapshot(); } catch (_) { /* ignore */ }
              this.emulator._coldBoot = true; // La siguiente ronda fuerza un arranque en frío para que emulator vuelva a inyectar la clave pública de adb
              await this.emulator.resetAdbServer().catch(() => {});
              this._probeClient = null;
            }
            // Se deja a start() reintentar enseguida con otros parámetros; tras el arranque en frío el problema del diálogo desaparece
            return 'fatal';
          }
          // Otros errores de transferencia de adb: se mantiene la autocorrección de reiniciar el servidor
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('Conexión de adb anormal; reiniciando el servidor adb y esperando…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // Cuando start() falla devuelve {ok:false} en vez de lanzar una excepción (disco insuficiente, fallos tras varios reintentos, etc.).
      // La implementación anterior no miraba este campo y devolvía ok:true hacia arriba; la capa superior creía «ya está listo»,
      // luego adb daba device not found una y otra vez, y el usuario veía «no responde al abrir» en lugar de la causa real.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'El runtime de Android no pudo arrancar',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // La instantánea ahora se guarda «en reposo»: guardarla de inmediato escribe 1–3 GB y compite por la E/S de disco con la app que el usuario acaba de abrir
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Pasa tal cual a la interfaz las conclusiones de los reintentos/diagnóstico automáticos, sin envolverlas en un vago «error al iniciar»
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- Precalentamiento (mantener el entorno cargado como WSA) ----------------

  /** Guarda la instantánea quickboot en reposo: solo escribe a disco sin ventanas de apps, para no competir por E/S con el arranque de apps */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** Para llamadas externas como el instalador: tras instalar una app se guarda otra instantánea y el próximo arranque sigue siendo instantáneo */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Fuerza el guardado de una instantánea, **sin esperar al reposo**.
   *
   * Cuándo hace falta: justo después de reparar la red y antes de iniciar una app. El
   * scheduleSnapshotSave normal solo escribe sin ventanas de apps, y al abrir una app nunca hay reposo,
   * así que el estado «red conectada» nunca se guardaba; el siguiente arranque restauraba la instantánea vieja
   * sin red y cada vez había que reconectar. Aquí se omite explícitamente la condición de reposo: una escritura ahora ahorra todas las siguientes.
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), { delay, isIdle: () => true });
  }

  /**
   * Precalentamiento: prepara el entorno Android en segundo plano antes de que el usuario abra una app.
   * Es la idea de WSA y similares: el entorno queda cargado y al pulsar el icono solo falta un am start.
   *  - totalmente silencioso: sin ventanas ni errores; si falla no afecta abrir apps normalmente;
   *  - idempotente: si está arrancando o ya listo reutiliza la misma Promise y no lanza una segunda máquina;
   *  - ahorra recursos: tras arrancar baja qemu a la prioridad mínima y lo deja en reposo.
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`Precalentamiento: ${m}`) });
        if (r && r.ok) {
          // Durante el precalentamiento el usuario puede haber abierto ya una app: entonces no se puede bajar a prioridad idle
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Precalentamiento completado (${Math.round(ms / 1000)} s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('QEMU no está instalado; completa primero la instalación del runtime');
    if (install && !env.iso.ok) throw new Error('La imagen del sistema (ISO) no está lista');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Android todavía no está instalado en el disco virtual');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Iniciando el runtime (${env.hypervisor.whpx ? 'aceleración por hardware WHPX' : 'emulación solo por software'})…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Error al iniciar: ${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`El runtime se cerró (code=${code})`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU no pudo iniciar; detalles en el registro: ${logFile}`);

    // Modo instalación: la ISO trae el instalador de Linux, sin adb; no se puede tratar como «esperar a adb»
    if (install) {
      onLog('El instalador se inició; sigue el asistente en la ventana de la máquina virtual');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'La máquina virtual arrancó, pero adb no pudo conectar: activa «Opciones de desarrollador → ADB por red» dentro de la máquina virtual e inténtalo de nuevo',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'El kernel de Android no terminó de arrancar; revisa el registro del runtime (la imagen puede estar dañada o la aceleración no está activa)'
          : 'Android arrancó pero los servicios del sistema no están listos (puede estar en la configuración inicial; complétala en la ventana de la máquina virtual)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Espera a que Android sea realmente utilizable: adb en línea ≠ sistema utilizable.
   * Hay que esperar a sys.boot_completed=1 y a que responda el gestor de paquetes; si no, am start falla directamente.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`El kernel de Android arrancó; esperando a que los servicios del sistema estén listos… (${Math.round((Date.now() - start) / 1000)} s)`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android listo (${Math.round((Date.now() - start) / 1000)} s)`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Esperando los servicios del sistema… ${Math.round((Date.now() - start) / 1000)}s`
          : `Iniciando Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // emulator-5554 y similares los registra el propio emulator; no hace falta adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Esperando a que Android arranque… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    // Configuración regional (idioma + zona horaria + teclado latino), una vez por **arranque**.
    // El idioma del sistema se inyecta al lanzar el emulador (-change-locale); aquí se
    // completan el idioma a nivel de ajustes, la zona horaria del PC y el teclado latino.
    // Se desactiva poniendo engine.locale = 'off'.
    const wantLocale = String(this.settings.engine.locale || 'es-419');
    if (!this._chineseReady && wantLocale !== 'off') {
      try {
        const locale = wantLocale;
        await client.ensureChineseLocale(locale, this._hostTimezone());
        // Teclado latino de la imagen; un fallo aquí no impide abrir apps.
        const kb = await client.ensureLatinKeyboard();
        this.log(`Teclado latino: ${kb.ok ? kb.ime : (kb.reason || 'no disponible')}`);
        this._chineseReady = true;
        // -change-locale solo se aplica en un «arranque completo» y reinicia el framework; al restaurar desde una instantánea quickboot
        // se omite. Una instantánea vieja puede estar en otro idioma; si se detecta que el idioma del sistema no coincide, se invalida la instantánea
        // y el próximo arranque es en frío (con -change-locale). Las instantáneas nuevas ya quedan en el idioma configurado
        // y no hace falta reiniciar otra vez. Una marca garantiza que la corrección se haga una sola vez.
        await this._ensureSystemLocale(client, locale);
      } catch (e) {
        this.log(`Se omitió la configuración de idioma: ${e.message}`);
      }
    }
    // Botones de navegación de Android (Atrás / Inicio / Apps abiertas) dentro de la pantalla. Opcional (Configuración →
    // Pantalla y ventana); por defecto la imagen usa gestos. Solo se fuerza si está activado: el estado queda guardado en Android.
    const disp = (this.settings && this.settings.display) || {};
    if (disp.navButtons === true && !this._navReady) {
      try {
        const r = await client.setNavButtons(true);
        this._navReady = !!r.ok;
        this.log(`Botones de navegación de Android: ${r.ok ? 'activados' : (r.out || 'no disponibles')}`);
      } catch (e) {
        this.log(`Botones de navegación omitidos: ${e.message}`);
      }
    }
    this.startWatchdog();
  }

  /**
   * Corrección del idioma de la interfaz del sistema (una sola vez).
   *
   * Conclusión de pruebas (fácil de equivocarse): tras aplicar -change-locale **no** se escribe persist.sys.locale,
   * y ro.product.locale sigue siendo el en-US de la imagen; lo que cambia de verdad es
   * `settings system system_locales` (la página de idioma muestra el idioma elegido y la interfaz del sistema cambia por completo).
   * Por eso para saber si «el idioma ya se aplicó» se mira system_locales, no getprop.
   *
   * -change-locale solo se aplica en un «arranque completo» y reinicia el framework; al restaurar desde una instantánea quickboot
   * se omite. Una instantánea vieja puede estar en otro idioma; si no coincide se invalida y el próximo arranque es en frío.
   * Las instantáneas nuevas ya quedan en el idioma configurado y no hace falta reiniciar. Una marca garantiza que la corrección se haga una sola vez.
   */
  /** Android time zone: the user's setting, or this PC's IANA zone (e.g. America/Bogota). */
  _hostTimezone() {
    const set = String(this.settings.engine.timezone || '').trim();
    if (set) return set;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
  }

  async _ensureSystemLocale(client, locale) {
    const fs = require('fs');
    const path = require('path');
    const want = String(locale || 'es-419');
    if (want === 'off' || want === 'en-US') return;
    // Ya está aplicado (system_locales es el idioma objetivo, o es el primero de la lista de idiomas)
    const cur = await client.shell('settings get system system_locales', { timeout: 8000 }).catch(() => '');
    const s = String(cur).trim();
    if (s === want || s.toLowerCase().indexOf(want.toLowerCase()) === 0) return;
    const marker = path.join(store.DATA_DIR, 'locale-' + want.replace(/[^a-zA-Z0-9_-]/g, '_') + '.done');
    if (fs.existsSync(marker)) return;
    try {
      fs.writeFileSync(marker, String(Date.now()));
      this.log(`El idioma del sistema sigue siendo ${s || '(vacío)'}; se invalida la instantánea anterior y el próximo arranque en frío cambiará a ${want}`);
      this.emulator.invalidateSnapshot();
      this.emulator.forceColdBootOnNextStart();
    } catch (e) {
      this.log(`Se omitió la corrección del idioma del sistema: ${e.message}`);
    }
  }

  /** Detención ordenada: emulator se apaga por la consola, QEMU por monitor */
  async stop({ graceful = true } = {}) {
    // Al detenerse el runtime, la conclusión de red del invitado en caché se invalida de inmediato. Si no, tras rotar/reiniciar, la máquina nueva
    // aún no tiene red pero waitForNetwork devolvería ok por la caché de 8 s, y la app volvería a quedar en negro.
    this._lastNetwork = null;
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // Un emulador tomado (adoptExisting) no tiene identificador proc en este proceso; la lógica anterior hacía
    // return false directamente, y el vigilante de reposo nunca podía apagarlo: el contenedor seguía ocupando CPU/memoria.
    // Esta ruta ahora apaga por la consola de adb y, si hace falta, mata por puerto como respaldo.
    //
    // Ojo: emulator.exe solo es un lanzador y sale tras lanzar qemu, así que incluso las máquinas «que lanzamos nosotros»
    // suelen caer en esta rama. Antes de apagar hay que hacer un saveSnapshotNow; si no, la instantánea nunca se guarda
    // y cada apertura es un arranque en frío completo (la diferencia entre 25 s y 8 s está en este paso).
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor superó el tiempo de espera')));
      sock.on('error', (e) => {
        // Tras ejecutar quit y similares, QEMU corta la conexión por su cuenta (ECONNRESET/EPIPE); es normal
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- Instalar el sistema en un disco virtual ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Primero descarga o importa una imagen del sistema Android (ISO)');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'No se pudo iniciar el entorno de instalación');
    return r;
  }

  /** Tras la instalación: cerrar el instalador → escribir la marca → después arrancar directamente desde el disco */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * Toma el emulador que dejó la ejecución anterior.
   * Cada emulador tiene su puerto de consola (5554/5556/…) y el puerto adb es +1.
   * Si el puerto conecta y el sistema ya tiene boot_completed, se usa directamente como nuestro runtime,
   * así «cerrar LanzadorAPK y volver a abrir una app» es instantáneo, en vez de arrancar otra máquina en frío.
   */
  /**
   * Busca todos los puertos de consola de emuladores que siguen vivos.
   * No se puede «probar en orden desde 5554»: el puerto sube con varios arranques (5554→5556→5558…),
   * y probar un rango fijo siempre deja alguno fuera; si se escapa uno se abre otra máquina nueva. Aquí se buscan por nombre de proceso
   * todos los puertos TCP en los que escucha qemu, sin que se escape ninguno.
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* Se vuelve a la detección por puertos */ }

    if (ports.size) {
      // Escuchan tanto el puerto de consola (par) como el de adb (+1); solo se conserva el de consola
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Respaldo: sin información de procesos qemu, se detecta directamente (si rechaza la conexión vuelve al instante, costo mínimo)
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('No se encontró un runtime anterior; preparando arranque en frío');
      return null;
    }
    onLog(`Se encontraron ${alive.length} runtimes sin cerrar (puertos ${alive.join(', ')}); intentando tomar el control`);

    // El servidor adb puede conservar registros offline del proceso anterior (pasa si el emulador reinició adbd);
    // hay que limpiarlos antes de conectar; si no, get-state siempre devuelve offline y se mataría por error una máquina que está bien por «no estar lista».
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Se encontró un runtime anterior (${serial}) que no está listo; se cierra antes de arrancar de nuevo`);
        // La carpeta del AVD tiene un bloqueo: mantener esta máquina haría salir directamente a la nueva instancia, con el síntoma «no hay forma de que arranque».
        // adb ya no conecta; solo queda buscar el proceso por el puerto de consola y matarlo.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Se tomó el control del runtime en ejecución (${serial})`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** Qué proceso escucha en un puerto TCP (para matar un emulador colgado) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Limpia los emuladores huérfanos que dejó la ejecución anterior y que no se tomaron.
   * Al cerrar LanzadorAPK, emulator es detached y qemu sigue vivo; en el siguiente inicio sigue reteniendo el bloqueo del AVD,
   * y el arranque en frío da directamente FATAL "Running multiple emulators with the same AVD".
   * La implementación se concentra en EmulatorEngine; la ruta de reintento (killAttempt) usa la misma lógica.
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * Punto de entrada idempotente: el precalentamiento y el clic del usuario pueden ocurrir a la vez; comparten una Promise
   * para que cada uno no decida «no está en línea» y lance su propio emulador (conflicto de bloqueo del AVD + el doble de memoria).
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      /**
       * «En línea» no significa «puede trabajar».
       *
       * En los cientos de milisegundos en que el proceso del emulador acaba de salir o está reiniciando, adb
       * sigue respondiendo `device` a `-s emulator-5554 get-state`. La lógica anterior por eso
       * devolvía reused directamente, y la cadena de arranque al cambiar la orientación de la pantalla recibía un cliente ya muerto:
       * cada comando siguiente daba `device 'emulator-5554' not found` (probado: ensure quedaba «listo»
       * en 0,2 s y fallaban todos los arranques de apps).
       *
       * Aquí se agrega un comando real: solo si getprop se ejecuta cuenta como que el dispositivo existe (si devuelve 0 todavía está
       * arrancando, lo cual es normal y se reutiliza esperando como antes); si el comando falla se trata como no listo
       * y se sigue con el flujo de lanzamiento de abajo.
       */
      const probe = await client.shell('getprop sys.boot_completed', { timeout: 5000 })
        .then((v) => String(v == null ? '' : v).trim())
        .catch(() => null);
      if (probe !== null) {
        await this.prepare(client);
        return { ok: true, client, engine: 'builtin', reused: true };
      }
      onLog('adb dice que el dispositivo está en línea pero los comandos no responden (el emulador puede estar reiniciando); iniciando el runtime de nuevo…');
    }

    // Al salir LanzadorAPK la vez anterior el emulador queda vivo (para abrir al instante), pero el proceso nuevo no tiene su
    // identificador y el servidor adb pudo reiniciarse; con solo isOnline() se concluiría «no hay runtime»
    // y se abriría otro. Aquí primero se toma el emulador que sigue vivo, para no repetir máquinas y gastar memoria.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // Emulador heredado de la sesión anterior / lanzado por otro proceso: aunque cambie el puerto se reutiliza; nunca se abre otro
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* Si no se encuentra se lanza normalmente */ }

    // El proceso sigue pero el dispositivo está offline (casi siempre atascado arrancando): primero se detiene y se relanza, sin esperar en vano
    if (this.emulator.running()) {
      onLog('Se detectó un runtime bloqueado; reiniciando…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Única ruta: el runtime integrado
    // En la versión de un solo archivo la imagen va comprimida; primero se descomprime (si ya se hizo pasa al instante).
    // Un error al descomprimir no se puede ocultar: si no, checkEnv() después solo diría «falta la imagen del sistema»
    // y el usuario creería que no se descargó, en vez de que falló la descompresión (disco lleno / archivo dañado).
    let diskFull = null;
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`Error al descomprimir la imagen del sistema: ${e.message}`);
      this.log(`materialize failed: ${e.message}`);
      if (e && e.code === 'DISK_FULL') diskFull = e;
    });
    const env = await this.provisioner.checkEnv();
    // Sin espacio para la imagen no tiene sentido seguir: se devuelve el motivo real (cuánto falta y qué hacer)
    // en vez del genérico «faltan componentes del runtime».
    if (diskFull && !env.sysimg.ok) {
      return { ok: false, error: diskFull.message, code: 'DISK_FULL', diskFull: true, env };
    }

    // Ruta de emulator: la imagen es el sistema; no hay paso de «instalar en disco»
    if (env.emulator.ok && env.sysimg.ok) {
      // Tras cerrar LanzadorAPK puede quedar un emulador sin tomar (el qemu detached sigue vivo),
      // que retiene el bloqueo del AVD y hace que el arranque en frío dé FATAL "Running multiple emulators with the same AVD".
      // Si falla la toma, primero se limpian esos huérfanos y luego se arranca en frío, garantizando que «cerrar y volver a abrir» siempre arranque.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // Ruta QEMU (el usuario trajo su propia ISO y ya la instaló en el disco virtual)
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'Falta la imagen del sistema: pulsa «Descargar imagen del sistema»'
          : 'Los componentes del runtime todavía no están instalados',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- Sesión del contenedor a nivel de app ----------------

  /**
   * Implementación concreta de «abrir como un contenedor»:
   * el entorno Android arranca una sola vez y se mantiene (instantánea quickboot + toma con adoptExisting),
   * y después cada apertura de app es solo am start + enganchar la ventana existente, sin volver a iniciar todo el sistema.
   * Además aquí se hacen tres cosas para reducir la carga del sistema:
   *   - se detienen los procesos de las demás apps del usuario, dejando en el entorno solo lo que necesita la app actual;
   *   - con ventana abierta qemu recibe una prioridad que «cede ante el primer plano»;
   *   - la sincronización de archivos / el sondeo de notificaciones solo se activan con ventana abierta (el callback onActive lo pasa a la interfaz).
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // Nivel de planificación con una app en primer plano. balanced usa normal (no below):
    // con below qemu se queda sin CPU cuando el sistema está ocupado: el video pierde fotogramas y los clics tardan en responder;
    // esa es la causa principal de que «los clics no respondan al instante». normal solo iguala al escritorio y no consume más CPU/memoria/GPU.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // Se va a abrir una app: se pospone «guardar la instantánea en reposo», para no competir por el disco al iniciar la app
      this.emulator.cancelSnapshotSave();
    }
    // Cada vez que se abre/vuelve a una app se asegura la prioridad: endApp baja qemu a idle cuando está en reposo,
    // y si al volver no se sube, se queda en prioridad baja → los clics se sienten lentos. setPriority es idempotente;
    // si ya está en el valor objetivo el script no cambia nada y el costo es mínimo.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* Si falla iniciar el sondeo no se afecta abrir la app */ }
    }

    // Modo multiventana (opción B): abrir una app nueva **ya no** hace force-stop de las demás; si no, no sería multiventana.
    // En su lugar se liberan con la estrategia de suspensión «las de segundo plano que no se ven hace tiempo»: varias a la vez sin que la memoria se dispare.
    // Al desactivar multiWindow se vuelve al comportamiento anterior de «dejar solo la actual», para que sea reversible.
    if (s.engine && s.engine.multiWindow) {
      const roles = container.sessionRoles([...this._activeApps], pkg);
      const { tombstone } = container.planTombstones({
        background: roles.background,
        keepRecent: Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
      });
      const cmds = container.buildTombstoneCommands(tombstone);
      if (cmds.length) {
        await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
        for (const p of tombstone) this._tombstoned.add(p);   // Se anotan las suspendidas, para recuperarlas en caliente al volver a abrirlas
        this.log(`Multiventana: en primer plano ${pkg}, en segundo plano se mantienen ${roles.background.length - tombstone.length}, suspendidas ${tombstone.length}`);
      } else {
        this.log(`Multiventana: ${roles.count} apps a la vez, no hace falta liberar`);
      }
      return { ...roles, plan: { commands: cmds, stopped: tombstone } };
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // La app acaba de hacer am start; limpiar el segundo plano ahora podría afectar al proceso que está pasando al frente; la limpieza va en endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * Cierra una ventana de app: detiene su proceso; si es la última ventana, el contenedor pasa
   * al estado de reposo «cargado pero casi sin consumir recursos» (limpiar segundo plano + Android idle + bajar prioridad de qemu).
   * No se apaga ni se borra el AVD: la próxima vez abre al instante.
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // En modo juego, aunque no haya ventanas por un momento se mantiene la prioridad alta,
      // porque si no, la próxima apertura tendría que volver a subirla y la primera entrada tendría un retraso notable.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Ahora está en máximo reposo: el estado de memoria se guarda como instantánea y el próximo arranque restaura en vez de arrancar en frío
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Contenedor en reposo (Android cargado, 0 procesos de apps, qemu con la prioridad más baja)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Para restaurar los paquetes del sistema desactivados al cambiar «recorte profundo» en la configuración */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- Liberación en reposo ----------------

  /**
   * Autocorrección de orientación: garantiza que el «espacio de pantalla lógico» y la «pantalla física» tengan la misma orientación.
   *
   * Criterio (dumpsys window displays en equipo real):
   *   init=1280x720 ... cur=1280x720   → normal (pantalla horizontal + lógica horizontal)
   *   init=1280x720 ... cur=720x1280   → acostada: el espacio lógico se giró 90°
   * Si cur tiene ancho y alto al revés que init, alguna app/el sistema cambió la orientación;
   * basta con volver a bloquear la orientación e ignorar las peticiones de orientación de las apps, sin reiniciar la máquina virtual.
   *
   * Solo se escribe en settings si de verdad no coincide; normalmente cada 60 s hay una sola shell de solo lectura.
   */
  async _healOrientation() {
    if (!this.emulator || !this.emulator.running()) return;
    const wantLand = !!this.settings.display.landscape;
    const panelLand = typeof this.emulator.panelLandscape === 'function'
      ? this.emulator.panelLandscape() : null;
    // La orientación de la pantalla no coincide con la configuración → hay que reiniciar; aquí no se arregla (lo hace runLaunch.beforeStart)
    if (panelLand !== null && panelLand !== wantLand) return;
    const c = this.client();
    const out = await c.shell('dumpsys window displays', { timeout: 12000 }).catch(() => '');
    const init = /init=(\d+)x(\d+)/.exec(out);
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    if (!init || !cur) return;
    const initLand = Number(init[1]) > Number(init[2]);
    const curLand = Number(cur[1]) > Number(cur[2]);
    if (initLand !== curLand) {
      // Está realmente acostada: volver a bloquear la orientación + ignorar peticiones de orientación de las apps + restaurar density
      this.log(`Autocorrección de orientación: init=${init[1]}x${init[2]} cur=${cur[1]}x${cur[2]} quedó acostada, corrigiendo`);
      await c.resetDisplayOverrides(wantLand).catch(() => {});
      await c.setOrientation(wantLand).catch(() => {});
      return;
    }
    // No estar acostada ≠ estado correcto. El diseño de tableta depende de dos estados en ejecución que se pierden fácilmente:
    //   - mSetIgnoreOrientationRequest (en horizontal debe ser true; si no, las apps tuercen la pantalla)
    //   - la sobrescritura de wm density en 190 (720 de ancho → sw606dp ≥ 600 dp, diseño de tableta)
    // Si se pierden, vuelve al formato de teléfono: justo el síntoma de «el modo tableta no es estable».
    // Aquí se hace una comprobación ligera y se completa lo que falte (todos son comandos idempotentes; normalmente no se escribe nada).
    const densityWanted = (this.settings.display || {}).tabletMode !== false ? 190 : null;
    let ignoreOk = true;
    if (wantLand) {
      const win = await c.shell('dumpsys window | grep -oE "mSetIgnoreOrientationRequest=(true|false)"', { timeout: 8000 }).catch(() => '');
      ignoreOk = /mSetIgnoreOrientationRequest=true/.test(String(win));
    }
    let densityOk = true;
    if (densityWanted) {
      const dens = await c.shell('wm density', { timeout: 6000 }).catch(() => '');
      // Solo es correcto si existe la línea «Override density: N» y es igual al valor objetivo
      const m = /Override density:\s*(\d+)/.exec(String(dens));
      densityOk = !!m && Number(m[1]) === densityWanted;
    }
    if (!ignoreOk || !densityOk) {
      this.log(`Ajuste del estado de pantalla: ignore-orientation=${ignoreOk} density=${densityOk} → completado`);
      if (!ignoreOk) await c.shell('wm set-ignore-orientation-request true', { timeout: 8000 }).catch(() => {});
      // La densidad solo se completa **sin apps en primer plano**.
      // Cambiar la densidad dispara un cambio de configuración + recreación de la Activity, y las apps que guardan DisplayMetrics en caché
      // recalculan los dp con la densidad anterior: la imagen se encoge en un rectángulo arriba a la izquierda con todo vacío a la derecha;
      // el usuario ve que «la app no llena la ventana». Con apps abiertas se deja para el siguiente arranque:
      // resetDisplayOverrides de installer.launch lo fija antes de am start.
      if (!densityOk) {
        if (this._activeApps.size === 0) {
          await c.shell(`wm density ${densityWanted}`, { timeout: 8000 }).catch(() => {});
        } else {
          this.log(`density=${densityWanted} falta pero hay una app en primer plano: se omite hasta el próximo arranque (para no encoger la imagen)`);
        }
      }
    }
  }

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      // Autocorrección de orientación: iniciar una app / recrear una Activity / avisos del sistema pueden cambiar user-rotation o
      // «ignorar peticiones de orientación de las apps». Si cambian, la imagen en la pantalla horizontal queda acostada 90°
      // (lo que el usuario describía como «en modo tableta las apps siempre están acostadas»). Aquí cada revisión lee el estado real
      // y solo corrige si **de verdad no coincide**; normalmente no escribe nada.
      await this._healOrientation().catch(() => {});
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // Un emulador tomado no tiene identificador proc local, y vmRunning será false:
      // antes aquí se hacía return directamente y el contenedor nunca se liberaba. Ahora también se mira si adb está en línea.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- Diagnóstico / reducción (para la interfaz) ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // Los attempts en memoria solo valen en esta sesión; si el usuario reinicia y luego exporta el informe, está vacío.
    // Entonces se usa el último registro de fallo guardado en disco, junto con el final de emulator.log; si no, el informe
    // solo diría UNKNOWN sin mostrar la causa real (las issues #20/#25 cayeron en esto).
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * Recupera imágenes viejas / AVD viejos / archivos de bloqueo / instantáneas del runtime.
   * La causa de «pulso limpiar y no se limpia nada»: con el runtime en marcha, keepSnapshots excluía
   * la instantánea de arranque rápido del AVD actual (≈ un ram.img de varios GB), y con un solo AVD casi no había nada que limpiar.
   * Ahora quien llama puede pasar includeSnapshots: se detiene el runtime antes de recortar y la instantánea se recupera de verdad.
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // Si en la vista previa se detuvo la máquina, se avisa al usuario: tras limpiar puede reiniciar el runtime a mano
    return { ...report, apply, stoppedVm };
  }

  /**
   * Restablece por completo los datos de Android (vacía la partición de usuario /data + apps instaladas + instantánea de arranque rápido),
   * devolviendo el AVD al estado limpio de «sistema recién instalado, sin apps de terceros».
   * Esto borra de verdad una imagen de datos de usuario de 8–16 GB; hay que confirmarlo dos veces (lo hace la interfaz) y solo afecta
   * al AVD activo (lanzadorapk.avd), sin tocar la imagen base de solo lectura ni otros AVD.
   * Se conservan config.ini / hardware-qemu.ini; el AVD sigue siendo válido y la próxima vez que se abra una app arrancará en frío y recreará los datos.
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'lanzadorapk.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Se borra: la imagen de datos de usuario (diferencial qcow2 + base), la instantánea de arranque rápido, archivos/carpetas de bloqueo restantes.
          // Se conserva: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / los *.ini / *.txt / *.cache: son la identidad e infraestructura del AVD;
          //       sin ellos el AVD deja de servir o el siguiente arranque falla. La próxima vez que se abra una app, el emulador recreará /data con la semántica de -wipe-data.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* Lo que está en uso se omite por ahora; se limpia la próxima vez */ }
        }
      }
      // Tras borrar la imagen de datos de usuario, también hay que borrar el registro de «apps instaladas» del lado del usuario;
      // si no, el escritorio/lanzador seguiría mostrando apps que ya no existen.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * Conecta el AndroidWifi «guardado pero que no se conecta solo» (no destructivo: sin reiniciar ni borrar datos).
   * La implementación concreta y la causa real están en emulator.repairWifi.
   *
   * @returns {Promise<boolean>} si ya está conectado
   */
  async repairWifi(adbPath = '') {
    const adb = adbPath || (typeof this.adbPath === 'function' ? this.adbPath() : '');
    return this.emulator.repairWifi(adb).catch(() => false);
  }

  /**
   * Espera a que la máquina virtual tenga red.
   *
   * Probado: `sys.boot_completed` solo indica que el sistema arrancó; la asociación Wi-Fi + DHCP todavía tarda
   * de diez segundos a más de un minuto en obtener 10.0.2.16. Muchas apps cargan la portada apenas entran,
   * y sin red la página se dibuja como un bloque negro (el aviso de privacidad es local y se ve bien),
   * el usuario ve «tras pulsar aceptar y continuar queda en negro». Por eso antes de lanzar la app se espera a que la red esté lista.
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const done = (r) => {
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    // Optimización: tras un arranque en caliente / reinicio por rotación, la ruta de arranque llama a esta función varias veces seguidas
    // (restartForOrientation espera una vez, installer.launch otra).
    // Que la red esté lista es estable; si se confirmó hace menos de 8 s se usa esa conclusión y se ahorra toda una ronda de adb
    // (cada isOnline + checkNetwork son dos shell; en pruebas, de cientos de ms a 1 s).
    // La ventana es de 8 s: cubre las llamadas seguidas sin engañar mucho tiempo al usuario si la red de verdad se cae.
    // Ojo: stop() borra _lastNetwork, así que tras reiniciar no se usa por error el estado anterior al apagado.
    const cached = this._lastNetwork;
    if (cached && cached.ok && Date.now() - cached.at < 8000) return cached;
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // Una máquina virtual recién reiniciada pasa un rato sin adb en línea; no se puede abandonar al ver offline
        // (antes pasaba así: tras restablecer datos devolvía device-offline de inmediato y se concluía «reparación fallida»).
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return done(last);
        // `wifi-not-connected` significa «el Wi-Fi ni siquiera se asoció», no «se asoció y espera DHCP».
        // En ese estado esperar hasta agotar el tiempo es puro desperdicio: en este arranque no se conectará solo (en equipos reales AndroidWifi
        // suele quedar como «guardado pero sin conexión automática»). Si varias veces seguidas es por esto, se termina antes,
        // para que quien llama haga cuanto antes una reconexión efectiva en lugar de gastar 20 s esperando.
        // 3 veces (≈9 s) y no 2: al recién arrancar el Wi-Fi ya tarda unos segundos en asociarse,
        // y decidir demasiado pronto abriría la página de ajustes e interrumpiría su propia conexión.
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Esperando a que la máquina virtual Android tenga internet… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

  /**
   * Repara «la máquina virtual Android no tiene red».
   * En la gran mayoría de casos solo es que la asociación Wi-Fi llega después de terminar el arranque; reiniciar y esperar un poco basta,
   * **sin **borrar datos del usuario; solo si se agota la espera se sugiere «Restablecer datos de Android».
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * Garantiza que la máquina virtual tenga red: primero espera; si no llega, arranca en frío una vez (evitando una instantánea quizá «sin red») y vuelve a esperar.
   * Es la solución de raíz a la «pantalla negra tras aceptar»: la app siempre debe iniciarse con la red lista.
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // Primero lo barato: pulsar el AndroidWifi «guardado pero que no se conecta solo».
    // Este paso es varios órdenes de magnitud más ligero que un arranque en frío o borrar datos: no reinicia la máquina virtual ni toca los datos del usuario.
    // En equipos reales esta es la causa de la gran mayoría de casos de «la máquina virtual no tiene red» (ver el comentario de emulator.repairWifi).
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('La máquina virtual no se conecta al Wi-Fi; intentando reconectar…');
      try {
        const fixed = await this.emulator.repairWifi(this.adbPath());
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`Red restablecida (${net.ip || ''}); guardando el estado para que la próxima vez funcione directamente.`);
            try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* Si la reparación falla se sigue con la ruta pesada de abajo */ }
    }
    // El arranque en frío es caro (decenas de segundos) y se hace una sola vez por proceso; si no, cada apertura de app lo repetiría,
    // y el usuario sentiría que «abrir tarda varios minutos».
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('La red aún no está lista; haciendo un arranque en frío de la máquina virtual (sin instantánea) y reintentando…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // Con la red bien se guarda la instantánea de inmediato; la próxima restauración recupera también el estado de la tarjeta de red
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Repara «la máquina virtual Android no tiene red».
   * Orden: arranque en frío (sin tocar datos) → esperar la red → solo si no funciona, restablecer datos (se pierden datos dentro de las apps).
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Reparación escalonada, de lo más barato a lo más caro; si se puede, nunca se pierden datos:
      //   1) reconectar el Wi-Fi (sin reiniciar ni tocar datos)
      //   2) arranque en frío (sin cargar instantánea, sin tocar datos)
      //   3) al final, restablecer datos
      onLog('Reparando la red de la máquina virtual: primero se intenta reconectar el Wi-Fi (no afecta las apps instaladas)…');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || 'La máquina virtual no pudo arrancar', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.emulator.repairWifi(this.adbPath()); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
          onLog(`Red restablecida (${net1.ip || ''}); se guardó una instantánea en buen estado.`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // Paso 2: arranque en frío, evitando una instantánea quizá «sin red»
      onLog('La reconexión no funcionó; haciendo un arranque en frío de la máquina virtual (sin instantánea, se conservan los datos)…');
      await this.stop({ graceful: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'La máquina virtual no pudo arrancar', boot: false };
      }
      let network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Red restablecida (${network.ip || ''}); se guardó una instantánea en buen estado.`);
        return { ok: true, network, boot: true, wiped: false };
      }
      // Paso 3: sigue sin red; solo queda restablecer datos (se pierden datos dentro de las apps)
      onLog('Sigue sin red; restableciendo los datos de Android y arrancando de nuevo (la lista de apps se conserva y se reinstalan al abrirlas)…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Se da un poco de tiempo para que el qemu / netsimd anterior termine del todo; si no, -wipe-data choca con el bloqueo del AVD
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot2 = await this.ensure({ onLog });
      if (!boot2 || !boot2.ok) {
        return { ok: false, error: (boot2 && boot2.error) || 'La máquina virtual no pudo arrancar', boot: false, wiped: true };
      }
      network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Guarda de inmediato el estado «red OK» como instantánea: la próxima restauración recupera también el estado de la tarjeta de red,
        // si no, al cerrar y volver a abrir volvería a quedar sin red.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Red restablecida (${network.ip || ''} puerta de enlace ${network.gateway || 'accesible'}); se guardó una instantánea en buen estado.`);
      } else {
        onLog('Sigue sin internet después de restablecer. Revisa si la red o el firewall de este equipo bloquean el emulador (netsimd usa puertos de loopback locales).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // La capa de backends solo tiene el runtime integrado; dispose solo limpia lo suyo y no toca ningún emulador externo
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // Aquí **nunca** se mata qemu a la fuerza:
    //  1) matarlo corta la instantánea quickboot que se está escribiendo y deja solo un cascarón ram.img de varios GB,
    //     el siguiente arranque falla al cargarla → arranque en frío completo; esa es la causa directa de «cada apertura tarda dos minutos»;
    //  2) si se deja vivo, la próxima vez que se abra LanzadorAPK lo toma directamente y las apps abren al instante (el mismo comportamiento que WSA y similares).
    // La desinstalación va por otro camino (app:removeSelf limpia los procesos explícitamente).
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
