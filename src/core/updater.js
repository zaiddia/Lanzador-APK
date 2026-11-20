'use strict';
/**
 * Actualización en línea: obtiene la última versión de GitHub Releases (zaiddia/Lanzador-APK), la descarga y la reemplaza en el sitio.
 *
 * Hay que cubrir tres formas:
 *   - versión instalada (NSIS): descarga `LanzadorAPK-x.y.z-Setup.exe` y la instala en silencio (/S);
 *   - versión ligera (zip portátil, runtime bajo demanda): descarga `LanzadorAPK-vX-win64-portable.zip`,
 *     la descomprime y sobrescribe la carpeta del programa; la carpeta del runtime (%APPDATA%\lanzadorapk\runtime), las apps instaladas
 *     y las instantáneas están en la carpeta del usuario, así que reemplazar los archivos del programa no las toca;
 *   - versión completa (portátil con runtime): igual que la ligera, solo que la carpeta tiene además resources\runtime.
 *
 * El reemplazo no se puede hacer en este proceso (el exe está en uso), así que se genera un script de PowerShell
 * que se pasa con EncodedCommand a un proceso independiente: espera a que este proceso salga → copia archivos → vuelve a lanzar.
 * El script se pasa en base64 y no como archivo .ps1 para evitar el viejo problema de
 * «script decodificado como GBK si la ruta tiene caracteres no ASCII» (PowerShell 5.1 interpreta como ANSI los scripts sin BOM).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { verifyFile } = require('./integrity');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer, nameHasVersion } = require('./version');
const { Sources } = require('./sources');

const { OWNER, REPO } = require('./brand');

/** Cadena entre comillas simples de PowerShell: cada ' interna se escribe '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Busca un archivo por nombre (sin distinguir mayúsculas) en el primer nivel de la carpeta; devuelve el nombre real o null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Busca el desinstalador NSIS en la carpeta del programa; si no lo encuentra devuelve null.
 * El nombre por defecto de electron-builder es `Uninstall <productName>.exe` (lo que reconoce updater.flavor);
 * versiones viejas/empaquetados personalizados pueden llamarlo `uninstaller.exe` (el código viejo de main.js solo reconocía ese).
 * Ambos lugares deben usar las mismas reglas; si no, «Desinstalar» en la versión instalada se tomaría por versión portátil (issue #51).
 */
function findUninstaller(installDir) {
  try {
    const names = fs.readdirSync(installDir);
    return names.find((n) => /^Uninstall .*\.exe$/i.test(n))
      || names.find((n) => /^uninstall(er)?\.exe$/i.test(n))
      || null;
  } catch (_) {
    return null;
  }
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() es para sources: decide si hay un prefijo de espejo
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Forma de instalación: versión instalada (con desinstalador) o paquete portátil */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Buscar actualizaciones: consulta GitHub y toma la versión más alta con sus archivos.
   * Las direcciones concretas de descarga se vuelven a ordenar por velocidad real en prepare().
   */
  /**
   * @param {{force?:boolean}} [opts] force=true omite la caché de versiones de 10 minutos
   *        (cuando el usuario pulsa «Buscar actualizaciones» debe obtener el resultado más reciente; la comprobación silenciosa al iniciar usa la caché)
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    // Si hay varios archivos que coinciden (p. ej. uno con un nombre de versión mal escrito), se prefiere el que lleva la versión exacta
    const pick = (re) => {
      const hits = merged.assets.filter((a) => re.test(String(a.name || '')));
      return hits.find((a) => nameHasVersion(a.name, merged.version)) || hits[0];
    };
    // La versión publicada trae a la vez el «paquete portátil» y el «paquete del runtime» (LanzadorAPK-runtime-*.zip).
    // La coincidencia .zip de respaldo debe excluir el paquete del runtime: si una versión solo tuviera el runtime
    // y no el portátil, la lógica anterior lo descomprimiría en la carpeta del programa como actualización (1,5 GB de archivos de más y el programa roto).
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // Ojo, se pasan también parts: los paquetes en partes no tienen una url única; sin parts quedarían «con archivo pero sin dirección»
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // El mismo archivo en varias direcciones: se llevan todas y prepare() mide y elige la más rápida.
          // sizes es «el tamaño de cada dirección»: los paquetes de distintas fuentes no tienen los mismos bytes.
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
          sha256: asset.sha256 || '',
        }
        : null,
      assets: merged.assets,
      // La versión más reciente de cada fuente / cuáles no son accesibles, para que la interfaz muestre con honestidad «qué fuente se usó»
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      // Auto-install only when a SHA-256 published on GitHub is available for the package.
      verified: !!(asset && asset.sha256),
      canAutoApply: !!asset && !!asset.sha256 && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * Descarga y prepara el «contenido»: la versión portátil se descomprime en update/<ver>/payload, la instalada deja el Setup.exe.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('Esta versión no tiene un paquete instalable automáticamente; descárgalo manualmente desde la página de versiones de GitHub');
    if (!it.asset.sha256) {
      throw new Error('Esta versión no publica una suma SHA-256 verificable; por seguridad no se instala '
        + 'automáticamente. Descárgala manualmente desde la página de versiones de GitHub.');
    }
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Formato heredado: algunos paquetes se publicaban en partes .part1/.part2.
    // Cada parte mide y elige su fuente por separado,
    // y al terminar se unen en orden: para el usuario sigue siendo solo «descargar + descomprimir».
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Descargando ${it.asset.name}…` });
      // Direcciones candidatas = fuente original + prefijo de espejo; primero se bajan 256 KB de cada una para medir la velocidad y luego se descarga por bloques desde la más rápida.
      // Es la única forma fiable de elegir cuando GitHub directo da decenas de KB/s y un espejo varios MB/s:
      // adivinar por el dominio no sirve; en el mismo día cambia mucho según la hora.
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // El tamaño total para el progreso debe ser el de «la fuente que realmente descarga»: los paquetes de distintas fuentes no son los mismos bytes
      // (otro compresor, varios MB de diferencia); con el equivocado se quedaría en 92 % y saltaría de golpe a completado.
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti: baja bloques a la vez de «GitHub directo» y del «espejo», sumando ancho de banda;
      // si solo hay una fuente o no admite Range, vuelve solo a bloques de una sola fuente.
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Descargando ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    this.onProgress({ stage: 'verify', percent: 99, message: 'Verificando la integridad del paquete (SHA-256)…' });
    await verifyFile(file, it.asset.sha256, 'sha256', it.asset.name);

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      // issue #98: si la vez anterior ya se descargó + descomprimió pero el reemplazo/reinicio falló,
      // se reutiliza este contenido directamente; nunca se vuelven a bajar 100 MB: esa era la causa del «bucle infinito de actualización».
      // Esta función escribe la marca de listo y el script de reemplazo la borra al tener éxito, así que solo se reutiliza contenido descomprimido por completo.
      if (this._payloadReady(out, it.version)) {
        this.onProgress({ stage: 'ready', percent: 100, message: 'Ya hay un paquete de actualización descargado; se reutiliza' });
        return { mode: 'zip', payload: out, version: it.version };
      }
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this._markPayloadReady(out, it.version);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Paquete de actualización descomprimido' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Instalador descargado' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * Descarga y une un paquete en partes.
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Descargando ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + ` (parte ${part.index}/${asset.parts.length}) ${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`La parte ${part.index} tiene un tamaño incorrecto (${buf.length} ≠ ${part.size}); se detuvo, puedes reintentar`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`El paquete de actualización tiene un tamaño incorrecto tras unirlo (${doneBytes} ≠ ${total}); se detuvo, puedes reintentar`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        // Protección zip-slip: siempre por la protección de zip.js (bloquea ../, rutas absolutas, letras de unidad, trucos con barra invertida)
        const target = resolveZipEntry(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Descomprimiendo ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /** Archivo de marca de contenido listo: se escribe solo cuando la descompresión terminó en disco, para decidir la reutilización entre procesos */
  _readyFile(payload) { return path.join(payload, '.lanzadorapk-ready'); }

  _markPayloadReady(payload, version) {
    try {
      fs.writeFileSync(this._readyFile(payload), JSON.stringify({ version, at: Date.now() }), 'utf8');
    } catch (_) { /* Si no se puede escribir la marca, la próxima vez se vuelve a descargar; no afecta la corrección */ }
  }

  _payloadReady(payload, version) {
    try {
      if (!fs.existsSync(this._readyFile(payload))) return false;
      const m = JSON.parse(fs.readFileSync(this._readyFile(payload), 'utf8'));
      // Versión distinta = lo descargado la vez anterior era otra versión; no se puede reutilizar
      if (m.version !== version) return false;
      // Clave: el exe principal debe estar en el contenido. Si no está, la descompresión se interrumpió o el antivirus lo borró.
      const exeName = path.basename(this.exePath || 'LanzadorAPK.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
  }

  /**
   * Se llama al iniciar: recupera y completa la actualización «descargada y descomprimida la vez anterior, pero cuyo reemplazo/reinicio falló».
   * Usa directamente el contenido local, sin volver a descargar (solución de raíz al bucle de la issue #98).
   * @returns {{mode:'zip', payload:string, version:string}|null}
   */
  findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => cmpVer(n, this.current) > 0)   // Solo versiones más nuevas que la actual, para no reiniciar una y otra vez
        .sort((a, b) => cmpVer(b, a));
      for (const v of versions) {
        const payload = path.join(this.updateDir, v, 'payload');
        if (this._payloadReady(payload, v)) return { mode: 'zip', payload, version: v };
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * Genera e inicia el script de «reemplazar + reiniciar»; después quien llama se encarga de cerrar la app.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] en pruebas se puede indicar otro pid / no lanzarlo de verdad
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      `$applyOk = $true`,
      // Espera a que este proceso salga de verdad (hasta 90 s); si no, exe/dll siguen en uso
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // issue #98: el script anterior solo comprobaba «si existe el exe de destino»; como ya existía, una copia
      // fallida se tomaba por exitosa, luego se borraba el contenido y se reiniciaba la versión vieja → al arrancar se detectaba otra vez la actualización → bucle infinito.
      // Ahora: antes de copiar se renombra el exe de destino a .old y tras copiar se confirma que el nuevo exe esté en disco y que su tamaño
      // coincida con el contenido; si falla se restaura el .old y **se conserva el contenido** para que el próximo inicio lo complete.
      const exeName = path.basename(exe);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$exeName = ${psq(exeName)}`,
        `$target = Join-Path $dst $exeName`,
        `$srcExe = Join-Path $src $exeName`,
        `$expected = (Get-Item $srcExe).Length`,
        `$backup = "$target.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $target) {`,
        `  try { Move-Item -LiteralPath $target -Destination $backup -Force; $hasBackup = $true } catch { Note "backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $expected)) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'copy FAILED - keeping payload for next launch'`,
        `  $applyOk = $false`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $target -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Force } catch {} }`,
        // Solo si se confirma que la copia salió bien se borran el contenido y la marca de listo; si no, quedan para findResumableJob.
        `  try { Remove-Item -LiteralPath (Join-Path $src '.lanzadorapk-ready') -Force } catch {}`,
        `  Remove-Item -Path $src -Recurse -Force`,
        `}`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      // issue #98: un solo Start-Process y si fallaba no decía nada → el usuario veía «se cerró pero no reinició».
      // Se agrega -WorkingDirectory (recursos con rutas relativas en la versión portátil); si falla se usa cmd /c start, y se registra.
      `if (Test-Path ${psq(exe)}) {`,
      `  try {`,
      `    Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ErrorAction Stop`,
      `    Note 'relaunched via Start-Process'`,
      `  } catch {`,
      `    Note ("Start-Process failed: " + $_.Exception.Message + "; fallback to cmd start")`,
      `    try {`,
      `      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','""',${psq(exe)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden`,
      `      Note 'relaunched via cmd start'`,
      `    } catch { Note ("cmd start failed: " + $_.Exception.Message) }`,
      `  }`,
      `} else { Note 'relaunch skipped: exe missing' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      // Si falla la copia se conserva toda la carpeta de la versión (contenido + marca de listo) para que el próximo inicio la complete;
      // si no, se diría «se conserva el contenido» y acto seguido se borraría, y nunca se podría completar.
      `if ($applyOk) { Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force }`,
      `else { Note 'version dir kept for resume on next launch' }`,
      // Un fallo de la limpieza final (carpeta ya borrada/ocupada por el antivirus) no debe hacer creer a quien llama que la actualización falló
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand usa base64 UTF-16LE: aunque el script tenga rutas con caracteres no ASCII no se dañan con la decodificación GBK
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Aquí **no se puede** usar detached: algunos programas de seguridad / políticas de sandbox bloquean los «procesos de consola separados»,
    // y el script simplemente no se ejecutaba (la pantalla de actualización quedaba en «Reemplazando el programa y reiniciando»).
    // En Windows la salida del proceso padre no mata a los procesos hijos normales, así que «proceso hijo normal + unref» también
    // sigue trabajando después de que salgamos, y es más compatible.
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** Si no se puede abrir la interfaz (o no hay archivos instalables automáticamente), se abre la página de versiones en el navegador */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
