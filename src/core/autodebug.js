'use strict';
/**
 * 自动检测（自动 debug）内核
 *
 * 分两层，刻意分开：
 *   1) 采集层（src/core/autodebug-probe.js，主进程）：把机器真实状态采成一份纯数据快照 obs；
 *   2) 判定层（本文件，纯函数）：evaluate(obs) → issues[]。
 *
 * 判定层不碰 fs / child_process / electron，CI 可以直接 require 并单测
 * （教训见记忆 2026-11-17：CI 上 require 顶层依赖 electron 的模块会全红）。
 *
 * 一条铁律：obs 里没有的字段一律当作「不知道」，不能因为探测失败就报问题。
 * 误报比漏报更伤用户信任 —— 用户一旦发现弹出来的「检测结果」是假的，
 * 就再也不会相信自动检测给出的任何结论了。
 */

/** 问题分类（设置页按这个顺序分组展示） */
const CATEGORIES = [
  { id: 'runtime', name: 'Runtime', hint: 'Proceso de la máquina virtual Android, fase de arranque, instantáneas y bloqueos restantes' },
  { id: 'device', name: 'Conexión del dispositivo', hint: 'Autorización de adb y si el dispositivo está en línea' },
  { id: 'storage', name: 'Almacenamiento', hint: 'Espacio libre en disco, partición de datos, carpeta compartida' },
  { id: 'settings', name: 'Configuración', hint: 'Conflictos entre opciones de configuración que se anulan entre sí' },
  { id: 'network', name: 'Red', hint: 'Conectividad de Android y de las fuentes de descarga' },
  { id: 'logs', name: 'Registro', hint: 'Errores en el registro de ejecución' },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** 严重度排序：数字越大越严重 */
const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };

/** 归一化一条问题，保证 UI 拿到的字段永远齐全 */
function normalise(raw) {
  if (!raw || !raw.code) return null;
  const severity = SEVERITY_RANK[raw.severity] ? raw.severity : 'info';
  return {
    code: String(raw.code),
    category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'runtime',
    severity,
    title: String(raw.title || raw.code),
    hint: String(raw.hint || ''),
    // fix 是「一键修复」的动作名，由渲染层映射到具体操作；没有就留空
    fix: raw.fix || '',
    // detail 是给人看的补充信息（路径、数值等），不进标题
    detail: raw.detail === undefined || raw.detail === null ? '' : String(raw.detail),
  };
}

/**
 * 判定：把观测快照变成问题列表
 * @param {object} obs 采集层给出的快照（字段可缺省）
 * @returns {Array<object>} 归一化后的问题列表
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

  /* ---------------- 运行时 ---------------- */

  // 开机失败：直接给最后一条真实原因，别让用户猜
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

  // 一直卡在引导中：超过阈值还没 ready，多半是快照坏了或镜像有问题
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

  // 残留锁文件：会让下次启动被判成「AVD 已被占用」直接 FATAL
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

  // 孤儿进程：emulator.exe 只是启动器，qemu 是 detached 的独立进程，
  // 只杀启动器会留下孤儿占着 multiinstance.lock（记忆 2026-11-13）。
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

  // 快照空壳：文件在但校验不过，每次开机都要「加载失败再冷启动」，等于白留了几 GB
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

  /* ---------------- 设备连接 ---------------- */

  // unauthorized：安卓弹了「允许 USB 调试吗」但没人点（记忆 2026-11-17 的老坑）
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

  /* ---------------- 存储 ---------------- */

  const freeMB = Number(storage.freeMB) || 0;
  if (freeMB > 0 && freeMB < 2048) {
    push({
      code: 'storage.diskCritical',
      category: 'storage',
      severity: 'error',
      title: 'El disco del runtime está casi lleno',
      hint: 'Quedan menos de 2 GB; fallarán la instalación de apps y el guardado de instantáneas. Pulsa «Limpiar con un clic» para recuperar imágenes, instantáneas y registros antiguos.',
      detail: `Quedan ${freeMB} MB`,
      fix: 'disk',
    });
  } else if (freeMB > 0 && freeMB < 8192) {
    push({
      code: 'storage.diskLow',
      category: 'storage',
      severity: 'warn',
      title: 'Poco espacio en el disco del runtime',
      hint: 'Quedan menos de 8 GB y las instantáneas y la imagen del sistema necesitan espacio. Te recomendamos limpiar los archivos recuperables.',
      detail: `Quedan ${freeMB} MB`,
      fix: 'disk',
    });
  }

  // 数据分区实际容量比配置小 → 装的游戏会提示「存储空间不足」
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
      title: 'La partición de datos de Android es más pequeña que lo configurado',
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

  /* ---------------- 设置 ---------------- */

  // 方向策略与物理面板打架 → 安卓只给应用中间一条窄画面（记忆 2026-11-18 的老坑）
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

  /* ---------------- 网络 ---------------- */

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

  /* ---------------- 日志 ---------------- */

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

  /* ---------------- 加速 ---------------- */

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

/** 同 code 只留最后一条（后一次检测覆盖前一次） */
function dedupe(issues) {
  const map = new Map();
  for (const raw of issues || []) {
    const it = normalise(raw);
    if (!it) continue;
    map.set(it.code, it);
  }
  return Array.from(map.values());
}

/** 按严重度从高到低排 */
function bySeverity(a, b) {
  const d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (d) return d;
  return String(a.code).localeCompare(String(b.code));
}

/** 汇总：给状态条计数、给设置页分栏 */
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
    // 一眼能看出「有没有必须马上处理的问题」
    health: errors ? 'error' : (warns ? 'warn' : (infos ? 'info' : 'ok')),
  };
}

/** 按分类分组，用于设置页分类渲染 */
function groupByCategory(issues) {
  const list = dedupe(issues).sort(bySeverity);
  return CATEGORIES.map((c) => ({
    ...c,
    items: list.filter((i) => i.category === c.id),
  })).filter((g) => g.items.length);
}

/**
 * 对比两次检测结果：找出「新出现」和「已消失」的问题。
 * 自动检测只在新问题出现时提醒用户，已消失的只做静默记账 ——
 * 每次都弹「已恢复 3 项」会变成噪音。
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
