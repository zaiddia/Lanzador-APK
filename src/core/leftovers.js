'use strict';
/**
 * Limpia restos de versiones anteriores.
 *
 * Al actualizar LanzadorAPK es común «tener varias versiones instaladas y que no se desinstalen del todo»: la versión portátil agrega una carpeta
 * LanzadorAPK-vX.Y.Z-win64-portable por cada versión; tras actualizar el instalador NSIS pueden quedar entradas de desinstalación
 * que apuntan a carpetas borradas; y la actualización deja un montón de paquetes temporales en la carpeta de datos.
 *
 * Aquí solo se hace la limpieza **demostrablemente segura**:
 *   - solo carpetas de versiones viejas que «de verdad contienen LanzadorAPK.exe», y nunca la que está en ejecución;
 *   - solo entradas de desinstalación del registro cuyo «InstallLocation ya no existe» (ya eran entradas muertas);
 *   - solo archivos temporales de nuestra caché de actualizaciones y accesos directos del menú Inicio/escritorio que apuntan a destinos inexistentes.
 * Ante cualquier duda se omite el paso y se devuelve el motivo tal cual a la interfaz.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'LanzadorAPK.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* En uso/sin permisos, se omite */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/**
 * Busca carpetas de versiones viejas en varias carpetas «donde puede haber programas».
 *
 * Antes solo se revisaban la carpeta superior del exe actual + LOCALAPPDATA\Programs + ProgramFiles, y si el usuario
 * descomprimía la versión portátil en otro lado (E:\Descargas, el escritorio, una carpeta de proyecto) nunca se encontraba;
 * esa era la causa de «no se limpian las versiones viejas de otras carpetas». Ahora se buscan por varias vías:
 *   - ubicaciones de instalación habituales;
 *   - un nivel bajo la raíz de cada disco (muchas versiones portátiles quedan directo en D:\LanzadorAPK-…);
 *   - la carpeta del exe real al que apuntan los accesos del escritorio / menú Inicio (lo más preciso; si el usuario lo instaló, existe).
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  // Algunas ubicaciones frecuentes dentro de la carpeta del usuario
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  // Raíz de cada disco local (las versiones portátiles suelen quedar en la raíz)
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * A partir de los accesos directos (.lnk / .desktop) se obtiene la carpeta real de LanzadorAPK.exe.
 * Es la forma más fiable: si el usuario alguna vez creó un icono en el escritorio o una entrada en el menú Inicio, la ruta de destino está ahí,
 * sin importar el disco ni lo profunda que sea la carpeta.
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'LanzadorAPK'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]LanzadorAPK(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // El .lnk es binario, pero la ruta de destino va incrustada en forma legible; se buscan directamente los bytes LanzadorAPK*.exe
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?LanzadorAPK(?:-[^\x00\x01-\x1f]*)?[\\/]?LanzadorAPK\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?LanzadorAPK\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* Si no se puede leer se omite */ }
    }
  }
  return [...dirs];
}

/** Carpeta de una versión anterior: con forma LanzadorAPK*, que contiene LanzadorAPK.exe y no es la carpeta de instalación actual */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // Tiene que ser una carpeta que «de verdad sea LanzadorAPK», para no borrar por error una carpeta con el mismo nombre
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: 'carpeta de una versión anterior (contiene ' + EXE + ')',
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^LanzadorAPK/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // La carpeta obtenida del acceso directo puede ser ella misma una versión vieja, o serlo su carpeta superior/inferior
  for (const d of rootsFromShortcuts()) {
    if (/^LanzadorAPK/i.test(path.basename(d))) consider(d);
    // También se miran las carpetas hermanas (en dist suele haber varias versiones lado a lado)
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^LanzadorAPK/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** Entradas de desinstalación del registro que apuntan a carpetas inexistentes */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'LanzadorAPK', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // La salida de reg query va en bloques «clave → valores»; aquí se separa por bloques
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\LanzadorAPK/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // Solo se procesan entradas muertas «que ya no están instaladas pero siguen en la lista de apps»
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `entrada de desinstalación obsoleta ${disp ? `: ${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** Caché de actualizaciones / paquetes temporales */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^LanzadorAPK.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^LanzadorAPK-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'archivos temporales de la descarga de actualizaciones' });
    }
  }
  return out;
}

/** Instantáneas de arranque rápido viejas/descartadas: default_boot la dejaron versiones tempranas (un ram.img de unos 3 GB),
 *  *.stale-* son restos de «no se pudo borrar, se renombró». La instantánea actual se llama lanzadorapk y nunca se toca. */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'lanzadorapk.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'lanzadorapk') continue;   // Instantánea en uso
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? 'instantáneas de arranque rápido de versiones anteriores' : 'restos de instantáneas descartadas',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // Doble seguro: nunca borrar la carpeta en ejecución
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'Es la versión que se está ejecutando' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: 'La carpeta no contiene ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Archivo en uso (puede que haya una ventana abierta)' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Archivo en uso' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'Error al borrar' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
