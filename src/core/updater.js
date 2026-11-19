'use strict';
/**
 * 在线更新：从 GitHub Releases（zaiddia/Lanzador-APK）取最新版本，下载并原地替换。
 *
 * 三个形态都要照顾到：
 *   - 安装版（NSIS）：下载 `LanzadorAPK-x.y.z-Setup.exe`，静默安装（/S）；
 *   - 轻量版（便携 zip，运行时按需下载）：下载 `LanzadorAPK-vX-win64-portable.zip`，
 *     解压后覆盖程序目录 —— 运行时目录（%APPDATA%\lanzadorapk\runtime）与已装应用、
 *     快照全都在用户目录里，替换程序文件不会动它们；
 *   - 完整版（便携但带 runtime）：同轻量版，只是目录里多了 resources\runtime。
 *
 * 替换不能在本进程里做（exe 正被占用），所以生成一段 PowerShell 脚本，
 * 用 EncodedCommand 交给独立进程：等本进程退出 → 复制文件 → 重新拉起。
 * 用 base64 传脚本而不是写 .ps1 文件，是为了绕开「路径含中文时脚本被按 GBK 解码」
 * 这类老问题（PowerShell 5.1 读无 BOM 脚本会按 ANSI 解释）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { verifyFile } = require('./integrity');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const { OWNER, REPO } = require('./brand');

/** PowerShell 单引号字符串：内部的 ' 要写成 '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 在目录第一层里按名字（大小写不敏感）找文件，返回实际名字或 null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 在程序目录里找 NSIS 卸载器，找不到返回 null。
 * electron-builder 的默认命名是 `Uninstall <productName>.exe`（updater.flavor 认这个），
 * 老版本/自定义打包也可能叫 `uninstaller.exe`（main.js 旧代码只认这个）。
 * 两处必须用同一套规则，否则安装版点「一键卸载」会被误判成便携版（issue #51）。
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
    // settings() 给 sources 用：决定「走 GitHub 还是 Gitee」「有没有镜像前缀」
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** 安装形态：安装版（有卸载器）还是便携包 */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * 检查更新：GitHub / Gitee 并发问，取版本号更高的，资产取并集。
   * 具体下载地址在 prepare() 里再做一次真实测速排序。
   */
  /**
   * @param {{force?:boolean}} [opts] force=true 时跳过 10 分钟的版本缓存
   *        （用户主动点「检查更新」应该拿到最新结果；启动时的静默检查走缓存）
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // 发行版里同时挂着「便携包」和「运行时整包」（LanzadorAPK-runtime-*.zip）。
    // 兜底的 .zip 匹配必须把运行时整包排除掉：某次发布如果只有运行时整包、
    // 没有便携包，旧逻辑会把它当更新包解压进程序目录（多出 1.5GB 文件、程序也被换坏）。
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
      // 注意带上 parts：Gitee 的分片包没有单一 url，丢掉 parts 就变成「有资产但没地址」
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // 同名资产在 GitHub / Gitee 都有：两个地址都带着，prepare() 里测速择快。
          // sizes 是「每个地址各自的大小」——两个源压出来的字节数并不相同。
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
          sha256: asset.sha256 || '',
        }
        : null,
      assets: merged.assets,
      // 两个源各自的最新版本 / 谁不可达，界面上可以如实显示「这次走的哪个源」
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
   * 下载并准备好「载荷」：便携版解压到 update/<ver>/payload，安装版直接留 Setup.exe。
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

    // Gitee 附件单文件上限 100MB，所以发布时会把包切成 .part1/.part2。
    // 每个分片单独测速选源（可以一部分来自 Gitee、一部分来自 GitHub 镜像），
    // 下完按顺序拼回整包 —— 对用户来说仍然只是「下载 + 解压」。
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Descargando ${it.asset.name}…` });
      // 候选地址 = 源站 + 镜像前缀；先各下 256KB 实测速度，再拿最快的那个分块下载。
      // 这是「GitHub 直连几十 KB/s、镜像能跑几 MB/s」时唯一靠谱的选路方式：
      // 按域名猜没用，同一天不同时段差别很大。
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // 进度用的总大小要取「真正在下那个源」的：GitHub 与 Gitee 的包不是同一份字节
      // （压缩器不同，能差好几 MB），拿错就会一直显示 92% 再突然跳到完成。
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti：分块同时从「GitHub 直连」和「镜像」拉，带宽叠加；
      // 只有一个源可用或对方不支持 Range 时，它自己退回单源分块。
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
      // issue #98：上一次已经下载+解压完成，但替换/重启没成功时，
      // 直接复用这份载荷，绝不再下一遍 100MB —— 这正是「更新死循环」的来源。
      // 就绪标记由本函数写、替换脚本成功后清掉，所以只有完整解压过的载荷才会被复用。
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
   * 下载并拼装分片包。
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
        // 防 zip-slip：统一走 zip.js 的守卫（挡 ../、绝对路径、盘符、反斜杠绕过）
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

  /** 载荷就绪标记文件：解压完整落盘后才写，供跨进程复用判断 */
  _readyFile(payload) { return path.join(payload, '.lanzadorapk-ready'); }

  _markPayloadReady(payload, version) {
    try {
      fs.writeFileSync(this._readyFile(payload), JSON.stringify({ version, at: Date.now() }), 'utf8');
    } catch (_) { /* 标记写不了就下次重下，不影响正确性 */ }
  }

  _payloadReady(payload, version) {
    try {
      if (!fs.existsSync(this._readyFile(payload))) return false;
      const m = JSON.parse(fs.readFileSync(this._readyFile(payload), 'utf8'));
      // 版本不符 = 上次下的是别的版本，不能复用
      if (m.version !== version) return false;
      // 关键：程序主 exe 必须在载荷里。没有它说明解压被中断/被杀软删过。
      const exeName = path.basename(this.exePath || 'LanzadorAPK.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
  }

  /**
   * 启动时调用：找回「上次已下载解压、但替换/重启失败」的更新并续做。
   * 直接走本地载荷，不再重新下载（issue #98 的死循环根治）。
   * @returns {{mode:'zip', payload:string, version:string}|null}
   */
  findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => cmpVer(n, this.current) > 0)   // 只认比当前更新的版本，避免反复重启
        .sort((a, b) => cmpVer(b, a));
      for (const v of versions) {
        const payload = path.join(this.updateDir, v, 'payload');
        if (this._payloadReady(payload, v)) return { mode: 'zip', payload, version: v };
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * 生成并启动「替换 + 重启」脚本，然后调用方负责退出应用。
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] 测试时可指定别的 pid / 不真启动
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
      // 等本进程真正退出（最多 90 秒），否则 exe/dll 仍被占用
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // issue #98：旧脚本只测「目标 exe 是否存在」——它本来就存在，于是 copy
      // 失败也被当成成功，接着删掉载荷、重启旧版本 → 下次开机又检测到更新 → 死循环。
      // 改成：复制前先把目标 exe 改名成 .old，复制后确认新 exe 真的落盘且字节数
      // 与载荷一致；失败则回滚 .old，并**保留载荷**交给下次启动续做。
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
        // 只有确认复制成功，才清掉载荷与就绪标记；否则留给 findResumableJob 续做。
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
      // issue #98：只 Start-Process 一次、失败就无声无息 → 用户看到「关了但没重启」。
      // 加 -WorkingDirectory（便携版相对路径资源），失败再退回 cmd /c start，并写日志。
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
      // 复制失败时保留整个版本目录（载荷 + 就绪标记），交给下次启动续做；
      // 否则会前脚说「保留载荷」后脚又把它删掉，续做永远拿不到文件。
      `if ($applyOk) { Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force }`,
      `else { Note 'version dir kept for resume on next launch' }`,
      // 收尾的清理语句失败（目录已被删/被杀软占用）不应该让调用方以为更新失败
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand 走 UTF-16LE base64：脚本里出现中文路径也不会被 GBK 解码搞坏
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 这里**不能**用 detached：某些安全软件 / 沙箱策略会直接拦掉「分离的控制台进程」，
    // 表现为脚本一声不响地根本没跑（更新界面卡在「正在替换程序并重启」）。
    // Windows 上父进程退出并不会杀掉普通子进程，所以用「普通子进程 + unref」同样能在
    // 我们退出之后继续干活，兼容性还更好。
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** 打不开 UI 的场景（或没有可自动安装的资产）时，把发布页丢给浏览器 */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
