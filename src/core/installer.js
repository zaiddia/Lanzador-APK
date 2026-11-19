'use strict';
/**
 * Capa de orquestación de instalar / iniciar / desinstalar
 * Encadena «analizar el APK → instalar en el runtime → guardar metadatos locales → crear el acceso directo en el escritorio» en un solo flujo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName, shortcutExt } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** El APK solo tiene librerías nativas ARM (muchas apps son así) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Paquetes divididos (.apks / .xapk): extrae los APK de sus partes a una carpeta temporal solo ASCII.
 * Usa el lector ZIP por archivo + escritura en flujo: los paquetes divididos superan fácilmente 2 GB y cargarlos enteros en memoria falla.
 * Devuelve { meta, files, cleanup }; meta sale del APK base que tiene el AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'lanzadorapk-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('No se encontraron APK divididos en este paquete (puede que no sea .apks/.xapk)');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // Una sola parte también puede pesar cientos de MB: se descomprime en flujo, sin pasar por un Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* No hay manifiesto en las partes */ }
    }
    if (!meta) throw new Error('No se pudo analizar el APK base del paquete dividido');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}${shortcutExt()}`);
  }

  /**
   * Dos copias: escritorio + menú Inicio.
   * La búsqueda de Windows indexa los .lnk de «Menú Inicio \ Programas»; solo en el escritorio no se encontrarían,
   * y en equipos con el escritorio redirigido a OneDrive la copia del menú Inicio asegura que el acceso no se pierda.
   *
   * En Linux (FydeOS) el equivalente es el .desktop de freedesktop:
   * una copia en el escritorio y otra en el menú de aplicaciones ~/.local/share/applications.
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // Va en una subcarpeta propia: la búsqueda de Windows la indexa y no sobrescribe accesos directos de apps de terceros con el mismo nombre
      // (probado: el nombre de una app ya lo ocupaba en el menú Inicio otro asistente de escritorio)
      out.push(path.join(this.ctx.startMenuDir, 'LanzadorAPK', `${safeFileName(app.label)}${shortcutExt()}`));
    }
    return [...new Set(out)];
  }

  /** La imagen compatible se descarga bajo demanda «la primera vez que aparece una app ARM» y, como capa base compartida de solo lectura, una sola vez */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'Primera instalación de una app ARM: descargando la imagen compatible (unos 1,5 GB, solo una vez)…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Error al descargar la imagen compatible; revisa tu conexión e inténtalo de nuevo');
    return true;
  }

  /** Cambiar de imagen exige reiniciar el runtime; tras reiniciar se reinstalan las apps desde las copias locales de los APK */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Cambiando a la imagen compatible y reiniciando el runtime…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Espera a que el dispositivo viejo desaparezca de la lista de adb, para que ensure() no lo tome como instancia reutilizable
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'El runtime no está disponible tras cambiar a la imagen compatible');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Restaurando apps instaladas ${app.label}…` });
      } catch (_) { /* Si falla la recuperación de una app no se bloquea el resto */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Analizando el APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Detectada: ${meta.label} (${meta.package})`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    // Juegos de 50 GB: primero se verifica el espacio libre del disco de datos del emulador, en vez de fallar a mitad de la instalación con
    // INSTALL_INSUFFICIENT_STORAGE (el usuario veía «instaló durante mucho rato y luego falló»).
    try {
      const backend = this.runtime && this.runtime.backend;
      if (backend && typeof backend.checkDiskFor === 'function') {
        let bytes = 0;
        if (bundle && bundle.files) {
          for (const f of bundle.files) {
            try { bytes += fs.statSync(f).size; } catch (_) { /* Se ignoran los archivos temporales */ }
          }
        } else {
          try { bytes = fs.statSync(filePath).size; } catch (_) { /* Respaldo con 0 */ }
        }
        const verdict = backend.checkDiskFor(bytes);
        if (!verdict.ok) {
          onProgress({ stage: 'error', message: verdict.message });
          const err = new Error(verdict.message);
          err.needsSetup = 'disk';
          throw err;
        }
      }
    } catch (e) {
      if (e && e.needsSetup === 'disk') throw e;
      // Si falla la detección de capacidad no se puede bloquear la instalación
    }

    try {
      // Sin configuración: las apps que solo tienen librerías ARM obtienen automáticamente la imagen con capa de traducción ARM, sin que el usuario active nada
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Preparando el runtime de Android…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Runtime no disponible');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Instalación + metadatos en disco + acceso directo; si falla, un reintento con reparación automática */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // Tras instalar, el estado de disco de la instantánea quickboot anterior queda obsoleto; conservarla haría que «la app instalada desaparezca tras reiniciar»
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Actualizando la app…' : 'Instalando la app…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // Si en este punto aún da incompatibilidad de ABI, el runtime actual usa la imagen AOSP: se cambia automáticamente a la imagen compatible y se instala otra vez
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Imagen compatible activada; reinstalando…' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Guarda el icono en disco. Muchos iconos de APK son WebP y nativeImage no los decodifica; se pasa al proceso de interfaz para decodificar +
    // una imagen provisional de marca como respaldo, para que el .lnk siempre tenga icono (antes icoPath siempre era null).
    // iconFallback indica «no se pudo decodificar el icono real y se usó el provisional»; hay que avisarlo al usuario como advertencia leve,
    // si no, en el escritorio solo habría un triángulo verde y el usuario creería que LanzadorAPK se equivocó de icono.
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* Un fallo del icono no afecta la instalación */ }
    }

    // Copia de seguridad del APK, para reinstalar/recuperar en el futuro
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // El punto de entrada se toma de lo que resuelve el sistema: la «Activity principal» leída del APK muchas veces no es
    // la verdadera entrada LAUNCHER, y lanzarla directamente salta la página de inicialización y la app se cierra.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* Se conserva el resultado del análisis del APK */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      // Orientación natural de la app (calculada sin conexión del manifiesto del APK):
      // decide la orientación de la pantalla física del emulador; solo si coinciden la imagen llena la ventana sin bordes negros.
      // Si el usuario fijó orientationOverride a mano, manda lo suyo; aquí solo es el «valor por defecto».
      orientation: meta.orientation || (existing ? existing.orientation || null : null),
      pinned: existing ? !!existing.pinned : false,
      // Reinstalada = la tabla de permisos pudo reiniciarse; se borra la caché de «ya otorgados» y el próximo arranque los revisa otra vez
      permGranted: false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Creando el acceso directo en el escritorio…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Error al crear el acceso directo: ${e.message}` });
      }
    }

    // Aviso de compatibilidad: con solo librerías nativas ARM, el runtime x86 necesita capa de traducción
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`Esta app requiere Android ${meta.minSdk} o superior, más nuevo que el runtime actual; puede que no funcione bien.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('No se pudo leer el icono de la app (quizá es un icono adaptable con formato especial); el acceso directo usa un icono provisional.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('No se pudo decodificar el icono de la app (WebP); el acceso directo usa un icono provisional.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // Al instalar se invalidó la instantánea anterior; aquí se vuelve a programar: en reposo se guarda el estado «con la app nueva instalada»,
    // si no, el próximo arranque tendría que ser en frío (más de 20 s).
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} instalada`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    // El .desktop de Linux solo acepta rutas absolutas PNG/SVG, ICO no sirve; por eso se pasan las dos rutas
    // y writeShortcut elige según la plataforma. (Windows usa ico, FydeOS png)
    const png = app.iconPath && fs.existsSync(app.iconPath) ? app.iconPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      iconPngPath: png,
      description: `${app.label} — ejecutada con Lanzador APK`,
      cwd: this.ctx.cwd,
      // Un AUMID por app: en la barra de tareas se agrupa por app y no todo se amontona en LanzadorAPK
      appUserModelId: `zaiddia.LanzadorAPK.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // Si falla toda la ruta principal (la carpeta de accesos personalizada no se puede escribir / la bloquea un programa de seguridad):
    // se vuelve a intentar en el escritorio; con el icono en el escritorio el usuario encuentra la app.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}${shortcutExt()}`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'No se pudo crear el acceso directo');
    // También se guarda la ruta de la copia del menú Inicio, para borrarla al desinstalar
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** Completa accesos directos e iconos que falten: versiones antiguas solo creaban el del escritorio y los iconos WebP no se convertían bien */
  async ensureShortcuts() {
    const made = [];
    // Si el usuario desactivó «crear al instalar» y esta app nunca tuvo un acceso, no se crea por cuenta propia;
    // si no, aunque el interruptor esté apagado se recrearía en cada inicio.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* Si falla recrear el icono no afecta el acceso */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // Si el icono se acaba de recrear, se recrea el .lnk aunque exista, para que el acceso tenga el icono real de la app
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* Un fallo individual no bloquea el inicio */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {}, onAppUp = null } = {}) {
    const app = store.getApp(pkg);
    // Se usa let: beforeStart puede reiniciar el runtime por «la orientación de la pantalla no coincide con la de la app» y
    // devolver un rt nuevo (el client anterior dejó de servir con stop). Antes aquí había un const y, si de verdad
    // se tomaba la rama de reinicio, lanzaba "Assignment to constant variable." e interrumpía todo el arranque:
    // el síntoma era «tras cambiar horizontal/vertical, abrir una app falla directamente».
    let rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime no disponible');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // La resolución se cambia antes de lanzar la app, para que wm size no dispare un cambio de configuración que recree la Activity recién iniciada
    if (beforeStart) {
      const replaced = await beforeStart(rt).catch((e) => { onLog(`Ajuste de pantalla omitido: ${e.message}`); return null; });
      // beforeStart puede devolver un rt nuevo (tras reiniciar el runtime el client anterior ya no sirve);
      // después se usa siempre el nuevo. Si no devuelve nada se sigue con el original.
      if (replaced && replaced.client) rt = replaced;
    }
    // Borra las sobrescrituras de wm size / density y el ajuste de rotación automática que versiones anteriores pudieron dejar en /data.
    // Son persistentes; sin limpiarlas, cada arranque la imagen queda girada 90°, con bordes negros
    // y los clics del ratón no coinciden (los reportes de «bordes negros al rotar / no llena / no se puede pulsar aceptar»).
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // En el arranque en frío se hizo de paso la comprobación de red: si no hay red se dice claramente. Si no, el usuario solo vería «esta app siempre está en negro»
    // sin imaginar que la máquina virtual no tiene red (una página en línea sin datos es solo un fondo negro).
    // Corrección clave: la asociación Wi-Fi suele llegar decenas de segundos después de sys.boot_completed, y muchas apps cargan la portada al entrar;
    // sin red la portada se dibuja como un bloque negro: esa es la causa real de «tras pulsar aceptar y continuar queda en negro».
    // Por eso antes de lanzar la app se espera a que la red esté lista (hasta 90 s); mejor esperar unos segundos más que mostrar una pantalla negra.
    // Antes de lanzar se revisa la red: **solo esperar, sin reiniciar**.
    // Antes aquí se llamaba a ensureNetwork(), y con red lenta «detenía la máquina virtual → arranque en frío»,
    // el dispositivo adb desaparecía a mitad de la instalación y la app simplemente no abría.
    // En la ruta de arranque nunca se pueden hacer acciones destructivas; si la red no llega se arranca igual, como mucho la página cargará lento.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      let net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`Red de la máquina virtual lista (${net.ip || ''})`);
      } else {
        // Si la red no llega se hace un remedio **no destructivo**: pulsar el AndroidWifi
        // «guardado pero que no se conecta solo». No reinicia la máquina virtual ni toca datos del usuario, solo abre la página de ajustes
        // y pulsa un punto de acceso guardado, así que es seguro en la ruta de arranque.
        // En equipos reales casi todos los casos de «la máquina virtual nunca tiene red» se deben a esto (ver emulator.repairWifi).
        onLog('La máquina virtual no se conecta al Wi-Fi; intentando reconectar…');
        try {
          // Ojo: repairWifi está en engine (this.runtime), no en rt.
          // rt es el objeto que devuelve ensure() { ok, client, engine, ... } y solo trae client;
          // escribir rt.repairWifi daría undefined, al llamarlo lanzaría TypeError y el catch lo ocultaría,
          // con el síntoma «el registro dice que está reconectando, pero 1 ms después dice que sigue sin red».
          const fixed = await this.runtime.repairWifi().catch(() => false);
          if (fixed) {
            net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 15000 }).catch(() => null);
            if (net && net.ok) {
              onLog(`Red de la máquina virtual restablecida (${net.ip || ''})`);
              // Clave: guardar de inmediato en la instantánea el estado «red conectada».
              // Si no, el próximo arranque restaura la instantánea vieja «sin red» y cada vez se pierden diez segundos o más reconectando.
              // Se usa forceSnapshotSave porque la app está por iniciarse y nunca se llegaría al «reposo».
              try { this.runtime.forceSnapshotSave?.(3000); } catch (_) { /* Si no se puede guardar no afecta el arranque */ }
            }
          }
        } catch (e) {
          // No ocultar la excepción en silencio: esta línea de registro es la única prueba de si «la reconexión se ejecutó o no».
          onLog(`Error al reconectar el Wi-Fi automáticamente: ${e.message}`);
        }
        if (!net || !net.ok) {
          onLog('La red de la máquina virtual aún no está lista; se abre la app de todos modos (las páginas en línea pueden tardar en cargar)');
        }
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // Puede que la app aún no esté instalada en el runtime actual (imagen recreada / datos borrados / primera vez); lanzarla directo daría
    // "Invalid packageName". Primero se instala desde la caché local y luego se inicia; así «abrir la app» siempre entra,
    // sin instalar antes a mano: justo la experiencia de «al pulsar una app instalada entra directo».
    // Clave: se usa isInstalled() (pm path + comprobar que cada archivo APK exista de verdad) y no
    // `pm list packages`. Si la instantánea y la partición de datos no coinciden, PackageManager sigue diciendo installed=true,
    // pero los archivos en /data/app ya se revirtieron, y am start fallará seguro. Si la verificación de archivos falla se reinstala.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      let installed = false;
      try { installed = await rt.client.isInstalled(pkg); } catch (_) { /* Se trata como no instalada y se reinstala */ }
      if (!installed) {
        onLog('Faltan archivos de la app (la instantánea no coincide con los datos); reinstalando automáticamente desde la copia local…');
        // Antes de reinstalar se invalida la instantánea: si no, el packages.xml de la instantánea vieja seguiría diciendo «instalada» y la próxima vez fallaría otra vez
        try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
        await rt.client.install(app.apkPath).catch((e) => onLog(`Error en la instalación automática: ${e.message}`));
      }
    }
    // Se observa 25 s y se exige «5 s seguidos vivo» para dar el arranque por bueno.
    // Clave: hay que distinguir «el proceso aún no arrancó» de «arrancó y desapareció». Antes, si pidof daba vacío se consideraba un fallo,
    // y las apps grandes (que tardan más de diez segundos en su primer arranque) recibían force-stop y reinicio mientras cargaban,
    // tres rondas hasta que por fin arrancaban; el usuario sentía que «al pulsar hay que esperar un minuto».
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // Primero se comprueba y luego se espera: en el contenedor residente un arranque en caliente suele mostrar el proceso en menos de 1 s,
        // y esperar 1 s antes alargaría un segundo la ruta más rápida.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // Arrancó y desapareció = se cerró de verdad
        } else {
          if (!seen && typeof onAppUp === 'function') {
            // En cuanto aparece el proceso se engancha la imagen (sin esperar el periodo de observación de 4 s).
            // Esos 4 s esperan «confirmar que no se cierra enseguida», pero el usuario ve «pulsé y no pasa nada»;
            // es mucho mejor mostrarle que la app está cargando que ocultarlo 4 s.
            // El callback es fire-and-forget: si falla no afecta la evaluación de supervivencia posterior.
            try { onAppUp(); } catch (_) { /* ignore */ }
          }
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // Solo es fallo si nunca se vio el proceso
    };
    try {
      // Primero se asegura que estén todos los permisos de ejecución: el -g de la instalación puede perderse tras borrar datos,
      // y si faltan permisos el sistema tapa la app con el aviso de permisos; el usuario ve «pulsé y no abre».
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // Con el aviso de permisos al frente la app parece «que no abre»; primero se otorgan y luego se cierra el aviso
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Solo con un registro claro del cierre se pasa a la capa exterior (quizá haya que cambiar a la imagen compatible); sin pruebas casi siempre es un arranque lento y basta reintentar
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // En cuanto arranca la Activity se bloquea la orientación. Va aquí porque el propio arranque de la app dispara
        // cambios de configuración (recreación de la Activity), y el user-rotation fijado antes puede volver a 0 por el sistema;
        // si vuelve a 0, la imagen en la pantalla horizontal queda acostada 90° (el usuario ve que «no se endereza»).
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`La app se cerró al abrir (intento ${attempt}); reintentando automáticamente…`);
      }
      if (!ok) {
        // Respaldo: una salida anormal deja datos «a medio inicializar» y después se cierra siempre.
        // Borrar los datos de la app una vez y relanzarla es lo que mejor funciona (el usuario no tiene que ir a borrar la caché en ajustes).
        onLog('La app se cierra repetidamente; restableciendo sus datos y reintentando…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear también borra los permisos de ejecución; hay que otorgarlos otra vez o la app se queda en el aviso de permisos
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('La app se cierra justo al abrir; se reintentó y se restablecieron sus datos sin éxito');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // El fallo viene de la capa de traducción ARM: se cambia de imagen, se reinstala el APK de respaldo y se inicia otra vez
        onLog('Se detectó un fallo de la capa de traducción ARM; cambiando automáticamente a la imagen compatible…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* Se conserva el paquete original */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
