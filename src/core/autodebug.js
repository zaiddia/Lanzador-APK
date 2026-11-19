'use strict';
/**
 * Núcleo de la comprobación automática (depuración automática)
 *
 * Dos capas, separadas a propósito:
 *   1) capa de recolección (src/core/autodebug-probe.js, proceso principal): toma el estado real del equipo como una instantánea de datos puros obs;
 *   2) capa de evaluación (este archivo, funciones puras): evaluate(obs) → issues[].
 *
 * La capa de evaluación no toca fs / child_process / electron; el CI puede hacer require y probarla directamente
 * (lección de una nota interna del 2026-11-17: en CI, los módulos que dependen de electron en el nivel superior fallan por completo).
 *
 * Regla de oro: cualquier campo que falte en obs significa «no se sabe»; un fallo de detección nunca puede reportarse como problema.
 * Un falso positivo daña más la confianza que uno que se escapa: cuando el usuario descubre que un «resultado de la comprobación» es falso,
 * ya no vuelve a creer en ninguna conclusión de la comprobación automática.
 */

/** Categorías de problemas (la configuración las muestra agrupadas en este orden) */
const CATEGORIES = [
  { id: 'runtime', name: 'Runtime', hint: 'Proceso de la máquina virtual Android, fase de arranque, instantáneas y bloqueos restantes' },
  { id: 'device', name: 'Conexión del dispositivo', hint: 'Autorización de adb y si el dispositivo está en línea' },
  { id: 'storage', name: 'Almacenamiento', hint: 'Espacio libre en disco, partición de datos, carpeta compartida' },
  { id: 'settings', name: 'Configuración', hint: 'Conflictos entre opciones de configuración que se anulan entre sí' },
  { id: 'network', name: 'Red', hint: 'Conectividad de Android y de las fuentes de descarga' },
  { id: 'logs', name: 'Registro', hint: 'Errores en el registro de ejecución' },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** Orden por gravedad: número mayor = más grave */
const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };

/** Normaliza un problema, para que la interfaz siempre reciba todos los campos */
function normalise(raw) {
  if (!raw || !raw.code) return null;
  const severity = SEVERITY_RANK[raw.severity] ? raw.severity : 'info';
  return {
    code: String(raw.code),
    category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'runtime',
    severity,
    title: String(raw.title || raw.code),
    hint: String(raw.hint || ''),
    // fix es el nombre de la acción de «reparar con un clic»; la capa de interfaz lo convierte en una operación concreta; si no hay, queda vacío
    fix: raw.fix || '',
    // detail es información adicional para personas (rutas, valores, etc.); no va en el título
    detail: raw.detail === undefined || raw.detail === null ? '' : String(raw.detail),
  };
}

/**
 * Evaluación: convierte la instantánea observada en una lista de problemas
 * @param {object} obs instantánea de la capa de recolección (los campos pueden faltar)
 * @returns {Array<object>} lista de problemas normalizada
 */
function evaluate(obs) {
  const o = obs || {};
  const runtime = o.runtime || {};
  const device = o.device || {};
  const storage = o.storage || {};
  const settings = o.settings || {};
  const network = o.network || {};
  const logs = o.logs || {};
  const accel = o.accel || {};
  const out = [];

  const push = (raw) => {
    const it = normalise(raw);
    if (it) out.push(it);
  };

  /* ---------------- Runtime ---------------- */

  // Fallo de arranque: se da directamente la última causa real; que el usuario no tenga que adivinar
  const bootError = runtime.error || (runtime.lastFailure && runtime.lastFailure.error) || '';
  if (bootError) {
    push({
      code: 'runtime.bootFailed',
      category: 'runtime',
      severity: 'error',
      title: 'El último arranque del runtime de Android falló',
      hint: 'Ya se tiene el error real del runtime; resolver esta causa suele bastar para recuperarlo.',
      detail: bootError,
      fix: 'restartRuntime',
    });
  }

  // Atascado en el arranque: si supera el umbral sin estar listo, casi siempre es una instantánea dañada o un problema de la imagen
  if (runtime.running && runtime.phase && runtime.phase !== 'ready' && runtime.bootMs > 150000) {
    push({
      code: 'runtime.stuckBoot',
      category: 'runtime',
      severity: 'warn',
      title: 'Android se quedó atascado en el arranque',
      hint: 'Lleva más de 2 minutos y medio arrancando sin entrar al sistema. Lo habitual es que la instantánea de arranque rápido esté dañada; reiniciar el runtime (hace un arranque en frío) suele resolverlo.',
      detail: `Fase: ${runtime.phase}`,
      fix: 'restartRuntime',
    });
  }

  // Archivos de bloqueo restantes: harían que el próximo arranque se tome como «AVD ya en uso» y falle con FATAL
  if (Number(runtime.locks) > 0) {
    push({
      code: 'runtime.staleLocks',
      category: 'runtime',
      severity: 'warn',
      title: `Se detectaron ${runtime.locks} archivos de bloqueo del arranque anterior`,
      hint: 'Si no se borran, el próximo arranque fallará como «AVD ya en uso». Se pueden borrar con un clic.',
      fix: 'lock',
    });
  }

  // Procesos huérfanos: emulator.exe solo es el lanzador y qemu es un proceso independiente;
  // matar solo el lanzador deja huérfanos que retienen multiinstance.lock (nota interna 2026-11-13).
  if (Number(runtime.orphans) > 0) {
    push({
      code: 'runtime.orphanProcesses',
      category: 'runtime',
      severity: 'warn',
      title: `Hay ${runtime.orphans} procesos del emulador sin cerrar`,
      hint: 'Procesos de Android que no se cerraron bien siguen ocupando recursos y el bloqueo del AVD, y harán fallar el próximo arranque. Se pueden limpiar con un clic (no toca apps ni partidas guardadas).',
      fix: 'orphans',
    });
  }

  // Instantánea vacía: el archivo existe pero no pasa la verificación; cada arranque «falla al cargar y arranca en frío», ocupando varios GB en vano
  if (runtime.snapshotStale) {
    push({
      code: 'runtime.staleSnapshot',
      category: 'runtime',
      severity: 'warn',
      title: 'La instantánea de arranque rápido está dañada',
      hint: 'El archivo de instantánea existe pero no pasa la verificación, así que cada arranque hace además uno en frío. Borrarla recupera espacio a cambio de un arranque en frío.',
      fix: 'snapshots',
    });
  }

  /* ---------------- Conexión del dispositivo ---------------- */

  // unauthorized: Android mostró «¿Permitir la depuración USB?» pero nadie lo confirmó (problema conocido, nota interna 2026-11-17)
  if (device.state === 'unauthorized') {
    push({
      code: 'device.unauthorized',
      category: 'device',
      severity: 'error',
      title: 'El dispositivo Android no autorizó la depuración',
      hint: 'Android mostró «¿Permitir la depuración USB?» pero nadie lo confirmó, y adb no logra conectar. Reiniciar el runtime (arranque en frío) vuelve a mostrar el aviso; al confirmarlo se recupera.',
      fix: 'restartRuntime',
    });
  } else if (device.state === 'offline') {
    push({
      code: 'device.offline',
      category: 'device',
      severity: 'warn',
      title: 'El dispositivo Android está «offline»',
      hint: 'adb ve el dispositivo pero no conecta; normalmente la máquina virtual sigue arrancando o el servicio adb no terminó el enlace. Si no se recupera en un rato, reinicia el runtime.',
      fix: 'restartRuntime',
    });
  } else if (runtime.running && device.checked && device.state === 'no-device') {
    push({
      code: 'device.missing',
      category: 'device',
      severity: 'warn',
      title: 'El runtime está en marcha pero adb no ve el dispositivo',
      hint: 'El proceso de Android está activo pero adb no ve el dispositivo; casi siempre otro programa ocupa el puerto de adb o el arranque no terminó.',
      fix: 'restartRuntime',
    });
  }

  /* ---------------- Almacenamiento ---------------- */

  const freeMB = Number(storage.freeMB) || 0;
  // «Disco de tu PC» para no confundirlo con el almacenamiento interno de Android (la partición de datos, más abajo)
  const driveM = /^([a-zA-Z]):/.exec(String(storage.dir || ''));
  const diskName = driveM ? `el disco ${driveM[1].toUpperCase()}: de tu PC` : 'el disco de tu PC';
  const diskWhere = storage.dir ? ` en ${storage.dir}` : '';
  if (freeMB > 0 && freeMB < 2048) {
    push({
      code: 'storage.diskCritical',
      category: 'storage',
      severity: 'error',
      title: `${diskName.charAt(0).toUpperCase()}${diskName.slice(1)} está casi lleno`,
      hint: 'Quedan menos de 2 GB; fallarán la instalación de apps y el guardado de instantáneas. Pulsa «Limpiar con un clic» para recuperar imágenes, instantáneas y registros antiguos, o mueve los datos de Android a otro disco en Configuración → Integración con el sistema.',
      detail: `Quedan ${freeMB} MB${diskWhere}`,
      fix: 'disk',
    });
  } else if (freeMB > 0 && freeMB < 8192) {
    push({
      code: 'storage.diskLow',
      category: 'storage',
      severity: 'warn',
      title: `Poco espacio en ${diskName}`,
      hint: 'Quedan menos de 8 GB y las instantáneas y la imagen del sistema necesitan espacio. Te recomendamos limpiar los archivos recuperables o mover los datos de Android a otro disco (Configuración → Integración con el sistema).',
      detail: `Quedan ${freeMB} MB${diskWhere}`,
      fix: 'disk',
    });
  }

  // La capacidad real de la partición de datos es menor que la configurada → los juegos dirán «Espacio de almacenamiento insuficiente»
  if (storage.needsReset) {
    push({
      code: 'storage.dataNeedsReset',
      category: 'storage',
      severity: 'warn',
      title: 'La ampliación de la partición de datos no se aplicó realmente',
      hint: 'El disco diferencial del arranque rápido impide ampliar en el sitio y Android sigue viendo la capacidad anterior. Hay que «Restablecer datos de Android» para recrearla con la nueva capacidad (se borran las apps instaladas).',
      detail: `Configurado ${storage.configuredGB} GB · real ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  } else if (Number(storage.configuredGB) > 0 && Number(storage.actualGB) > 0
    && Number(storage.configuredGB) > Number(storage.actualGB)) {
    push({
      code: 'storage.dataMismatch',
      category: 'storage',
      severity: 'error',
      title: 'El almacenamiento interno de Android (partición de datos) es más pequeño que lo configurado',
      hint: 'La capacidad real disponible en Android es menor que la configurada; los juegos grandes dirán que falta espacio.',
      detail: `Configurado ${storage.configuredGB} GB · real ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  }

  if (storage.sharedOk === false) {
    push({
      code: 'storage.sharedBroken',
      category: 'storage',
      severity: 'warn',
      title: 'La carpeta compartida no está disponible',
      hint: 'La carpeta de este equipo para compartir archivos no existe o no tiene permisos de escritura; lo que guardes en Android no se sincronizará.',
      detail: storage.sharedPath || '',
      fix: 'shared',
    });
  }

  /* ---------------- Configuración ---------------- */

  // La estrategia de orientación choca con la pantalla física → Android solo da a la app una franja estrecha en el centro (problema conocido, nota interna 2026-11-18)
  const mode = String(settings.orientationMode || 'auto');
  if (mode === 'portrait' && settings.landscape === true) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'La estrategia de orientación es contraria a la orientación actual de la pantalla',
      hint: 'La estrategia pide vertical pero la pantalla está en horizontal; Android solo dará a la app una franja estrecha con bordes negros. Cambia la orientación de la pantalla para que coincida con la estrategia.',
      fix: 'orientation',
    });
  } else if (mode === 'landscape' && settings.landscape === false) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'La estrategia de orientación es contraria a la orientación actual de la pantalla',
      hint: 'La estrategia pide horizontal pero la pantalla está en vertical; videos y juegos se verán en una franja vertical estrecha. Cambia la orientación de la pantalla para que coincida con la estrategia.',
      fix: 'orientation',
    });
  }

  if (settings.windowEmbed === false && settings.autoFullscreen) {
    push({
      code: 'settings.detachedFullscreen',
      category: 'settings',
      severity: 'info',
      title: '«Pantalla completa al iniciar» no funciona en modo ventana nativa',
      hint: 'En modo nativo el emulador abre su propia ventana y decide él mismo la pantalla completa; este interruptor no lo controla. Para llenar la pantalla pulsa F11 en la ventana o cambia el modo de ventana a incrustado.',
    });
  }

  if (settings.keepSnapshot === false && freeMB > 0 && freeMB < 4096) {
    push({
      code: 'settings.snapshotOffLowDisk',
      category: 'settings',
      severity: 'info',
      title: 'Poco espacio en disco y la instantánea de arranque rápido está desactivada',
      hint: 'Quedan menos de 4 GB y las instantáneas están desactivadas: cada vez que abras una app hará un arranque en frío completo (unos segundos más). Si tienes espacio, vuelve a activarlas.',
      fix: 'settings',
    });
  }

  /* ---------------- Red ---------------- */

  if (network.ok === false) {
    push({
      code: 'network.guestDown',
      category: 'network',
      severity: 'warn',
      title: 'Android no tiene internet',
      hint: 'Android no logra resolver nombres o conectarse; las apps de video y noticias se quedarán cargando. Usa «Reparar red» para restablecer los datos de Android (la lista de apps se conserva).',
      detail: network.reason || '',
      fix: 'repairNetwork',
    });
  }

  const badSources = Array.isArray(network.sources) ? network.sources.filter((s) => s && s.ok === false) : [];
  if (badSources.length) {
    push({
      code: 'network.sourcesDown',
      category: 'network',
      severity: 'warn',
      title: `${badSources.length} fuentes de descarga inaccesibles`,
      hint: 'La búsqueda de actualizaciones no pudo conectar; revisa tu red o proxy.',
      detail: badSources.map((s) => s.name).join(','),
      fix: 'settings',
    });
  }

  /* ---------------- Registro ---------------- */

  const errLines = Array.isArray(logs.errors) ? logs.errors.filter(Boolean) : [];
  if (errLines.length) {
    push({
      code: 'logs.errors',
      category: 'logs',
      severity: 'warn',
      title: `El registro de ejecución tiene ${errLines.length} errores`,
      hint: 'La última ejecución dejó errores registrados; abre el informe de diagnóstico para ver el contexto completo.',
      detail: errLines.slice(-1)[0],
      fix: 'report',
    });
  }

  /* ---------------- Aceleración ---------------- */

  if (accel.checked && accel.ok === false) {
    push({
      code: 'accel.softwareEmulation',
      category: 'runtime',
      severity: 'warn',
      title: 'Sin aceleración por hardware',
      hint: 'Solo funciona la emulación por software: el arranque tarda minutos y la imagen pierde fotogramas. Activa «Plataforma del hipervisor de Windows» y reinicia.',
      detail: accel.note || '',
      fix: 'virtualization',
    });
  }

  return dedupe(out);
}

/** Del mismo code solo se conserva el último (una comprobación nueva sustituye a la anterior) */
function dedupe(issues) {
  const map = new Map();
  for (const raw of issues || []) {
    const it = normalise(raw);
    if (!it) continue;
    map.set(it.code, it);
  }
  return Array.from(map.values());
}

/** Ordena de mayor a menor gravedad */
function bySeverity(a, b) {
  const d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (d) return d;
  return String(a.code).localeCompare(String(b.code));
}

/** Resumen: conteo para la barra de estado y columnas para la configuración */
function summarize(issues) {
  const list = dedupe(issues).sort(bySeverity);
  const errors = list.filter((i) => i.severity === 'error').length;
  const warns = list.filter((i) => i.severity === 'warn').length;
  const infos = list.filter((i) => i.severity === 'info').length;
  const byCategory = CATEGORIES.map((c) => {
    const items = list.filter((i) => i.category === c.id);
    return {
      id: c.id,
      name: c.name,
      count: items.length,
      errors: items.filter((i) => i.severity === 'error').length,
    };
  });
  return {
    total: list.length,
    errors,
    warns,
    infos,
    byCategory,
    // Para ver de un vistazo «si hay problemas que haya que resolver ya»
    health: errors ? 'error' : (warns ? 'warn' : (infos ? 'info' : 'ok')),
  };
}

/** Agrupa por categoría para mostrarlos en la configuración */
function groupByCategory(issues) {
  const list = dedupe(issues).sort(bySeverity);
  return CATEGORIES.map((c) => ({
    ...c,
    items: list.filter((i) => i.category === c.id),
  })).filter((g) => g.items.length);
}

/**
 * Compara dos comprobaciones: encuentra los problemas «nuevos» y los «resueltos».
 * La comprobación automática solo avisa al usuario cuando aparece un problema nuevo; los resueltos solo se anotan en silencio;
 * avisar cada vez «se recuperaron 3 elementos» se volvería ruido.
 */
function diff(prevIssues, nextIssues) {
  const prev = new Map((prevIssues || []).map((i) => [i.code, i]));
  const next = new Map((nextIssues || []).map((i) => [i.code, i]));
  const added = [];
  const resolved = [];
  for (const [code, it] of next) {
    const before = prev.get(code);
    if (!before || before.severity !== it.severity) added.push(it);
  }
  for (const [code, it] of prev) {
    if (!next.has(code)) resolved.push(it);
  }
  return { added, resolved };
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  SEVERITY_RANK,
  normalise,
  evaluate,
  dedupe,
  summarize,
  groupByCategory,
  diff,
  bySeverity,
};
