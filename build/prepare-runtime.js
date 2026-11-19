'use strict';
/**
 * Prepara engine/ como runtime «distribuible con el paquete»: build/runtime/
 *
 * El paso clave es comprimir system.img. El system.img de AOSP es una imagen dispersa de 3,1 GB,
 * casi todo ceros; con gzip queda en ~580 MB. Casi todo el tamaño de la versión de un solo archivo está aquí.
 * Sumando emulator (unos 340 MB tras reducirlo) + Electron + platform-tools, el paquete pesa ~1,0–1,1 GB.
 * Sin comprimir la versión publicada pasaría de 1,4 GB.
 * El costo es que el primer arranque tarda 1–2 minutos en descomprimirla en la carpeta del usuario (solo una vez);
 * la lógica de descompresión está en materializeImages() de src/core/provision.js.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Plantilla inicial de /data (ext4 ya formateado, comprimido con xz). Ver el comentario de userdata.img más abajo.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Las imágenes grandes usan XZ (LZMA2): ahorra ~25 % más que gzip -6 (system.img 1,5 GB → ~1,1 GB).
 *  Por defecto el nivel máximo 9e; en CI con dos núcleos XZ_PRESET=6 reduce el tiempo a un tercio (tamaño +3 %).
 *
 *  Notas de implementación (problemas ya vividos):
 *   - Se usa lzma de python (un hilo, estable). createCompressStream de @napi-rs/lzma en algunos
 *     entornos se cuelga con 0 bytes (probado: 18 minutos sin salida); solo sirve como último recurso y con tiempo límite.
 *   - [La verdadera causa del bloqueo de 3 horas en CI] el archivo de origen debe enviarse por pipe al stdin del subproceso y cerrarse al terminar.
 *     En python es `shutil.copyfileobj(sys.stdin.buffer, z)`: sin EOF espera entrada para siempre,
 *     no escribe ni un byte en stdout y el proceso nunca termina. Entonces solo se conectaba p.stdout; localmente, como ya existía el .xz,
 *     «omitir recompresión» lo ocultaba, pero en CI, con carpeta nueva, fallaba siempre.
 *   - Además un vigilante: si el compresor falla de forma inesperada se mata y se usa gzip; el empaquetado nunca se queda colgado.
 *   - Sin python o si la compresión falla → gzip -9 (algo más grande pero nunca se cuelga),
 *     materializeImages elige el descompresor según la extensión y acepta ambos resultados.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* Probar el siguiente */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Por defecto 2 horas (3 GB / 2 núcleos / preset 6 tarda ~40 min); al agotarse se mata y se usa gzip.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Primero se conectan los oyentes, para no perder el evento close si el subproceso termina antes del await.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  (la compresión xz superó ${Math.round(timeoutMs / 60000)} minutos; se cancela y se usa gzip -9)`);
      try { p.kill(); } catch (_) { /* Ya terminó */ }
    }, timeoutMs);

    let ok = false;
    try {
      // Clave: stdin es la entrada del compresor. pipeline termina p.stdin al leer todo src,
      // y python, al recibir EOF, escribe el bloque final de XZ y sale normalmente.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // Ante cualquier error (EPIPE / fallo de escritura) se termina el subproceso de inmediato, sin esperar al vigilante.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // Un .xz a medias contamina el resultado; hay que borrarlo antes de usar el respaldo.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  (${py} falló al comprimir; se usa gzip -9)`);
  } else {
    console.log('  (no se encontró python; se usa gzip -9 (algo más grande pero fiable))');
  }
  // Respaldo: gzip -9 (no xz; materializeImages elige el descompresor según la extensión)
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime ya está actualizado (agrega --force para reconstruir)');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('Falta la carpeta engine/; no se puede preparar el runtime');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copia directa de emulator / platform-tools (sin resultados anteriores)
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`Copiando ${dir}…`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Reducción: borra archivos que nunca se cargan con los parámetros de arranque fijos (unos -400 MB)
  if (!process.argv.includes('--no-slim')) {
    console.log('Reduciendo el runtime…');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. Imagen del sistema: las imágenes grandes se comprimen en .xz (materializeImages las descomprime en flujo), el resto va tal cual
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt es el texto de licencias de GMS (~20 MB); no hace falta para ejecutar
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // userdata.img usa la plantilla ext4 incluida en el repositorio (seed):
            // la del sys-img oficial es 1 MB de ceros; al ampliarla el emulador, e2fsck siempre da code=8,
            // la partición se queda en 1 MB → el invitado ve invalid magic → /data de solo lectura → una instalación nueva nunca arranca.
            // La plantilla se generó una sola vez (mke2fs) y viaja con el código; el CI no necesita herramientas extra.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('userdata.img usa la plantilla ext4 predefinida (build/seed)');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // Las imágenes grandes se comprimen una vez y el original no entra en el paquete; si ya hay un resultado comprimido (de tamaño razonable) se omite
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // El respaldo con gzip genera .gz y también hay que aceptarlo; si no, cada recompilación volvería a comprimir 3 GB.
              // El umbral es >1 MB y no la tasa de compresión: vendor.img.gz pesa ~21 MB y userdata.img es casi todo ceros;
              // un umbral fijo grande o una «tasa de compresión» los tomaría por inválidos y los volvería a comprimir.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`Se omite ${f} (ya existe, ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB)`);
                compressed += 1;
                continue;
              }
              console.log(`Comprimiendo ${f} (${(sizeOf(src) / 1073741824).toFixed(2)} GB) → XZ 9e (lento, una sola vez)…`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`Listo: build/runtime (${(total / 1073741824).toFixed(2)} GB, se comprimieron ${gzCount} imágenes grandes)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Para que las pruebas de regresión lo llamen directamente (sin disparar el flujo completo de main)
module.exports = { xzFile, gzipFile, findPython };
