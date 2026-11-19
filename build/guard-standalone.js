'use strict';
/**
 * Vigilante de independencia: el instalador **no puede** contener ningún archivo de emuladores de terceros.
 *
 * Por qué hace falta una comprobación al compilar:
 *   Los instaladores de LanzadorAPK (NSIS / portátil / MSIX) deben funcionar al instalarlos: traen emulator +
 *   platform-tools + imagen del sistema y funcionan sin que el usuario instale antes MuMu / LDPlayer / BlueStacks.
 *   Desde 0.5.6 se fue más lejos: **el código no tiene ningún backend de terceros**; lo instalado no es «runtime propio + reutilización opcional»,
 *   sino «solo runtime propio». Por eso, además de binarios, se bloquea el código de adaptadores de terceros
 *   (backends/mumu.js / backends/fydeos.js / mumu-compat.js): si alguien los vuelve a agregar,
 *   la compilación falla, para que no reaparezca «un camino para tomar el control del emulador de otros».
 *
 *   Esta regla se rompe fácilmente sin querer: por ejemplo, copiar la carpeta de MuMu a build/runtime como runtime,
 *   o meter la carpeta del emulador en resources y empaquetar. En la máquina de desarrollo la app funciona igual,
 *   pero al usuario le sale «hay que instalar otro emulador»: el problema solo aparece en equipos ajenos.
 *   Por eso antes de empaquetar se revisan los nombres de archivo y, si hay coincidencia, la compilación falla.
 */

const fs = require('fs');
const path = require('path');

/**
 * Si alguno de estos nombres aparece en el paquete, significa que se coló «el emulador de otro».
 * Solo se buscan los nombres característicos de cada emulador, nada genérico como /android/, para evitar falsos positivos.
 */
const BANNED = [
  { re: /^mumu/i, vendor: 'emulador MuMu' },          // MuMuManager.exe / MuMuPlayer.exe / MuMuVMMVbox
  { re: /\.nemu$/i, vendor: 'emulador MuMu' },        // archivo de instancia MuMuPlayer-12.0-0.nemu
  { re: /^nemu$/i, vendor: 'emulador MuMu' },         // carpeta nemu de MuMu
  { re: /^nx_main$/i, vendor: 'emulador MuMu' },      // carpetas nx_main / nx_device de MuMu
  { re: /^nx_device$/i, vendor: 'emulador MuMu' },
  { re: /^ldplayer/i, vendor: 'emulador LDPlayer' },
  { re: /^dnplayer/i, vendor: 'emulador LDPlayer' },
  { re: /^bluestacks/i, vendor: 'emulador BlueStacks' },
  { re: /^hd-player/i, vendor: 'emulador BlueStacks' },
  { re: /^mgalaxy/i, vendor: 'emulador MEmu' },
];

/** Solo estas extensiones cuentan como «el emulador en sí»; .js/.md/.json son código y configuración y no se bloquean */
const BINARY_EXT = /\.(exe|dll|sys|nemu|vdi|vmdk|vbox|iso|msi|bin|dat|db|img)$/i;

/**
 * Busca recursivamente archivos/carpetas que coincidan.
 * @param {string} dir carpeta raíz a revisar (normalmente resources/runtime o la carpeta app del paquete)
 * @param {object} [opts] { limit } se detiene tras esta cantidad de coincidencias (por defecto 20, suficiente para avisar)
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findBundled(dir, { limit = 20 } = {}) {
  const hits = [];
  const walk = (d) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return; // Sin permisos / no existe: se trata como vacío
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const hit = BANNED.find((b) => b.re.test(e.name));
      // Las carpetas cuentan directamente; los archivos deben parecer binarios (si no, backends/mumu.js del código se tomaría por MuMu)
      if (hit && (e.isDirectory() || BINARY_EXT.test(e.name))) {
        hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.vendor });
        continue; // Si coincide una carpeta no se entra en ella; reportarla es más útil
      }
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return hits;
}

/**
 * Código de adaptadores de backends de terceros (si aparece en el paquete, volvió la capacidad de «reutilizar emuladores ajenos»).
 * Son .js y no están en BINARY_EXT, así que se revisan aparte.
 */
const BANNED_SOURCE = [
  { re: /^mumu\.js$/i, what: 'adaptador de base MuMu' },
  { re: /^fydeos\.js$/i, what: 'adaptador de base FydeOS' },
  { re: /^mumu-compat\.js$/i, what: 'estrategia de compatibilidad MuMu' },
  { re: /^frame\.js$/i, what: 'revisión de fotogramas MuMu' },
];

/**
 * Busca código de backends de terceros dentro del paquete.
 * Solo cuenta «backends/xxx.js» o esos nombres directamente en src/core, para no afectar a otro frame.js.
 * @param {string} dir
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findForbiddenSource(dir) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const dirName = path.basename(d);
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
      const hit = BANNED_SOURCE.find((b) => b.re.test(e.name));
      if (!hit) continue;
      // Solo estas ubicaciones concretas: mumu|fydeos en backends/, y mumu-compat / frame en core/.
      // Archivos con el mismo nombre en otros lugares (como frame.js de la interfaz) no se bloquean.
      const suspicious = dirName === 'backends' || (dirName === 'core' && !/^builtin\.js$/i.test(e.name));
      if (suspicious) hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.what });
    }
  };
  walk(dir);
  return hits;
}

/**
 * Comprueba que no haya emuladores de terceros en la carpeta.
 * @param {string} dir
 * @param {object} [opts] { label, exit } label se usa en el aviso; exit=false solo devuelve el resultado sin terminar el proceso
 * @returns {{ok: boolean, skipped?: boolean, hits: Array}}
 */
function assertStandalone(dir, { label = 'artefactos del empaquetado', exit = true } = {}) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, skipped: true, hits: [] };
  const hits = findBundled(dir).concat(findForbiddenSource(dir));
  if (!hits.length) return { ok: true, hits: [] };

  const vendors = [...new Set(hits.map((h) => h.vendor))].join(' / ');
  console.error(`\n[guardia] ${label} contiene emuladores de terceros (${vendors}):`);
  for (const h of hits) console.error(`  - ${h.path}`);
  console.error('');
  console.error('El instalador de LanzadorAPK debe traer su propio runtime y funcionar solo: no puede depender de otros emuladores ni incluirlos,');
  console.error('y tampoco se permite volver a traer el código de adaptadores que «toman el control de otros emuladores».');
  console.error('Borra esas rutas de la carpeta de empaquetado y vuelve a intentarlo.\n');
  if (exit) process.exit(4);
  return { ok: false, hits };
}

module.exports = { BANNED, BANNED_SOURCE, findBundled, findForbiddenSource, assertStandalone };
