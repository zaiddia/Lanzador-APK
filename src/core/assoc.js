'use strict';
/**
 * Asociación de archivos .apk (solo escribe en HKCU, no necesita permisos de administrador)
 * Doble clic en un apk → lanzadorapk.exe "%1" → instalación automática → acceso directo automático en el escritorio
 */
const { execFileSync } = require('child_process');

const PROGID = 'LanzadorAPK.apk';
const EXT = '.apk';
const CLASSES = 'HKCU\\Software\\Classes';
// Aquí se guarda el «programa por defecto anterior» a la asociación; al desinstalar se devuelve tal cual, para no perder la asociación del usuario
const STORE_KEY = 'HKCU\\Software\\LanzadorAPK';
const PREV_VALUE = 'assocPrev';

function reg(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

/** Lee el valor por defecto (REG_SZ) de una clave; si no puede, devuelve una cadena vacía */
function regDefault(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { windowsHide: true, encoding: 'utf8' });
    const line = String(out).split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
    const m = line && /REG_SZ\s+(.*)$/i.exec(line);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/** Lee el «valor por defecto anterior a la asociación» que guardamos */
function readPrev() {
  try {
    const out = execFileSync('reg', ['query', STORE_KEY, '/v', PREV_VALUE], { windowsHide: true, encoding: 'utf8' });
    const m = /REG_SZ\s+(.*)$/im.exec(String(out));
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function notifyShell() {
  const ps = `
$sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);';
try {
  $t = Add-Type -MemberDefinition $sig -Name 'ShNotify' -Namespace 'LanzadorAPK' -PassThru -ErrorAction Stop;
  $t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero);
} catch {}
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, stdio: 'pipe', timeout: 8000,
    });
  } catch (_) { /* Si falla la notificación, la asociación igual se mantiene */ }
}

/**
 * @param {string} exePath ruta del programa lanzadorapk (en desarrollo es electron.exe)
 * @param {string} [iconPath] ico opcional
 * @param {string} [extraArgs] en desarrollo hay que pasar primero la carpeta de la app, por ejemplo "\"C:\\path\\lanzadorapk\""
 */
function registerAssociation(exePath, iconPath, extraArgs) {
  const icon = iconPath || exePath;
  const command = `"${exePath}" ${extraArgs ? extraArgs + ' ' : ''}"%1"`;

  // Recuerda el programa por defecto de .apk antes de asociar: si el usuario tenía otra herramienta Android, al desinstalar LanzadorAPK
  // se le debe devolver, no dejar .apk «sin programa por defecto».
  const prev = regDefault(`${CLASSES}\\${EXT}`);
  if (prev && prev !== PROGID) {
    reg(['add', STORE_KEY, '/v', PREV_VALUE, '/d', prev, '/f']);
  } else if (!prev) {
    try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* Ya no existía */ }
  }

  reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', PROGID, '/f']);
  reg(['add', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f']);

  reg(['add', `${CLASSES}\\${PROGID}`, '/ve', '/d', 'Paquete de app Android', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Paquete de app Android', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open`, '/ve', '/d', 'Instalar en Lanzador APK', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);

  notifyShell();
  return { ok: true, progId: PROGID, previous: prev };
}

/**
 * Quita la asociación.
 * La implementación anterior vaciaba siempre el valor por defecto de .apk (el comentario decía «solo si sigue apuntando a nosotros», pero el código no lo hacía),
 * y al desinstalar LanzadorAPK se borraba también la asociación original de .apk. Ahora:
 *  1) hay registro anterior a la asociación → se restaura tal cual;
 *  2) no hay registro y el valor actual sigue siendo nuestro → solo entonces se vacía;
 *  3) el valor actual es de otro programa → no se toca ni un byte.
 */
function unregisterAssociation() {
  reg(['delete', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/f']);
  reg(['delete', `${CLASSES}\\${PROGID}`, '/f']);

  const prev = readPrev();
  const current = regDefault(`${CLASSES}\\${EXT}`);
  let restored = '';
  if (prev) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', prev, '/f']);
    restored = prev;
  } else if (current === PROGID) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', '', '/f']);
  }
  try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
  notifyShell();
  return { ok: true, restored };
}

module.exports = { registerAssociation, unregisterAssociation, PROGID };
