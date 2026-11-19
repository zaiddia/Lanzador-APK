'use strict';
/**
 * Capa de adaptación de backends (backend driver): separa del Runtime la cuestión de «de dónde sale Android».
 *
 * Contexto: LanzadorAPK originalmente tenía un solo backend (el Google Android Emulator / QEMU integrado),
 * y todo el ciclo de vida del motor (arranque, instantáneas, liberación en reposo, descarga de imágenes) estaba fijo en core/engine.js.
 * Pero la experiencia de «doble clic en el APK para instalar, doble clic en el icono para abrir, una ventana limpia por app»
 * solo exige tres cosas al backend:
 *
 *   1. un dispositivo adb al que se pueda conectar (instalar / iniciar / entrada / capturas dependen de él);
 *   2. una ventana con la imagen de Android de la que se pueda obtener el HWND (para incrustarla con SetParent en nuestra ventana);
 *   3. poder iniciar / detener ese dispositivo.
 *
 * Desde 0.5.6 solo queda una implementación: builtin (emulator + imagen del sistema integrados).
 * Esta interfaz se mantiene para que en engine.js la cuestión de «de dónde sale Android» siga teniendo un solo punto de entrada,
 * y para no tocar el flujo principal del motor si algún día se cambia el runtime;
 * pero **ya no se admite ningún emulador de terceros / runtime a nivel de sistema** (no se conectan MuMu / LDPlayer / BlueStacks / WSA).
 *
 * Convenciones (toda implementación debe cumplirlas):
 *  - cualquier método puede llamarse en paralelo; la implementación debe ser idempotente; repetir ensure() no puede arrancar dos máquinas.
 *  - si cualquier paso falla se devuelve { ok:false, error }; no lanzar excepciones a la capa superior (que solo muestra avisos).
 *  - no suponer que se tiene el servidor adb en exclusiva: usar el adb propio si se puede; con el de otro hay que hacer connect.
 */

/** Capacidades del backend: la capa superior decide con ellas qué menús/callbacks mostrar u omitir */
const CAPS = {
  /** Puede descargar/instalar el runtime por sí mismo (imágenes, emulator, adb) */
  provision: 'provision',
  /** Puede guardar instantáneas de arranque rápido (segundo arranque al instante) */
  snapshot: 'snapshot',
  /** Puede ajustar el tamaño de la partición de datos */
  resizeData: 'resizeData',
  /** Puede restablecer por completo los datos de Android (/data) */
  resetData: 'resetData',
  /** Puede cambiar la orientación de la pantalla física (horizontal real, mediante reinicio) */
  rotatePanel: 'rotatePanel',
  /** Puede ajustar la prioridad del proceso (ceder la máquina virtual a la app en primer plano) */
  priority: 'priority',
  /** Puede cerrarse por completo (al desinstalar/salir) */
  shutdown: 'shutdown',
  /** La ventana de imagen la crea software de terceros; no se debe «tomar prestada» demasiado (para no quitarle al usuario su propio emulador) */
  sharedHost: 'sharedHost',
};

class Backend {
  /**
   * @param {object} appRoot carpeta raíz del programa (en el paquete es resources/app)
   * @param {object} deps    dependencias compartidas: { store, log }
   */
  constructor(appRoot, deps = {}) {
    this.appRoot = appRoot || '';
    this.deps = deps || {};
    /** serial de adb (por ejemplo emulator-5554 / 127.0.0.1:16384) */
    this.serial = '';
    /** ruta absoluta de adb.exe */
    this.adbPath = '';
    /** último error, para el diagnóstico */
    this.lastError = '';
  }

  /** id estable del backend (se guarda en la configuración, no cambiarlo a la ligera) */
  static get id() { return 'base'; }

  /** nombre que se muestra en la interfaz */
  static get label() { return 'Backend sin nombre'; }

  /** descripción de una línea; la configuración la usa para explicar qué es este backend */
  static get summary() { return ''; }

  /** si este backend cumple los requisitos de «ventana incrustada» (si no, solo sirve como attach) */
  static get embedCapable() { return false; }

  get id() { return this.constructor.id; }

  get label() { return this.constructor.label; }

  /** conjunto de capacidades, ver CAPS */
  get caps() {
    return new Set();
  }

  has(cap) { return this.caps.has(cap); }

  /** si el backend actual ya está en marcha (no exige que adb esté conectado) */
  running() { return false; }

  /**
   * Detección: si este backend existe en el equipo.
   * Se usa para «elegir automáticamente un backend utilizable»; debe ser rápido (<1,5 s) y sin efectos secundarios.
   * @returns {Promise<{ok:boolean, found:boolean, path?:string, detail?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async probe() { return { ok: true, found: false }; }

  /**
   * Comprobación de disponibilidad: si el usuario ya puede usarlo para instalar apps.
   * @returns {Promise<{ok:boolean, reason?:string, needs?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async check() { return { ok: false, reason: 'No implementado' }; }

  /** Resuelve una ruta de adb utilizable (primero la propia, luego la del backend y por último la del PATH del sistema) */
  async resolveAdb() { return ''; }

  /**
   * Garantiza que el runtime esté disponible: si no arrancó, arranca; si no está conectado, hace connect.
   * @param {object} o { onLog }
   * @returns {Promise<{ok:boolean, serial?:string, adbPath?:string, reused?:boolean, error?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async ensure(o = {}) { return { ok: false, error: 'No implementado' }; }

  /**
   * HWND candidatos de la ventana con la imagen de Android (arreglo de cadenas hexadecimales o decimales, por prioridad).
   * La capa superior (WinAgent) prueba SetParent con cada uno; el primero que funciona cuenta como incrustación exitosa.
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line class-methods-use-this
  async windowTargets() { return []; }

  /**
   * Si la ventana de imagen ya está lista (se puede dejar de ocultar/empezar a incrustar).
   * Por defecto: si hay ventanas candidatas, está lista. La ventana del emulator integrado la lanzamos nosotros,
   * así que la implementación por defecto basta; el gancho se conserva para tener dónde esperar la imagen si algún día cambia el runtime.
   *
   * @param {object} o { isEmbedded?: () => boolean }
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async windowReady(o = {}) { // eslint-disable-line no-unused-vars
    const targets = await this.windowTargets().catch(() => []);
    return targets.length ? { ok: true } : { ok: false, reason: 'no-window' };
  }

  /**
   * Oculta la ventana de imagen (durante el arranque / precalentamiento el usuario no debe ver el emulador).
   * Si no encuentra la ventana devuelve null en silencio.
   * @returns {Promise<string|null>} HWND ocultado
   */
  async hideWindow() { return null; }

  /** Detiene el runtime */
  // eslint-disable-next-line class-methods-use-this
  async stop(o = {}) { return { ok: false, error: 'No implementado' }; }

  /** Descarga/instala los componentes que faltan (solo los backends con CAPS.provision deben implementarlo) */
  // eslint-disable-next-line class-methods-use-this
  async install(component, onProgress) { return { ok: false, error: 'Este backend no admite la instalación automática' }; }

  /** Estadísticas de uso (la sección «Uso del runtime» de la configuración) */
  // eslint-disable-next-line class-methods-use-this
  usage() { return { total: 0, items: [] }; }

  /** Información de la partición de datos */
  // eslint-disable-next-line class-methods-use-this
  dataInfo() { return { ok: false }; }

  /** Ajusta la partición de datos */
  // eslint-disable-next-line class-methods-use-this
  async resizeData(mb) { return { ok: false, error: 'Este backend no admite ajustar la partición de datos' }; }

  /** Restablece por completo los datos de Android */
  // eslint-disable-next-line class-methods-use-this
  async resetData() { return { ok: false, error: 'Este backend no admite restablecer los datos' }; }

  /** Libera recursos (se llama al salir de LanzadorAPK; por defecto no hace nada) */
  // eslint-disable-next-line class-methods-use-this
  dispose() {}

  /** Información de diagnóstico (se incluye en el informe de problemas) */
  // eslint-disable-next-line class-methods-use-this
  diagnose() { return {}; }
}

module.exports = { Backend, CAPS };
