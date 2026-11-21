'use strict';

const api = window.lanzadorapk;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- Utilidades ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'justo ahora';
  if (d < 3600000) return `${Math.floor(d / 60000)} min`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} h`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} días`;
  return new Date(ts).toLocaleDateString('es');
}

/**
 * Mini toast
 *
 * Deduplicación + límite de cantidad por tipo de mensaje:
 * al fallar una instalación llegan sin parar los «registros de arranque del runtime», y antes cada uno creaba un toast nuevo,
 * así que en pantalla se apilaba el mismo error una y otra vez, como si «el mensaje de error estuviera en bucle».
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① Deduplicación: el mismo título + texto (en 4 s) solo actualiza ese toast, sin apilar
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② Límite: como máximo 4 a la vez; si se supera se quita el más viejo
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- Renderizado ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'Primer uso: abre Configuración (arriba a la derecha) → Runtime → Completar con un clic, y luego vuelve a instalar apps.'
      : 'Consejo: todas las apps comparten el mismo runtime de Android, así que la segunda app abre casi al instante.';
    grid.innerHTML = '';
    return;
  }

  // Al final va una tarjeta punteada «Agregar app».
  // No es solo estética: con pocas apps queda un gran espacio vacío y el usuario no sabe qué hacer;
  // esta tarjeta pone a la vista que «se pueden arrastrar APK», y de paso llena el vacío.
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="En ejecución"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'En ejecución' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Traer al frente' : 'Abrir'}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="Arrastra un archivo APK o haz clic para elegirlo">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">Agregar app</div>
      <div class="meta">Arrastra un APK para instalarlo</div>
    </div>
`;
}

/* ---------------- Actualización de datos ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} apps` : 'Sin apps';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Runtime no instalado: abre Configuración → Runtime y complétalo con un clic';
      tag.textContent = 'Falta instalar';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Runtime listo · Android ${s.android || '?'}${s.freeform ? ' · ventanas independientes activadas' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Arrancando Android…';
      tag.textContent = 'Arrancando';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      // Explica «cómo arreglarlo» y no solo «está desactivado»: esta frase va en el lugar más visible de la barra de estado
      text.textContent = 'Sin aceleración por hardware: se usa emulación por software (muy lenta). Pulsa «Comprobación del entorno → Reparar» abajo a la derecha';
      tag.textContent = 'Emulación por software';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Falta la imagen del sistema Android 14: descárgala en Configuración → Runtime (unos 1,5 GB, una sola vez)';
      tag.textContent = 'Falta la imagen';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'El motor del runtime no está instalado: abre Configuración → Runtime y complétalo con un clic';
      tag.textContent = 'Falta instalar';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'Runtime listo: al instalar un APK o abrir un icono del escritorio, Android arranca solo';
      tag.textContent = 'Listo para arrancar';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'Instalador en ejecución: completa la instalación en la ventana de la máquina virtual';
      tag.textContent = 'Instalando';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'Runtime en espera (arranca solo al instalar o abrir una app)'
        : 'El runtime todavía no tiene Android instalado: abre Configuración → Runtime para continuar';
      tag.textContent = s.installed ? 'En espera' : 'Pendiente de instalar';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // Estado de la red: el problema más común para el usuario (la app dice siempre «error de red» sin que se note que la máquina virtual no tiene red).
    // Va directo en la barra de estado: si hay un problema se ve de un vistazo, sin revisar registros.
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? `Red OK ${s.network.ip || ''}`.trim() : 'La máquina virtual no tiene internet';
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok
          ? 'La máquina virtual Android tiene internet; las apps en línea cargan normalmente'
          : 'La máquina virtual Android no tiene internet; las páginas en línea se quedarán en blanco o con error. Resuélvelo en «Configuración → Reparar red»';
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Error al comprobar el estado: ${e.message}`;
  }
}

/* ---------------- Instalación del runtime (fija en la configuración) ---------------- */

/**
 * Los paneles de runtime/instalación/comprobación ahora están en «Configuración»; la pantalla principal solo muestra las apps instaladas.
 * Se conserva showSetup para que lo reutilicen el menú de la bandeja y ui:navigate; ahora significa «abrir la configuración y ubicarse en el runtime».
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    focusGroup($('runtimeGroup'));
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // Al iniciar se ven las apps instaladas: el asistente de instalación ya no ocupa toda la pantalla principal,
  // y el estado solo aparece en el panel del runtime de la configuración + la barra de estado inferior.
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('Motor');
    if (!imgDone0) missing.push('Imagen del sistema');
    stateText.textContent = s.deviceOnline
      ? `Listo · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Arrancando Android…'
        : allDone0
          ? 'Componentes completos · listo para arrancar (arranca al abrir una app)'
          : `Falta ${missing.join(',')}${accelOk ? '' : ' (sin aceleración por hardware, se usará emulación por software)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // Queda un solo paso: descarga, parámetros adaptativos y arranque, todo encadenado en «Completar con un clic»,
  // y en el primer inicio corre solo en segundo plano, sin que el usuario pulse paso a paso.
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('Herramientas adb');
  if (!emuDone) left.push('Runtime de Android');
  if (!imgDone) left.push('Imagen del sistema');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'Todo listo' : 'Completar con un clic',
    tag: allDone ? 'Completado automáticamente' : 'Automático',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} listo · las ventanas de las apps se ajustan a la pantalla`
      : booting
        ? 'Arrancando Android…'
        : allDone
          ? 'Componentes completos: haz doble clic en cualquier APK o icono del escritorio y Android arrancará solo'
          : `Falta ${left.join(',')}; pulsa «Completar con un clic» abajo y se instalará todo en segundo plano y arrancará solo`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Detener runtime</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Preparando…' : (allDone ? 'Completado · clic para revisar' : 'Completar con un clic');
  // «Por qué no arrancó la última vez» muestra primero el registro de fallo guardado en disco: tras reiniciar el proceso, el diagnosis en memoria está vacío,
  // y mostrar solo autoProfile no dejaría ver la causa (así eran los informes de las issues #20/#25).
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `Último arranque fallido: ${lf.diagnosis.title}`
    : (s.diagnosis ? `Diagnóstico automático del último arranque: ${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Totalmente automático: sin elegir imagen, sin activar aceleración, sin ajustar memoria';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // Los cinco pasos se unieron en una fila; el progreso de todos los subpasos va en esa única barra
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // Una sola llamada instala adb / motor / imagen del sistema; el progreso se muestra en esa única fila
    // Que el usuario pulse «Completar con un clic» es un reintento manual explícito; se salta la espera tras fallos
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: 'Error de preparación', body: (r && r.error) || 'Revisa tu conexión e inténtalo de nuevo', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Componentes listos; arrancando automáticamente…', body: 'La primera vez tarda 1-3 minutos; después, unos segundos.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Runtime listo', body: 'Ahora arrastra un APK a la ventana o haz doble clic en un icono del escritorio.', type: 'ok' }
      : { title: 'El arranque no terminó', body: (started && started.error) || 'Exporta un informe de diagnóstico para ver la causa', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Error de preparación', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'Ya hay una instalación del runtime en curso' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Instalando el controlador de aceleración por hardware…',
        body: 'Pulsa «Sí» en la ventana de permisos que aparece',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Aceleración por hardware activada', type: 'ok' });
      else t.update({ title: 'Aceleración no activada', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Paso desconocido' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'No se pudo iniciar el entorno de instalación', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'Ventana de la máquina virtual abierta', body: 'Sigue los 6 pasos de abajo; al terminar, pulsa «Ya terminé la instalación».', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Instalación completada; el runtime tomó el control', body: 'Ya puedes arrastrar un APK aquí para instalarlo.', type: 'ok' });
}



/* ---------------- Instalación ---------------- */

/** Convierte un fallo de instalación en «qué hacer ahora»; solo da indicaciones para los casos más comunes, el resto se muestra tal cual */
function friendlyInstallErrorText(msg) {
  const s = String(msg || 'Error desconocido');
  if (/INSUFFICIENT_STORAGE|not enough space|空间不足|espacio insuficiente|no queda espacio|ENOSPC/i.test(s)) {
    return `${s}\nLa partición de datos de Android se quedó sin espacio: Configuración → Rendimiento y recursos → aumenta la partición de datos y pulsa «Ampliar ahora».`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}\nEste paquete solo tiene librerías ARM; cambiando a la imagen compatible y reintentando automáticamente.`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\nMismo nombre de paquete pero firma distinta (pasa si se instaló desde otra fuente). Desinstálala con clic derecho en la tarjeta y vuelve a instalar.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\nYa hay una versión más nueva instalada; desinstálala desde el menú contextual y vuelve a instalar.`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\nEl paquete es demasiado grande o falta memoria y el sistema rechazó analizarlo. Comprueba que haya disco y memoria suficientes e inténtalo de nuevo; `
      + 'si sigue fallando, mueve el APK a una ruta corta solo en ASCII (p. ej. D:\\a.apk).';
  }
  return s;
}

/* El aviso fijo actual «Instalando…». El evento install:error debe poder quitarlo:
 * el proceso principal envía primero send('install:error') y luego hace fallar el invoke, y ambos pueden llegar tarde;
 * quitarlo solo en el catch dejaría «hubo un error y abajo a la derecha sigue girando». */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'Ya hay una instalación en curso', body: 'Espera a que termine la instalación actual.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Instalando ${name}`, body: 'Analizando el APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Instalando ${pr.meta.label}` : `Instalando ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} instalada`, body: r.app.shortcutPath ? 'Acceso directo creado en el escritorio; haz doble clic para abrir la app.' : 'Puedes crear un acceso directo con clic derecho en la tarjeta de la app.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} aviso de compatibilidad`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // Primero se quita el aviso fijo «Instalando…»; si no, seguiría girando y actualizándose
      // con los registros del runtime: el usuario vería «el mensaje de error en bucle».
      // El aviso de error lo maneja el oyente install:error de abajo (con nombre de archivo y motivo explicado),
      // así que aquí no se muestra otro.
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- Acciones de apps ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Abriendo ${app ? app.label : pkg}`,
    body: 'El primer arranque necesita preparar el runtime; espera un momento…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // La app tiene su propia ventana y la principal se oculta sola; aquí solo queda un aviso y luego se oculta la ventana
    t.update({ title: 'Iniciada', body: 'La app se ejecuta en su propia ventana (arriba puedes rotar la pantalla).', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Error al iniciar', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Acceso directo creado en el escritorio', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'No se pudo crear el acceso directo', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`¿Desinstalar «${app.label}»?\n\nSe borrarán los datos de la app y su acceso directo en el escritorio.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'Desinstalada', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Error al desinstalar', body: e.message, type: 'error' });
  }
}

/* ---------------- Menú contextual ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Abrir app', kbd: 'Enter' },
  // Solo aparece si la app está realmente en ejecución (ver el filtro en showMenu).
  // Antes esta opción no existía, y en modo de ventana independiente no había un botón de cierre que pulsar:
  // una vez iniciada la app no se podía cerrar, solo salir de todo LanzadorAPK desde la bandeja.
  { key: 'stop', label: 'Cerrar app', onlyRunning: true },
  { key: 'shortcut', label: 'Crear acceso directo en el escritorio' },
  { key: 'orientation', label: 'Horizontal / vertical' },
  { key: 'pin', label: 'Fijar arriba' },
  { key: 'keymap', label: 'Asignación de teclas…' },
  { divider: true },
  { key: 'reveal', label: 'Abrir la ubicación del APK' },
  { key: 'clear', label: 'Borrar datos de la app' },
  { divider: true },
  { key: 'uninstall', label: 'Desinstalar', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Dejar de fijar' : 'Fijar arriba')
      : (it.key === 'orientation'
        ? (app && app.orientationOverride === 'landscape' ? 'Abrir en vertical (ahora: horizontal)'
          : (app && app.orientationOverride === 'portrait' ? 'Abrir en horizontal (ahora: vertical)' : 'Abrir siempre en horizontal'))
        : it.label);
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: 'Cerrada', body: app.label, type: 'ok' });
        } else {
          toast({ title: 'Error al cerrar', body: (r && r.error) || 'Error desconocido', type: 'error' });
        }
      } catch (e) {
        toast({ title: 'Error al cerrar', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'orientation': {
      // Ciclo de tres estados: según la app → horizontal → vertical → según la app
      // Así, una app que el manifiesto marca como vertical se puede forzar a horizontal con un clic, y se recuerda.
      const cur = app.orientationOverride;
      const next = cur === 'landscape' ? 'portrait' : (cur === 'portrait' ? null : 'landscape');
      try {
        const r = await api.setAppOrientation(pkg, next);
        const txt = next === 'landscape' ? 'Abrir en horizontal' : (next === 'portrait' ? 'Abrir en vertical' : 'Según la app');
        toast({ title: `Configurado: ${txt}`, body: 'Se aplica la próxima vez que abras la app; no hace falta reiniciar todo el entorno.', type: 'ok' });
        if (r && typeof r.landscape === 'boolean' && state.apps) {
          const rec = state.apps.find((a) => a.package === pkg);
          if (rec) rec.orientationOverride = next;
        }
      } catch (e) {
        toast({ title: 'No se pudo cambiar la orientación', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'keymap': return showKeymapPicker(pkg, app.label);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`¿Borrar todos los datos de «${app.label}»? Esta acción no se puede deshacer.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'Datos borrados', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Error al borrar', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/**
 * Selector de perfiles de asignación de teclas. Usa confirm + prompt para la interacción más simple (sin componentes de interfaz nuevos).
 * Más adelante se puede hacer un editor emergente más elaborado.
 */
async function showKeymapPicker(pkg, label) {
  try {
    const presets = await api.keymap.getPresets();
    const current = await api.keymap.getMap(pkg);
    const hasCurrent = current && current.length > 0;
    const lines = presets.map((p, i) => `${i + 1}. ${p.label} — ${p.desc}`);
    if (hasCurrent) lines.unshift('0. Quitar la asignación actual');
    const msg = `Elige un perfil de teclas para «${label}»:\n\n${lines.join('\n')}\n\nEscribe el número:`;
    const input = window.prompt(msg, hasCurrent ? '0' : '1');
    if (input === null) return; // Cancelar
    const idx = parseInt(input, 10);
    if (hasCurrent && idx === 0) {
      await api.keymap.setMap(pkg, []);
      toast({ title: 'Asignación de teclas eliminada', body: label, type: 'ok' });
      return;
    }
    const presetIdx = hasCurrent ? idx - 1 : idx;
    if (presetIdx < 1 || presetIdx > presets.length) {
      toast({ title: 'Número no válido', type: 'error' });
      return;
    }
    const chosen = presets[presetIdx - 1];
    await api.keymap.applyPreset(pkg, chosen.id);
    toast({ title: `Se aplicó «${chosen.label}»`, body: `${label} · al abrir la app puedes usar el teclado`, type: 'ok' });
  } catch (e) {
    toast({ title: 'No se pudo configurar la asignación de teclas', body: e.message, type: 'error' });
  }
}

/* ---------------- Configuración ---------------- */

// ---------------- Ajustes del sistema Android ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Leyendo…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Runtime no listo (${String(r.error).slice(0, 36)})` : 'Runtime no iniciado';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi activado' : 'Wi-Fi desactivado'}` +
    `${r.airplane ? ' · modo avión' : ''} · volumen ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Aplicado') : `Error: ${(r && r.error) || 'Runtime no listo'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi activado' : 'Wi-Fi desactivado'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Modo avión activado' : 'Modo avión desactivado'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'Animaciones del sistema activadas' : 'Animaciones del sistema desactivadas; la interfaz va más rápida'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Tamaño de fuente ajustado'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Tamaño de pantalla ajustado'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Volumen ajustado'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Optimizado: animaciones desactivadas, segundo plano menos restringido, lista blanca de batería' : 'Error al optimizar; puede que el runtime no esté iniciado' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Primero abre una app para que arranque el runtime' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  if ($('btnAndroidKeyboard')) $('btnAndroidKeyboard').addEventListener('click', () => open('keyboard'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
  if ($('btnCloseAllApps')) {
    $('btnCloseAllApps').addEventListener('click', async () => {
      const r = await api.closeAllApps().catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) toast({ title: 'Apps cerradas', body: r.closed ? `Se cerraron las apps de Android (${r.closed} revisadas)` : 'No había apps abiertas', type: 'ok' });
      else toast({ title: 'No se pudieron cerrar las apps', body: (r && r.error) || '', type: 'error' });
    });
  }
}

/** Sincronización de campos de la configuración: solo queda el runtime integrado, así que se muestran todos los recursos sin cambiar según el backend */
function syncBackendFields() {
  const perf = $('perfGroup');
  if (perf) perf.hidden = false;
  refreshResources();
}

/** Límite de recursos del equipo + asignación actual (esas líneas grises de la configuración) */
async function refreshResources() {
  const bNote = $('builtinResNote');
  if (!bNote) return;
  const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : 'Desconocido');
  const r = await api.resources().catch(() => null);
  if (!r || r.ok === false) {
    bNote.textContent = (r && (r.note || r.error)) || 'Todavía no se puede leer la asignación de recursos';
    return;
  }
  const host = r.host || {};
  const lim = r.limits || {};
  const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
  bNote.textContent = `Este equipo: ${gb(host.totalMB)} de memoria / ${host.cores} núcleos; `
    + `se pueden asignar hasta ${gb(lim.maxMB)} de memoria y hasta ${Math.max(1, (host.cores || 1) - 1)} núcleos (se reserva 1/4 de la memoria y 1 núcleo para Windows). `
    + `Límite de la partición de datos: ${lim.maxGB || 0} GB${free ? ` (libre en ese disco: ${(free / 1024).toFixed(1)} GB)` : ''}. `
    + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
}

/** Diagnóstico del equipo: renderiza el informe (cada elemento con su punto de nivel y una acción concreta) */
function renderPreflight(res) {
  const list = $('preflightList');
  const sum = $('preflightSummary');
  const applyBtn = $('btnPreflightApply');
  if (!list) return;
  list.textContent = '';
  if (!res || !res.report) {
    if (sum) sum.textContent = (res && res.error) || 'El diagnóstico no devolvió resultados; inténtalo de nuevo';
    return;
  }
  const { report, edition } = res;
  for (const it of report.items) {
    const item = document.createElement('div');
    item.className = 'pf-item';
    const head = document.createElement('div');
    head.className = 'pf-head';
    const dot = document.createElement('span');
    dot.className = `pf-dot ${it.level}`;
    const title = document.createElement('span');
    title.className = 'pf-title';
    title.textContent = it.title;
    head.append(dot, title);
    item.append(head);
    if (it.detail) {
      const d = document.createElement('div');
      d.className = 'pf-detail';
      d.textContent = it.detail;
      item.append(d);
    }
    if (it.action && it.action.kind === 'elevate') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action';
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = it.action.label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = 'Procesando…';
        let r = null;
        if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
        else r = await api.enableVirtualization().catch(() => null);
        btn.disabled = false;
        btn.textContent = old;
        if (!r) { toast({ type: 'error', title: 'La operación no terminó', body: 'Puedes reintentarlo más tarde o seguir las indicaciones manualmente' }); return; }
        if (r.cancelled) toast({ type: 'warn', title: 'Cancelado', body: 'No se cambió la configuración del sistema' });
        else if (r.ok || r.already) {
          const reboot = r.restartNeeded === true;
          toast({
            type: 'ok',
            title: r.already ? 'La aceleración por hardware ya funciona' : (reboot ? 'Enviado; hace falta reiniciar' : 'Aplicado'),
            body: r.already ? '' : (reboot ? 'La aceleración por hardware funcionará después de reiniciar el equipo; luego vuelve y pulsa «Iniciar diagnóstico» para confirmarlo' : 'Pulsa «Iniciar diagnóstico» para confirmar el resultado'),
          });
          if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
        } else {
          toast({ type: 'error', title: 'No se pudo completar automáticamente', body: (r.error || r.note || 'Sigue las indicaciones para hacerlo manualmente') });
        }
      });
      wrap.append(btn);
      item.append(wrap);
    } else if (it.action && it.action.kind === 'manual') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action pf-detail';
      wrap.textContent = `⚠ ${it.action.label}`;
      item.append(wrap);
    }
    list.append(item);
  }
  const rec = report.recommended || {};
  if (sum) {
    sum.textContent = `${report.summary}. Configuración recomendada: ${Math.round((rec.memoryMB || 0) / 1024)} GB de memoria / `
      + `${rec.cores || 2} núcleos / ${rec.renderSize || 'auto'} · renderizado ${rec.gpuMode || 'auto'}`
      + (edition === 'store' ? ' (versión de la Store: las funciones del sistema solo se activan manualmente en «Características de Windows»)' : '');
  }
  if (applyBtn) applyBtn.hidden = false;
}

async function runPreflight() {
  const btn = $('btnPreflight');
  const sum = $('preflightSummary');
  if (!btn) return null;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Diagnosticando…';
  if (sum) sum.textContent = 'Revisando virtualización, tarjeta gráfica, memoria… (la primera vez tarda 2-3 s)';
  let r = null;
  try {
    r = await api.preflightRun();
  } catch (e) {
    r = { error: e.message || 'Error en el diagnóstico' };
  }
  btn.disabled = false;
  btn.textContent = old;
  renderPreflight(r);
  return r;
}

/** Controladores (parches de compatibilidad): renderiza la lista + el estado de coincidencia */
function renderDrivers(r) {
  const list = $('drvList');
  const sum = $('drvSummary');
  if (!list) return;
  const host = (r && r.host) || {};
  const drivers = (r && r.drivers) || [];
  const errors = (r && r.errors) || [];
  const onCount = drivers.filter((d) => d.enabled && d.matched).length;
  if (sum) {
    const accel = host.accel === 'none' ? 'Sin aceleración por hardware' : (host.accel || 'Desconocido');
    sum.textContent = `Este equipo: ${host.platform || ''}/${host.arch || ''} · ${host.gpuVendor || 'Desconocido'} GPU · ${accel}`
      + ` · emulator ${host.emulatorVersion || 'Desconocido'}; controladores: ${drivers.length}, activos en este equipo: ${onCount}. `
      + (errors.length ? ` ${errors.length} archivos no se pudieron cargar (ver abajo).` : '');
  }
  list.textContent = '';
  for (const d of drivers) {
    const item = document.createElement('div');
    item.className = d.enabled ? 'drv-item on' : 'drv-item';

    const head = document.createElement('div');
    head.className = 'drv-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.enabled;
    cb.addEventListener('change', async () => {
      const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
      if (res && res.ok && res.overview) renderDrivers(res.overview);
      else { cb.checked = !cb.checked; toast({ type: 'error', title: 'Error al guardar', body: (res && res.error) || 'Inténtalo más tarde' }); }
    });
    const name = document.createElement('span');
    name.className = 'drv-name';
    name.textContent = d.name;
    head.append(cb, name);

    if (d.matched && d.enabled) {
      const b = document.createElement('span');
      b.className = 'drv-badge hit';
      b.textContent = 'Aplicado';
      head.append(b);
    }
    if (d.builtin) {
      const b = document.createElement('span');
      b.className = 'drv-badge';
      b.textContent = 'Ejemplo integrado';
      head.append(b);
    }
    item.append(head);

    const meta = document.createElement('div');
    meta.className = 'drv-meta';
    meta.textContent = `v${d.version || '?'}`
      + (d.author ? ` · ${d.author}` : '')
      + ` · priority ${d.priority}`
      + (d.hits && d.hits.length ? ` · coincide: ${d.hits.join(' / ')}` : ' · no coincide con este equipo');
    item.append(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'drv-meta';
      desc.textContent = d.description;
      item.append(desc);
    }
    list.append(item);
  }
  for (const e of errors) {
    const err = document.createElement('div');
    err.className = 'drv-err';
    err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}: ${(e.errors || []).join(';')}`;
    list.append(err);
  }
  if (!drivers.length && !errors.length) {
    const empty = document.createElement('div');
    empty.className = 'drv-meta';
    empty.textContent = 'Todavía no hay controladores. Pulsa «Exportar plantilla de este equipo» para crear uno o importa un JSON hecho por otra persona.';
    list.append(empty);
  }
}

async function refreshDrivers() {
  if (!$('drvList')) return;
  const r = await api.driversList().catch(() => null);
  if (!r) {
    if ($('drvSummary')) $('drvSummary').textContent = 'No se pudo leer la lista de controladores (puede que el runtime aún no esté instalado)';
    return;
  }
  renderDrivers(r);
}

function fillSettings(s) {
  syncBackendFields();
  refreshDrivers().catch(() => {});
  $('setAdbPath').value = s.adbPath || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setLocale')) $('setLocale').value = eng.locale || 'es-419';
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setControlBar')) $('setControlBar').value = d.controlBar === false ? 'off' : 'on';
  if ($('setNavButtons')) $('setNavButtons').value = d.navButtons === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
  if ($('setAutoRotate')) $('setAutoRotate').value = d.autoRotate === false ? 'off' : 'on';
  if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
  $('setPortrait').value = d.portrait || '900x1600';
  // Desde 0.6.0 la ventana nativa es el valor por defecto: solo true explícito es modo incrustado (undefined en configuraciones viejas se toma como nativo)
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === true ? 'embed' : 'detached';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** Tamaño real de la partición de datos + espacio libre en disco, mostrado bajo el selector de capacidad de la configuración */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'No se pudo leer la información de la partición de datos'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  // Con el disco diferencial quickboot el tamaño de la imagen base no es la capacidad que ve el invitado (probado: imagen de 8 GB, invitado 5,7 GB);
  // en vez de mostrar un número engañoso, se dice claramente «manda la del runtime».
  const img = info.overlay
    ? 'Disco diferencial de arranque rápido (la capacidad real es la de /data en el runtime)'
    : (info.fsGB ? `Sistema de archivos real ${info.fsGB} GB` : (info.imageGB ? `${info.imageGB} GB` : 'Todavía no creada'));
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'Desconocido';
  const pending = Number(info.pendingGB) > 0
    ? ` objetivo ${info.configuredGB} GB aún no aplicado: Android está usando el disco diferencial de arranque rápido; hay que «Restablecer datos de Android» para recrearlo con la nueva capacidad (se borran las apps instaladas).`
    : '';
  el.textContent = `Partición de datos actual: ${img}${auto ? ' (automático)' : ''} · libre en ese disco: ${free}. ${pending}`
    + 'Si un juego dice «Espacio de almacenamiento insuficiente», aumenta este valor y pulsa «Ampliar ahora»; si se puede ampliar en el sitio, no se pierden las apps instaladas.';
}

/* ---------------- Configuración: navegación por categorías + búsqueda ---------------- */

/**
 * La configuración tiene cada vez más opciones y buscar en una larga lista es pesado (pedido literal de usuarios de la 0.6.0:
 * «organizar la configuración por categorías»). Aquí se divide por uso en 8 categorías, con una columna de navegación a la izquierda.
 *
 * La tabla de categorías debe coincidir con el data-cat de cada grupo en index.html;
 * test/settings-categories-test.js verifica esa coincidencia.
 */
const SETTINGS_CATS = [
  { id: 'basic', name: 'General' },
  { id: 'display', name: 'Pantalla y ventanas' },
  { id: 'input', name: 'Controles' },
  { id: 'perf', name: 'Rendimiento' },
  { id: 'net', name: 'Red y descargas' },
  { id: 'diag', name: 'Diagnóstico' },
  { id: 'files', name: 'Archivos y sistema' },
  { id: 'about', name: 'Actualizaciones' },
];

const settingsCatState = { cat: 'basic', query: '' };

/** Todos los grupos de la configuración con marca de categoría (cuentan .group y details.advanced-group) */
function settingsGroups() {
  return Array.from(document.querySelectorAll('#settingsBody [data-cat]'));
}

/** Si el grupo coincide con la búsqueda: cuentan el título, los nombres de campo y los textos de ayuda */
function groupMatches(group, q) {
  if (!q) return true;
  const text = (group.textContent || '').toLowerCase();
  if (text.includes(q)) return true;
  const title = group.querySelector('.group-title');
  return !!title && title.textContent.toLowerCase().includes(q);
}

/** Cambia a una categoría */
function switchSettingsCat(cat, { keepQuery = false } = {}) {
  const target = SETTINGS_CATS.some((c) => c.id === cat) ? cat : 'basic';
  settingsCatState.cat = target;
  if (!keepQuery) settingsCatState.query = '';
  try { localStorage.setItem('lanzadorapk.settings.cat', target); } catch (_) { /* ignore */ }
  const search = $('setSearch');
  if (search && !keepQuery) search.value = '';
  const clear = $('btnClearSearch');
  if (clear) clear.hidden = !settingsCatState.query;
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    b.classList.toggle('on', b.dataset.cat === target);
  });
  applySettingsFilter();
}

/**
 * Visibilidad: al buscar se muestran los grupos coincidentes de todas las categorías (si no, lo encontrado quedaría oculto en otra categoría
 * y el usuario creería que «la búsqueda no hace nada»); sin búsqueda solo se ve la categoría actual.
 */
function applySettingsFilter() {
  const q = settingsCatState.query.trim().toLowerCase();
  const groups = settingsGroups();
  const hitPerCat = {};
  for (const g of groups) {
    const hit = groupMatches(g, q);
    const inCat = g.dataset.cat === settingsCatState.cat;
    g.hidden = q ? !hit : !inCat;
    if (hit) hitPerCat[g.dataset.cat] = (hitPerCat[g.dataset.cat] || 0) + 1;
  }
  // Botones de categoría: al buscar marcan qué categorías tienen coincidencias
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    const n = hitPerCat[b.dataset.cat] || 0;
    b.classList.toggle('dim', !!q && n === 0);
    b.title = q ? `${n} coincidencias` : '';
  });
  // El último grupo visible no dibuja línea separadora (con grupos ocultos :last-child elegiría mal)
  const visible = groups.filter((g) => !g.hidden);
  visible.forEach((g) => g.classList.remove('last-visible'));
  if (visible.length) visible[visible.length - 1].classList.add('last-visible');
  updateCatBadges();
}

/** Ubica un grupo: primero cambia a su categoría y luego se desplaza hasta él */
function focusGroup(el) {
  if (!el) return;
  const cat = el.dataset && el.dataset.cat;
  if (cat) switchSettingsCat(cat);
  const body = $('settingsBody');
  if (body) body.scrollTop = 0;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function bindSettingsCategory() {
  const nav = $('setNav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.set-nav-item');
      if (!btn) return;
      switchSettingsCat(btn.dataset.cat);
      const body = $('settingsBody');
      if (body) body.scrollTop = 0;
    });
  }

  const search = $('setSearch');
  const clear = $('btnClearSearch');
  if (search) {
    search.addEventListener('input', () => {
      settingsCatState.query = search.value || '';
      if (clear) clear.hidden = !settingsCatState.query;
      applySettingsFilter();
    });
    // Enter: salta al primer grupo coincidente
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const hit = settingsGroups().find((g) => !g.hidden);
      if (hit) focusGroup(hit);
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      settingsCatState.query = '';
      if (search) search.value = '';
      clear.hidden = true;
      applySettingsFilter();
    });
  }

  // Recuerda la última categoría visitada
  try {
    const last = localStorage.getItem('lanzadorapk.settings.cat');
    if (last && SETTINGS_CATS.some((c) => c.id === last)) settingsCatState.cat = last;
  } catch (_) { /* ignore */ }
  switchSettingsCat(settingsCatState.cat);
}

/* ---------------- Comprobación automática (depuración automática) ---------------- */

/** Nombres de categorías de problemas de la comprobación automática (corresponden a CATEGORIES de src/core/autodebug.js) */
const DEBUG_CATS = [
  { id: 'runtime', name: 'Runtime' },
  { id: 'device', name: 'Conexión del dispositivo' },
  { id: 'storage', name: 'Almacenamiento' },
  { id: 'settings', name: 'Configuración' },
  { id: 'network', name: 'Red' },
  { id: 'logs', name: 'Registro' },
];

let autodebugLast = null;

function renderAutodebug(res) {
  const list = $('autodebugList');
  const txt = $('autodebugStateText');
  if (!list) return;
  autodebugLast = res || null;
  const issues = (res && res.issues) || [];
  const at = res && res.at;

  if (txt) {
    if (res && res.running) txt.textContent = 'Comprobando…';
    else if (!at) txt.textContent = 'Sin comprobar';
    else if (!issues.length) txt.textContent = `Última comprobación ${relTime(at)} · todo bien`;
    else txt.textContent = `Última comprobación ${relTime(at)} · ${issues.length} pendientes`;
  }

  if (!issues.length) {
    list.innerHTML = `<div class="dbg-ok">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
      <span>No se encontraron problemas. Se revisaron el runtime, la autorización de adb, el disco, la partición de datos, las instantáneas y los conflictos de configuración.</span>
    </div>`;
    updateCatBadges();
    return;
  }

  const byCat = new Map();
  for (const it of issues) {
    const key = it.category || 'runtime';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  const order = DEBUG_CATS.map((c) => c.id);
  const keys = Array.from(byCat.keys()).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  list.innerHTML = keys.map((key) => {
    const name = (DEBUG_CATS.find((c) => c.id === key) || {}).name || key;
    const items = byCat.get(key);
    return `<div class="dbg-group">
      <div class="dbg-group-title">${esc(name)}<span class="dbg-count">${items.length}</span></div>
      ${items.map((it) => `
        <div class="dbg-item ${esc(it.severity || 'info')}">
          <span class="dbg-sev"></span>
          <div class="dbg-body">
            <div class="dbg-name">${esc(it.title || '')}</div>
            <div class="dbg-hint">${esc(it.hint || '')}</div>
            ${it.detail ? `<div class="dbg-detail">${esc(it.detail)}</div>` : ''}
          </div>
          ${it.fix ? `<button class="dbg-fix" data-code="${esc(it.code)}">Resolver</button>` : ''}
        </div>`).join('')}
    </div>`;
  }).join('');

  list.querySelectorAll('.dbg-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });

  updateCatBadges();
}

/** Insignia de problemas en los botones de categoría: solo muestra el número en las categorías con problemas */
function updateCatBadges() {
  const issues = (autodebugLast && autodebugLast.issues) || [];
  document.querySelectorAll('#setNav .set-nav-badge').forEach((el) => {
    const cat = el.dataset.badge;
    // No todos los problemas de la comprobación pertenecen a una categoría de configuración; solo los de configuración se marcan en «Diagnóstico y reparación»
    const n = cat === 'diag' ? issues.filter((i) => i.severity === 'error').length : 0;
    el.hidden = n === 0;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('warn', false);
  });
}

function bindAutodebug() {
  const btn = $('btnAutodebugRun');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Comprobando…';
      try {
        const r = await api.autodebugRun().catch(() => null);
        if (r) renderAutodebug(r);
        else toast({ title: 'Error en la comprobación', body: 'Error al recopilar el estado; inténtalo de nuevo más tarde', type: 'error' });
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  const report = $('btnAutodebugReport');
  if (report) {
    report.addEventListener('click', async () => {
      const r = await api.doctorReport().catch(() => null);
      if (r && r.ok !== false) toast({ title: 'Informe de diagnóstico exportado', body: 'Envía el informe al equipo de soporte para localizar el problema más rápido', type: 'ok' });
      else toast({ title: 'Error al exportar', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
    });
  }

  const auto = $('setAutodebugAuto');
  if (auto) {
    auto.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ auto: auto.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({
        title: auto.checked ? 'Comprobación automática activada' : 'Comprobación automática desactivada',
        body: auto.checked ? 'Se revisará periódicamente en segundo plano y solo avisará si hay problemas nuevos' : 'Puedes pulsar «Comprobar ahora» cuando quieras',
        type: 'info',
      });
    });
  }

  const interval = $('setAutodebugInterval');
  if (interval) {
    interval.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ intervalMin: Number(interval.value) }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({ title: 'Intervalo de comprobación actualizado', body: `Cada ${r ? r.intervalMin : interval.value} minutos`, type: 'ok' });
    });
  }

  const notify = $('setAutodebugNotify');
  if (notify) {
    notify.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ notify: notify.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
    });
  }
}

function fillAutodebugSettings(cfg) {
  if (!cfg) return;
  const auto = $('setAutodebugAuto');
  if (auto) auto.checked = cfg.auto !== false;
  const interval = $('setAutodebugInterval');
  if (interval) interval.value = String(cfg.intervalMin || 10);
  const notify = $('setAutodebugNotify');
  if (notify) notify.checked = cfg.notify !== false;
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  fillAutodebugSettings((state.settings && state.settings.debug) || {});
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Asociado · clic para quitar' : 'No asociado · clic para activar';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Modo automático'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Total ${u.totalText}${u.reclaimable ? ` · recuperable ${u.reclaimableText} (${u.count} elementos)` : ' · ya está optimizado'}`
      : 'Estadísticas no disponibles';
  }).catch(() => { $('usageText').textContent = 'Estadísticas no disponibles'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
  applySettingsFilter();
  // Primero se muestra el resultado de la comprobación anterior (para que el panel no quede vacío esperando) y luego se actualiza en segundo plano
  api.autodebugState().then((r) => { if (r) renderAutodebug(r); }).catch(() => {});
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- Actualizaciones ---------------- */

let lastUpdate = null;

/** Dibuja en la configuración el resultado de una búsqueda (también para el estado que envía la comprobación silenciosa al iniciar) */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Error en la comprobación: ${info.error || 'Red no disponible'}`;
    // Si la búsqueda falla también hay que dar una salida: se abre la página de versiones y el usuario al menos puede descargar a mano.
    // Antes aquí «no se mostraba nada» y el usuario solo pensaba que «la actualización está rota».
    showUpdateBtn(true);
    btn.textContent = 'Abrir página de descarga';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // Se dice con honestidad qué fuente dio la versión y por qué otra no participó;
    // al investigar «por qué la búsqueda de actualizaciones es lenta», esta línea es más directa que cualquier registro.
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join(',');
    const stale = info.stale ? ' (caché sin conexión, puede no estar actualizada)' : '';
    st.textContent = `Nueva versión disponible ${info.tag}${src ? ` (${src})` : ''}${bad ? `; ${bad} no accesible` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Actualizar ahora' : 'Abrir página de descarga';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `Novedades:\n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? ' (caché sin conexión)' : '';
    st.textContent = `Ya tienes la última versión (v${info.current}) ${src ? ` · vía ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn trae display:inline-flex, que anula el atributo hidden, así que aquí se cambia display directamente */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Error al actualizar: ${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Error al actualizar', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Actualizando…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Comprobando…';
      $('updateState').textContent = 'Conectando con GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `Nueva versión disponible ${info.tag}`, body: 'Pulsa «Actualizar ahora» para descargar e instalar automáticamente', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'Ya tienes la última versión', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Error en la comprobación: ${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Actualizando…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Actualizar ahora';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Error al actualizar: ${r.error}`;
        toast({ title: 'Error al actualizar', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Descargada la v${r.version}; reiniciando para terminar la instalación…`;
    }
  });

  // Si al abrir la configuración aún no hay resultado, se busca de paso (en segundo plano, sin molestar)
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
  if ($('btnPreflightApply')) {
    $('btnPreflightApply').addEventListener('click', async () => {
      const btn = $('btnPreflightApply');
      btn.disabled = true;
      const r = await api.preflightApply().catch(() => null);
      btn.disabled = false;
      if (!r || !r.ok) {
        toast({ type: 'error', title: 'Error al aplicar', body: (r && r.error) || 'Inténtalo más tarde' });
        return;
      }
      state.settings = r.settings;
      toast({
        type: 'ok',
        title: 'Configurado para este equipo',
        body: `Memoria ${Math.round((r.recommended.memoryMB || 0) / 1024)} GB / ${r.recommended.cores} núcleos / ${r.recommended.renderSize}`
          + (r.driverFile ? '; controlador generado, se aplicará en el próximo arranque' : ''),
      });
      if (r.driverError) toast({ type: 'warn', title: 'No se pudo guardar el controlador', body: r.driverError });
      fillSettings(r.settings);
      refreshStatus();
    });
  }
  if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
  if ($('btnDrvFolder')) {
    $('btnDrvFolder').addEventListener('click', async () => {
      const r = await api.driversOpenFolder().catch(() => null);
      if (!r || !r.ok) toast({ type: 'error', title: 'No se pudo abrir la carpeta de controladores' });
    });
  }
  if ($('btnDrvImport')) {
    $('btnDrvImport').addEventListener('click', async () => {
      const r = await api.driversImport().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast({ type: 'error', title: 'Error al importar', body: (r.errors || []).slice(0, 3).join(';') });
        return;
      }
      toast({ type: 'ok', title: 'Controlador importado y activado', body: `${r.driver.name} v${r.driver.version}` });
      if (r.overview) renderDrivers(r.overview);
    });
  }
  if ($('btnDrvExport')) {
    $('btnDrvExport').addEventListener('click', async () => {
      const r = await api.driversExportTemplate().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) { toast({ type: 'error', title: 'Error al exportar' }); return; }
      toast({ type: 'ok', title: 'Plantilla exportada', body: 'Edita «effect», colócalo en la carpeta de controladores y pulsa «Actualizar»' });
      refreshDrivers();
    });
  }

  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // Memoria / núcleos: con un valor concreto se desactiva «automático»; con 0 vuelve a automático.
  // El código anterior solo escribía memoryMB, y overridesFromSettings solo lo aceptaba con autoMemory=false,
  // así que «puse la memoria a mano» siempre se ignoraba: la opción de la configuración que más parecía «no servir».
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // La estrategia de recursos cambia también liteMode / priorityMode / renderSize (lo traduce el proceso principal)
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Estrategia de recursos cambiada', body: 'Se aplica la próxima vez que abras una app', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setLocale')) {
    $('setLocale').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { locale: e.target.value } });
      toast({ title: 'Idioma del sistema actualizado', body: 'Se aplica al reiniciar el runtime de Android', type: 'ok' });
    });
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Primero elige una capacidad', body: '«Automático» significa que el programa decide según el espacio libre; no hace falta ampliar', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: '¿Ampliar ahora la partición de datos de Android?',
        message: `/data pasará a ${gb} GB (ampliación en el sitio; se conservan las apps y partidas guardadas).`,
        detail: 'Para ampliar hay que cerrar las apps de Android abiertas; después, la próxima app tardará unos segundos más en arrancar.',
        okLabel: 'Ampliar',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Ampliando…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      if (r && !r.ok && r.needsReset) {
        // El disco diferencial de arranque rápido lo impide: no se puede ampliar en el sitio, solo recrear /data con la nueva capacidad.
        // Es una operación que pierde datos; hay que confirmarla aparte.
        const again = await api.confirm({
          title: 'Hay que restablecer los datos de Android para ampliar',
          message: `Android usa el disco diferencial de arranque rápido y la ampliación en el sitio no lo alcanza. Para tener ${gb} GB hay que recrear /data con la nueva capacidad.`,
          detail: 'Recrearlo borra las apps instaladas y las partidas guardadas (el emulador y las imágenes no se tocan). ¿Continuar?',
          okLabel: 'Borrar y recrear',
        });
        if (again.response !== 1) { refreshDataInfo(); return; }
        $('btnGrowData').disabled = true;
        $('btnGrowData').textContent = 'Recreando…';
        const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
        $('btnGrowData').disabled = false;
        $('btnGrowData').textContent = old;
        toast({
          type: rr && rr.ok ? 'ok' : 'error',
          title: rr && rr.ok ? 'Recreada con la nueva capacidad' : 'Error al recrear',
          body: rr && rr.ok
            ? `La próxima vez que abras una app se recreará /data con ${gb} GB (la primera entrada tardará unos segundos más)`
            : (rr && rr.error) || 'Error desconocido',
        });
        refreshDataInfo();
        return;
      }
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Partición de datos ampliada' : 'Error al ampliar',
        body: r && r.ok ? `Ahora hay unos ${r.fsGB || r.imageGB || gb} GB disponibles` : (r && r.error) || 'Error desconocido',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // Se instala/quita el gancho enseguida según el foco de la ventana actual, sin esperar al próximo cambio de ventana
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  if ($('setKeymapEnabled')) {
    $('setKeymapEnabled').addEventListener('change', async (e) => {
      await api.keymap.setEnabled(e.target.checked);
      toast({ title: e.target.checked ? 'Asignación de teclado activada' : 'Asignación de teclado desactivada', type: 'ok' });
    });
  }
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // Al desactivar el recorte profundo hay que restaurar los paquetes desactivados con pm disable-user; si no, el efecto es permanente
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'Componentes del sistema restaurados', body: 'Recorte profundo desactivado; restaurando paquetes en segundo plano', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'Modo de compatibilidad ARM activado', body: 'Falta descargar la imagen compatible con Google Play (Android 14, unos 1,5 GB); pulsa el botón de abajo para empezar', type: 'info' });
    else if (on) toast({ title: 'Modo de compatibilidad ARM activado', body: 'Se aplica al reiniciar el runtime', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Pantalla completa activada' : 'Cambiado a ventana vertical', type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? 'Pantalla completa automática activada' : 'Pantalla completa automática desactivada', body: 'Se aplica la próxima vez que abras una app', type: 'ok' });
    });
  }
  if ($('setControlBar')) {
    $('setControlBar').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { controlBar: on } });
      toast({ title: on ? 'Barra de controles activada' : 'Barra de controles oculta', body: 'Se aplica la próxima vez que abras una app', type: 'ok' });
    });
  }
  if ($('setNavButtons')) {
    $('setNavButtons').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      const r = await api.android.navButtons(on).catch((err) => ({ ok: false, error: err.message }));
      state.settings = await api.getSettings();
      if (r && r.applied) toast({ title: on ? 'Botones de navegación activados' : 'Navegación por gestos activada', type: 'ok' });
      else if (r && r.ok) toast({ title: 'Guardado', body: 'Se aplica la próxima vez que arranque Android', type: 'ok' });
      else toast({ title: 'No se pudo cambiar la navegación', body: (r && r.error) || '', type: 'error' });
    });
  }
  if ($('setOrientationMode')) {
    $('setOrientationMode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      state.settings = await api.setSettings({ display: { orientationMode: mode } });
      toast({
        title: mode === 'auto' ? 'Configurado según la app' : (mode === 'landscape' ? 'Horizontal forzado' : 'Vertical forzado'),
        body: mode === 'auto'
          ? 'La próxima vez que abras una app se elegirá la orientación de la propia app; si no coincide, el runtime se reiniciará una vez.'
          : 'La próxima vez que abras una app el runtime se reiniciará una vez para cambiar a la orientación elegida; después ya no se reinicia.',
        type: 'ok',
      });
    });
  }
  if ($('setAutoRotate')) {
    $('setAutoRotate').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoRotate: on } });
      toast({
        title: on ? 'Rotación automática de la imagen activada' : 'Rotación automática de la imagen desactivada',
        body: 'Se aplica a la imagen de Android la próxima vez que abras una app. La orientación sigue dependiendo de la estrategia de orientación, no de este interruptor.',
        type: 'ok',
      });
    });
  }
  if ($('setTabletMode')) {
    $('setTabletMode').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { tabletMode: on } });
      toast({
        title: on ? 'Diseño de tableta activado' : 'Diseño de tableta desactivado',
        body: 'Se aplica la próxima vez que abras una app (el runtime se reinicia una vez para cambiar la densidad).',
        type: 'ok',
      });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? 'Pantalla fijada en horizontal' : 'Pantalla fijada en vertical',
        body: 'La próxima vez que abras una app el runtime se reiniciará una vez para cambiar la orientación física de la pantalla (unos segundos); después ya no se reinicia.',
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Tamaño de imagen actualizado', body: 'Se aplica la próxima vez que abras o cambies de app', type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    // windowEmbedChosen marca que «el usuario lo eligió»: las actualizaciones posteriores ya no lo sobrescriben con la migración del valor por defecto.
    state.settings = await api.setSettings({
      display: { windowEmbed: embed, windowEmbedChosen: true },
    });
    toast({
      title: embed ? 'Cambiado al modo incrustado' : 'Cambiado a ventana nativa',
      body: embed
        ? 'Se aplica la próxima vez que abras una app. El modo incrustado se ve más uniforme y tiene botón de rotación en la barra de título, pero al redimensionar o rotar puede perder fotogramas o mostrar bordes negros.'
        : 'Se aplica la próxima vez que abras una app. La ventana nativa la dibuja el propio emulador: fotogramas y escalado más estables; en horizontal usa el menú de la bandeja o Ctrl+Alt+R.',
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Accesos directos completados' : 'Los accesos directos siguen ahí',
      body: r && r.fixed && r.fixed.length ? r.fixed.join(',') : 'Los accesos del escritorio y del menú Inicio están bien',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Informe de diagnóstico exportado', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Error al exportar', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'Ya está optimizado', body: 'No hay imágenes ni instantáneas antiguas que recuperar.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Limpieza completada',
        body: `Se liberaron unos ${(r.saved / 1048576).toFixed(0)} MB (${r.removed.length} elementos); las apps instaladas se conservan.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · recuperable ${u.reclaimableText} (${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error al limpiar', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Restablecer datos de Android: doble confirmación (primero la intención, luego que es irreversible); al terminar se actualizan las estadísticas de uso
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: '¿Restablecer los datos de Android?',
        message: 'Android volverá al estado limpio de «recién instalado»:',
        detail: '• Se borran todas las apps de terceros instaladas (incluidos juegos) con sus datos y sesiones iniciadas\n'
          + '• Se borran las instantáneas de arranque rápido del AVD actual\n'
          + '• La imagen del sistema no se toca; al volver a abrir una app hará un arranque en frío para recrear los datos\n\n'
          + 'Esta acción no se puede deshacer. ¿Continuar?',
        buttons: ['Cancelar', 'Continuar'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Confirma de nuevo',
        message: 'Las apps instaladas y sus datos se borrarán para siempre. ¿Seguro que quieres restablecer?',
        detail: 'Tranquilo: la imagen del sistema, otros AVD, la caché de APK de este equipo y los iconos no se tocan.',
        buttons: ['Cancelar', 'Sí, restablecer'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Error al restablecer', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      toast({
        title: 'Datos de Android restablecidos',
        body: `Se liberaron unos ${r.reclaimedMB} MB; se vació el registro de apps instaladas.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · recuperable ${u.reclaimableText} (${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error al restablecer', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Reparar red: para cuando las páginas en línea de Android se quedan siempre en negro (por ejemplo, pantalla negra tras «aceptar y continuar»).
  // La causa es que la configuración Wi-Fi en /data de la máquina virtual se dañó: wlan0 no arranca y no hay ruta por defecto.
  // La imagen Play Store no permite root; solo se puede restablecer /data entero; la lista de apps se conserva y se reinstalan al abrirlas.
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: '¿Reparar la red de la máquina virtual?',
        message: 'Si las páginas en línea de las apps se quedan en negro o cargando, normalmente la máquina virtual Android no tiene red.',
        detail: 'La reparación prueba en orden, de menor a mayor impacto:\n\n'
          + '1. Arranque en frío de la máquina virtual (sin instantánea) y espera a la red; no afecta ningún dato\n'
          + '2. Si sigue sin funcionar, restablece los datos de Android; la lista de apps se conserva y se reinstalan al abrirlas,\n'
          + '   pero se pierden las sesiones iniciadas y el progreso dentro de las apps\n\n'
          + 'Solo afecta al AVD actual; la imagen del sistema y la caché de APK no se tocan. Tarda de 1 a 5 minutos. ¿Continuar?',
        buttons: ['Cancelar', 'Iniciar reparación'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'La red sigue sin funcionar',
          body: (r && r.error) || 'Tras restablecer, la máquina virtual sigue sin red; revisa si la red o el firewall de este equipo bloquean el emulador.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'Red restablecida',
        body: `${(r.network && r.network.ip) || 'Conectada'}${r.wiped ? ' (se restablecieron los datos de Android para reparar la red; las apps se reinstalan al abrirlas)' : ' (tus datos no se tocaron)'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Error al reparar', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Limpiar restos de versiones anteriores: analiza carpetas viejas / entradas de desinstalación obsoletas / temporales de actualización y los borra todos tras confirmar.
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Error al analizar', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'Todo limpio', body: 'No quedan restos de versiones anteriores.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}: ${x.path}`);
      if (items.length > 8) lines.push(`…y otros ${items.length - 8} elementos`);
      const ok = await api.confirm({
        type: 'warning',
        title: '¿Limpiar restos de versiones anteriores?',
        message: `Se encontraron ${items.length} restos, unos ${mb} MB:`,
        detail: `${lines.join('\n')}\n\nSolo se borran «carpetas de versiones antiguas / entradas de desinstalación obsoletas / archivos temporales de actualización»; `
          + 'la versión en uso y los datos de tus apps no se tocan.',
        buttons: ['Cancelar', 'Limpiar'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Error al limpiar', body: (c && c.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `, ${c.failed.length} en uso, no se borraron` : '';
      toast({
        title: 'Restos de versiones anteriores eliminados',
        body: `Se borraron ${c.removed.length} elementos y se liberaron ${c.freedMB || 0} MB${failNote}.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · recuperable ${u.reclaimableText} (${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error al limpiar', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // Recrear accesos directos: acceso de respaldo cuando se borraron los iconos del escritorio / los bloqueó un programa de seguridad
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Accesos directos recreados', body: fixed.join(','), type: 'ok' }
        : { title: 'Los accesos directos están completos', body: 'No hay accesos que recrear', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // Carpeta compartida: primero se elige la carpeta y luego «Guardar y migrar» mueve los archivos viejos a la nueva de una vez
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'Nueva carpeta elegida', body: 'Pulsa «Guardar y migrar» para mover los archivos antiguos', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Primero escribe o busca una carpeta', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Carpeta compartida actualizada', body: moved ? 'Los archivos de la carpeta anterior se movieron a la nueva' : 'Guardado', type: 'ok' });
    } else {
      toast({ title: 'Error al guardar', body: r.error, type: 'error' });
    }
  });

  // Desinstalar LanzadorAPK con un clic (quita la asociación .apk + inicia el desinstalador; en la versión portátil se borra a mano)
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('¿Desinstalar Lanzador APK?\n\nSe quitará la asociación de archivos .apk y se eliminará el programa. Esta acción no se puede deshacer.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'La versión portátil no se puede desinstalar automáticamente',
        body: `Borra manualmente la carpeta del programa (${r.exeDir}) y la carpeta de datos (${r.dataDir})`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Error al desinstalar', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Desinstalando…', body: 'Desinstalador iniciado; Lanzador APK se cerrará', type: 'ok', sticky: true });
  });

  // Descarga de la imagen compatible con ARM (con toast de progreso)
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Iniciando la descarga de la imagen compatible con ARM', body: 'Preparando…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Descargando la imagen compatible con ARM', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'Imagen compatible con ARM lista', body: 'Se aplica al reiniciar el runtime', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Error al descargar la imagen compatible', body: (r && r.error) || 'Error desconocido', progress: null });
        t.dismiss();
        toast({ title: 'Error al descargar la imagen compatible', body: (r && r.error) || 'Error desconocido', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Error al descargar la imagen compatible', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // Muestra el estado de la imagen compatible
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Lista (${(env.playImage.size / 1073741824).toFixed(2)} GB)` : 'No descargada';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Carpeta de datos actualizada', body: 'Reinicia Lanzador APK para aplicar el cambio (los datos antiguos no se mueven solos)', type: 'ok', sticky: true });
  });

  // Carpeta de datos de Android (AVD + instantáneas): lo que realmente llena el disco; se puede apuntar aparte a otro disco
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Carpeta de datos de Android actualizada',
        body: 'Reinicia Lanzador APK para aplicar el cambio. Puedes mover la carpeta lanzadorapk.avd de la ubicación anterior a la nueva y luego borrar la antigua.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Iniciando…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Listo: ${r.engine}` : `Error al iniciar: ${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Máquina virtual integrada detenida';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'No asociado · clic para activar';
      btn.dataset.on = '0';
      toast({ title: 'Asociación de .apk eliminada' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Asociado · clic para quitar';
      btn.dataset.on = '1';
      toast({ title: 'Asociación de .apk activada', body: r.ok ? 'Ahora al hacer doble clic en un APK se instala en Lanzador APK' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- Enlace de eventos ---------------- */

function bindEvents() {
  // Los enlaces siempre van al navegador del sistema
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // La etiqueta de estado también es un acceso: pulsar «Falta instalar / Arrancando / Android 14» abre el panel del runtime en la configuración
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // Instalación del runtime: el acceso ya está en la configuración; aquí solo se manejan los botones del panel
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // El contador de la comprobación en la barra de estado: al pulsarlo abre el panel del runtime en la configuración
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) focusGroup(box);
      else focusGroup($('runtimeGroup'));
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'La operación falló', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'Imagen del sistema importada', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Error al importar', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Disco virtual importado', body: 'Ya puedes iniciar el runtime', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Error al importar', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Iniciando el runtime…', body: 'El primer arranque necesita iniciar el sistema Android', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Runtime listo', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Error al iniciar', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'La sesión del runtime terminó' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // El acceso a la carpeta compartida pasó a la configuración: sincronizar + abrir están en el grupo «Compartir archivos»
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Carpeta compartida sincronizada', type: 'ok' });
    } catch (_) {
      toast({ title: 'Error al sincronizar', body: 'Si el runtime no está listo, la sincronización se omite', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // La tarjeta «Agregar app» no tiene data-pkg: sigue el flujo de instalación, no el de inicio.
    // Llama directamente al botón «Instalar APK» de la barra de herramientas, reutilizando su lógica de selección de archivos.
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // Instalación arrastrando y soltando
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Solo se pueden arrastrar archivos .apk', type: 'error' });
  });

  // Eventos del proceso principal
  api.on('install:error', (p) => {
    // Si hubo un error, «Instalando…» no debe seguir girando (puede venir de otra ruta, como el doble clic en un APK)
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    toast({
      title: name ? `Error al instalar: ${name}` : 'Error al instalar',
      body: friendlyInstallErrorText((p && p.message) || 'Error desconocido'),
      type: 'error',
    });
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // Al cerrar una app («Cerrar la aplicación actual» de la bandeja, el menú contextual o cerrando la ventana) hay que actualizar la marca «En ejecución»
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // La información de actualización llega 8 s después de iniciar: si la tarjeta de bienvenida sigue abierta, se agrega «Nueva versión disponible»
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
  // Comprobación automática: cuando el proceso principal termina una ronda envía el resultado, y si la configuración está abierta se actualiza el panel directamente
  api.on('autodebug:state', (r) => {
    if (r && r.running) {
      const txt = $('autodebugStateText');
      if (txt) txt.textContent = 'Comprobando…';
      return;
    }
    renderAutodebug(r);
  });
}

/* ---------------- Inicio ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindSettingsCategory();
  bindAutodebug();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- Tarjeta de bienvenida ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'Buenas noches';
  if (h < 11) return 'Buenos días';
  if (h < 13) return 'Buenas tardes';
  if (h < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** Decide si se muestra: con inicio automático siempre; abierta a mano, como mucho una vez al día, y el usuario puede desactivarla para siempre */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // En las capturas de prueba no se muestra la tarjeta de bienvenida; si no, taparía la pantalla principal en cada captura automática
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, bienvenido de nuevo`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `Lanzador APK${ver ? ` v${ver}` : ''} · ${ready ? 'Runtime listo: abre y usa' : 'El runtime se prepara automáticamente cuando hace falta'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'Apps instaladas' },
    { k: ready ? 'Listo' : 'En espera', v: 'Runtime de Android' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'Dispositivo / puerto' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** La zona de consejos se renderiza aparte: la información de actualización llega 8 s después de iniciar, cuando la tarjeta puede seguir abierta, y hay que completarla */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`Nueva versión disponible <b>${esc(lastUpdate.tag || '')}</b>; actualízala con un clic en «Configuración → Actualizaciones»`);
  }
  if (!apps) {
    tips.push('Arrastra un APK a la ventana para instalarlo; se crea el icono del escritorio automáticamente');
  } else {
    tips.push('Haz doble clic en una tarjeta para abrir la app en su propia ventana; arriba a la derecha puedes rotar, ajustar el tamaño o cerrar');
  }
  tips.push('Cerrar la ventana solo sale de esa app; Android sigue preparado y la próxima vez abre más rápido');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- Comprobación del entorno ---------------- */

let envBusy = false;

/** Obtiene doctor:selfCheck: muestra los problemas en el panel de comprobación de la configuración y deja un contador en la barra de estado */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* Un fallo de la comprobación no bloquea el flujo principal */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // «Componentes faltantes» ya lo cubre el «Completar con un clic» del mismo panel; no se lista otra vez
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // La pantalla principal ya no tiene aviso grande: solo un contador pulsable en la barra de estado inferior, que abre el panel de comprobación de la configuración
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} por reparar` : `${issues.length} avisos`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join(';');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>La comprobación del entorno pasó: no hay problemas que afecten el funcionamiento.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Volver a comprobar</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">Comprobación del entorno</span>
${errs ? `<span class="ec-count">${errs} graves</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} avisos</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Volver a comprobar</button>
      <button class="btn primary sm" id="btnEnvFixAll">Reparar todo</button>
    </div>
    <div class="env-check-list">
${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Reparar</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/es-es/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'No se encontró el instalador incluido', body: 'Se abrió la página oficial de descarga de Microsoft; descarga la versión x64', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'Microsoft Visual C++ Redistributable instalado', type: 'ok' }
        : { title: 'La instalación no terminó', body: r.error || 'Inténtalo de nuevo', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Activando la aceleración por hardware…', body: 'Pulsa «Sí» en la ventana que aparece', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Aceleración por hardware activada', body: r.restartNeeded ? 'Reinicia el equipo para obtener el mejor rendimiento' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else if (r.manual) {
        // Versión de la Store (MSIX): el paquete va fijo en mediumIL y normalmente no obtiene elevación.
        // En vez de ofrecer un botón condenado a fallar, se abre directamente el diálogo «Activar o desactivar las características de Windows»
        // y se le dice qué marcar.
        t.dismiss();
        await api.openWindowsFeatures?.().catch(() => null);
        toast({
          title: 'Hay que activarlo manualmente (solo esta vez)',
          body: r.note || 'En la ventana que se abrió marca «Plataforma del hipervisor de Windows», acepta y reinicia el equipo.',
          type: 'info',
          sticky: true,
        });
      } else if (r.cancelled) {
        t.update({ title: 'Cancelado', body: r.error || 'No se obtuvo autorización de administrador; la aceleración por hardware no cambió.', type: 'info', spinner: false });
        setTimeout(t.dismiss, 4200);
      } else {
        t.update({ title: 'No se pudo activar', body: r.error || r.note || 'Inténtalo de nuevo', type: 'error', sticky: true });
      }
      break;
    }
    case 'disk': {
      // El proceso principal muestra un diálogo nativo de confirmación (con vista previa del espacio a liberar); aquí no se repite el confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Error al limpiar', body: 'Inténtalo de nuevo', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Limpieza completada', body: `Se liberaron unos ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'Usa una carpeta con nombre solo en ASCII', body: 'Cámbiala en Configuración → Integración con el sistema → «Carpeta de datos del runtime» y reinicia el programa.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Completando los componentes del runtime que faltan…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Archivos de bloqueo restantes eliminados', type: 'ok' } : { title: 'Error al limpiar', body: r.error, type: 'error' });
      break;
    }
    // ---- Acciones de reparación nuevas de la comprobación automática ----
    case 'restartRuntime': {
      // Acción de autocorrección preferida para unauthorized / arranque colgado / bloqueos huérfanos: detener y volver a lanzar (arranque en frío)
      const t = toast({ title: 'Reiniciando el runtime de Android…', body: 'Se iniciará de nuevo, tarda unos segundos', type: 'info', sticky: true, spinner: true });
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok) {
        t.update({ title: 'Runtime de Android reiniciado', body: 'En la ventana de autorización pulsa «Permitir»', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        t.update({ title: 'Error al reiniciar', body: (r && r.error) || 'Revisa el informe de diagnóstico', type: 'error' });
      }
      break;
    }
    case 'orphans': {
      const r = await api.clearOrphans().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: 'Procesos del emulador restantes eliminados', type: 'ok' }
        : { title: 'Error al limpiar', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
      break;
    }
    case 'snapshots': {
      const r = await api.clearSnapshot().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: 'Instantánea de arranque rápido invalidada', body: 'La próxima vez que abras una app hará un arranque en frío completo', type: 'ok' }
        : { title: 'Error al invalidar', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
      break;
    }
    case 'dataReset': {
      // Si el disco diferencial bloquea la ampliación hay que recrear: se borran las apps instaladas, así que solo se guía, no se hace automáticamente.
      toast({
        title: 'Hay que recrear la partición de datos de Android',
        body: 'Ve a «Configuración → Rendimiento y recursos» y pulsa «Ampliar ahora»; si pide restablecer, confirma (se borran las apps instaladas).',
        type: 'info',
        sticky: true,
      });
      openSettings().then(() => focusGroup($('perfGroup'))).catch(() => {});
      break;
    }
    case 'orientation': {
      // Que la orientación de la pantalla física siga a la estrategia: si pide horizontal se cambia a horizontal, si pide vertical a vertical
      const s = (state.settings && state.settings.display) || {};
      const mode = s.orientationMode || 'auto';
      if (mode === 'auto') {
        toast({ title: 'Ahora está en «Según la app»', body: 'La orientación cambia según cada app; si una app sale con la orientación incorrecta, puedes fijarla solo para ella.', type: 'info' });
        break;
      }
      const wantLandscape = mode === 'landscape';
      state.settings = await api.setSettings({ display: { landscape: wantLandscape } });
      fillSettings(state.settings);
      toast({
        title: wantLandscape ? 'Pantalla cambiada a horizontal' : 'Pantalla cambiada a vertical',
        body: 'Se aplica la próxima vez que abras una app',
        type: 'ok',
      });
      break;
    }
    case 'shared': {
      toast({ title: 'Revisa la carpeta compartida', body: 'En «Configuración → Integración y archivos» confirma que la carpeta compartida de este equipo existe y se puede escribir.', type: 'info', sticky: true });
      openSettings().then(() => focusGroup(document.querySelector('#settingsBody [data-cat="files"]'))).catch(() => {});
      break;
    }
    case 'repairNetwork': {
      const t = toast({ title: 'Restableciendo la red de Android…', body: 'La lista de apps se conserva', type: 'info', sticky: true, spinner: true });
      const r = await api.runtimeRepairNetwork().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: 'Red de Android restablecida', body: 'La próxima vez que abras una app se volverá a conectar', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        t.update({ title: 'Error al restablecer', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
      }
      break;
    }
    case 'report': {
      const r = await api.doctorReport().catch(() => null);
      toast(r && r.ok !== false
        ? { title: 'Informe de diagnóstico exportado', body: 'Envía el informe al equipo de soporte para localizar el problema más rápido', type: 'ok' }
        : { title: 'Error al exportar', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
      break;
    }
    case 'settings': {
      openSettings();
      break;
    }
    default:
      toast({ title: 'Todavía no se puede reparar automáticamente', body: issue.hint || '', type: 'info' });
  }
  // Tras reparar se vuelve a comprobar y se actualizan el aviso y el estado
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Error de inicialización', body: e.message, type: 'error', sticky: true });
});
