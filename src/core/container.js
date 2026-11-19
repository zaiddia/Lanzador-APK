'use strict';
/**
 * Contenedor a nivel de app (capa de cálculo pura)
 *
 * La base de LanzadorAPK es una máquina virtual QEMU completa; no puede «cargar solo los servicios del sistema que necesita una app»
 * como WSA u otros: el kernel Linux, zygote y system_server tienen que arrancar enteros.
 * Pero el «peso» que siente el usuario no viene de esos servicios residentes, sino de:
 *   1. arrancar Android completo cada vez que se abre una app (arranque en frío de 40–142 s, CPU/disco al máximo);
 *   2. las apps abiertas antes se quedan en segundo plano consumiendo memoria, red y wakelocks;
 *   3. sin apps en primer plano, qemu sigue con prioridad Normal compitiendo por CPU con el escritorio;
 *   4. la sincronización de archivos y el sondeo de notificaciones siguen corriendo sin ninguna app abierta.
 *
 * Aquí lo que de verdad se puede recortar se convierte en comandos orquestables y probables:
 *   - el entorno arranca una sola vez; después «abrir una app» = am start + enganchar la ventana (lo hace Runtime.beginApp);
 *   - al abrir una app nueva se detienen los procesos de las demás apps del usuario, dejando solo el entorno que necesita la actual;
 *   - al cerrar la última app Android pasa a reposo, se limpian los procesos en segundo plano y qemu baja de prioridad;
 *   - los paquetes del sistema no se tocan por defecto (detener GMS haría que las apps que dependen de push/inicio de sesión muestren errores),
 *     solo con «recorte profundo» activado por el usuario se desactiva un pequeño grupo de paquetes en segundo plano claramente inútiles.
 *
 * Este archivo no depende de adb / Electron; todo son funciones puras, fáciles de probar.
 */

/** No se pueden recortar nunca: tocarlos deja la interfaz en negro o hace fallar las apps */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Solo con «recorte profundo» se desactivan: estos paquetes solo hacen actualizaciones en segundo plano/fondos/impresión; detenerlos no afecta abrir apps */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play Store (búsqueda de actualizaciones en segundo plano)
  'com.google.android.setupwizard',         // Asistente de configuración inicial
  'com.android.printspooler',               // Servicio de impresión
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // Salvapantallas
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** Paquetes claramente del sistema/framework: se omiten al recortar la sesión para no matarlos por error */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Solo se permite poner en comandos de shell nombres de paquete Android válidos, para evitar inyecciones si el manifiesto viene contaminado */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Comandos de recorte que se ejecutan al iniciar una app.
 * @param {object} o
 * @param {string} o.pkg            paquete que se va a abrir
 * @param {string[]} o.installed    paquetes de apps del usuario instalados (la lista del store)
 * @param {boolean} o.deep          recorte profundo (desactiva paquetes de sistema en segundo plano); por defecto false
 * @param {boolean} o.killBackground si además se limpian los procesos en caché en segundo plano; por defecto false
 *   (limpiar al arrancar podría afectar a la app que acaba de pasar al frente; la limpieza la hacen los comandos de reposo de endApp)
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Limpia los procesos en segundo plano que el sistema tiene en caché (sin el de primer plano ni los servicios persistent),
  // para que «dejar solo la app actual» no sea solo hacer force-stop por nombre, sino devolver memoria de verdad.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // En redes medidas se bloquean los datos en segundo plano, para que la tienda/sincronización no despierte continuamente
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * Tras cerrar la última app, el contenedor queda «en marcha pero sin consumir recursos».
 * No se apaga ni se destruye el AVD: la próxima vez abre al instante; solo se cede CPU/memoria a Windows primero.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Recupera del recorte profundo (se llama cuando el usuario apaga el interruptor, para que sea reversible) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Máquina de estados de la sesión: decide en qué estado queda el contenedor tras un launch/close.
 * Función pura, para verificar casos límite como «cambiar entre varias ventanas» o «cerrar la última ventana».
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** Resumen de una línea para registro/diagnóstico */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Contenedor inactivo (Android sigue cargado pero con prioridad baja, 0 procesos de apps)';
  return `Contenedor activo: ${n} ventanas de apps ${plan && plan.stopped && plan.stopped.length
    ? `; se detuvieron ${plan.stopped.length} apps en segundo plano` : ''}`;
}

/**
 * Máquina de estados de la sesión con varias ventanas (opción B).
 *
 * A diferencia de nextSessionState de una ventana, aquí active puede tener varias apps y hay que distinguir
 * «la que se ve en primer plano» de «las que esperan en segundo plano». Las de segundo plano son las que más memoria usan, por eso se suspenden:
 *   - foreground: la que tiene ventana de imagen y con la que interactúa el usuario;
 *   - background: sigue «abierta» pero sin ventana; pasado el periodo de gracia debe hacerse force-stop (suspenderla);
 *     al volver a abrirla se recupera con arranque en caliente; solo cuesta recargar la página, sin perder sesión/datos.
 *
 * @param {string[]} active        nombres de paquete de todas las apps activas
 * @param {string} foreground      paquete en primer plano (puede ser null)
 * @returns {{foreground:string|null, background:string[], count:number}}
 */
function sessionRoles(active = [], foreground = null) {
  const set = (active || []).filter(Boolean);
  const fg = foreground && set.includes(foreground) ? foreground : (set.length ? set[set.length - 1] : null);
  return {
    foreground: fg,
    background: set.filter((p) => p !== fg),
    count: set.length,
  };
}

/**
 * Decide qué apps en segundo plano se suspenden (force-stop para liberar memoria).
 *
 * Reglas (conservadoras: mejor matar de menos que afectar algo en uso):
 *   - solo se procesan las background, nunca la foreground;
 *   - paquetes del sistema / NEVER_TRIM siempre se omiten;
 *   - se conservan las N más recientes en segundo plano (por defecto 1) para volver rápido sin perder sesión; el resto se suspende;
 *   - tombstoneLimit<=0 significa «no dejar nada en segundo plano», se suspenden todas (lo que más memoria ahorra).
 *
 * @param {object} o { background, installedSystem?, keepRecent?, tombstone? }
 * @returns {{tombstone:string[], keep:string[]}}
 */
function planTombstones({ background = [], keepRecent = 1 } = {}) {
  const bg = (background || []).filter((p) => p && !isSystemPackage(p) && !NEVER_TRIM.includes(p));
  // El final de background es lo más reciente; se conservan las últimas keepRecent y el resto se suspende
  const keepCount = Math.max(0, Number(keepRecent) || 0);
  const keep = bg.slice(Math.max(0, bg.length - keepCount));
  const tombstone = bg.filter((p) => !keep.includes(p));
  return { tombstone, keep };
}

/** Genera los comandos de suspensión: force-stop de los paquetes indicados, liberando memoria pero conservando datos/sesión */
function buildTombstoneCommands(pkgs = []) {
  return pkgs.filter((p) => SAFE_PKG.test(String(p))).map((p) => `am force-stop ${p}`);
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
  sessionRoles, planTombstones, buildTombstoneCommands,
};
