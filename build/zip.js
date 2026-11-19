'use strict';
/**
 * Compresión del paquete portátil (zip de Windows).
 *
 * Por qué no se usa `Compress-Archive` de PowerShell:
 * usa el deflate de .NET (equivale al nivel 6 de zlib); la misma carpeta de 225 MB queda en
 * 105.213.775 bytes, mientras que el deflate de 7-Zip (`-mx=9`) da 99.616.541 bytes: 5,6 MB de diferencia.
 * El límite por archivo de los adjuntos de versión de Gitee era de 100 MB (probado: 104.800.000 bytes se suben,
 * 105.213.775 se partían en part1/part2 y el usuario no podía descomprimir directamente). Esos 5 MB
 * significaban que «el paquete no se podía descomprimir, o había que descargar dos partes».
 *
 * Por eso siempre se comprime con 7-Zip; solo si no se encuentra 7-Zip se usa Compress-Archive (con un aviso claro).
 *
 * Uso:
 *   node build/zip.js <carpeta origen> <salida.zip> [--limit-mb 100]
 * Código de salida: 0 éxito / 1 error / 2 supera el límite de tamaño (en CI cuenta como error, para no publicar partes sin darnos cuenta)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** Busca el ejecutable de 7-Zip (7z.exe o 7za.exe) en ubicaciones habituales */
function find7z() {
  const explicit = process.env.LANZADORAPK_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // Buscar en PATH (windows-latest de GitHub Actions trae 7-Zip en el PATH)
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z.exe', '7za.exe']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // Caché de 7zip descargada por electron-builder (habitual en equipos de desarrollo)
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* No hay carpeta de caché */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Comprime en zip con 7-Zip: cwd es la carpeta de origen para que las rutas internas sean relativas, sin la carpeta superior */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`7-Zip 压缩失败（${r.status}）：${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** Respaldo: Compress-Archive de PowerShell (5 % más grande; solo si 7-Zip no está instalado) */
function zipWithPowershell(srcDir, outZip) {
  const ps = `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Compress-Archive 失败：${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** Autocomprobación: lee el zip con el propio lector de la app y confirma que coinciden la cantidad de entradas y el total de bytes */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`条目数不符：包内 ${names.length}，源目录 ${expect.files}`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`解压总字节不符：包内 ${bytes}，源目录 ${expect.bytes}`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('用法：node build/zip.js <源目录> <输出.zip> [--limit-mb 100]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`压缩 ${srcDir}（${stats.files} 个文件，${(stats.bytes / MIB).toFixed(1)} MB）`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('压缩器：', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('⚠️  没找到 7-Zip，退回 Compress-Archive —— 产物会大 5% 左右，可能装不进 Gitee 单文件限额');
    zipWithPowershell(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`完成：${outZip}`);
  console.log(`  ${entries} 个条目，${size} 字节（${(size / MIB).toFixed(2)} MiB），压缩率 ${(size / stats.bytes * 100).toFixed(1)}%`);

  if (size > limitMiB * MIB) {
    console.error(`✗ 超过 ${limitMiB} MiB 上限（Gitee 附件单文件上限 100MB）。请先给包瘦身，不要靠切分片绕过。`);
    process.exit(2);
  }
  console.log(`  ✓ 在 ${limitMiB} MiB 以内（余量 ${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB）`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
