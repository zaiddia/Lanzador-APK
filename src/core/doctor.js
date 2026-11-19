'use strict';
/**
 * 设备自适应 / 自动诊断（零配置底座）
 *
 * 目标：不同机器上都不需要用户调任何参数。
 *  - chooseProfile()  根据物理内存、CPU、磁盘、加速状态、emulator 版本推导启动参数；
 *  - planVariants()   给出「启动失败后依次降级」的重试方案（GPU → 加速 → 内存 → 冷启动）；
 *  - diagnose()       把 emulator 的英文 stderr 翻译成可执行的修复建议；
 *  - shortPath()      处理中文/空格安装路径（emulator 的 QEMU 对非 ASCII 路径极其敏感）。
 *
 * 本模块是纯函数 + 只读探测，不写设置、不拉起 Android，方便单测。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { memoryLimits } = require('./resources');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** 本机画像（毫秒级，只读） */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** 目录所在盘可用空间（MB）；取不到返回 0 */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * 检测 GPU 厂商（NVIDIA / AMD / Intel），用于调整渲染后端优先级。
 * 只在 Windows 上查 WMI；其他平台返回 'unknown'。
 * 结果缓存 10 分钟，避免每次 chooseProfile 都 spawn wmic。
 */
let _gpuVendorCache = { vendor: 'unknown', at: 0 };
function detectGpuVendor() {
  if (process.platform !== 'win32') return 'unknown';
  if (Date.now() - _gpuVendorCache.at < 600000) return _gpuVendorCache.vendor;
  try {
    const { execFileSync } = require('child_process');
    // wmic 在 Win11 24H2+ 已被移除，改用 PowerShell Get-CimInstance
    let names = '';
    try {
      names = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController).Name -join "|"',
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch (_) {
      // 回退到 wmic（老系统仍可用）
      try {
        names = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name', '/format:list'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      } catch (__) { /* ignore */ }
    }
    const lower = String(names).toLowerCase();
    let vendor = 'unknown';
    // 优先匹配独显（NVIDIA/AMD），虚拟显示适配器排在后面
    if (/nvidia|geforce|rtx\s|gtx\s/.test(lower)) vendor = 'nvidia';
    else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/.test(lower)) vendor = 'amd';
    else if (/intel|uhd\s|iris|arc\s/.test(lower)) vendor = 'intel';
    _gpuVendorCache = { vendor, at: Date.now() };
    return vendor;
  } catch (_) {
    _gpuVendorCache = { vendor: 'unknown', at: Date.now() };
    return 'unknown';
  }
}

/**
 * emulator 36.4.9 起把 swiftshader_indirect 标记为弃用，新增 -gpu software。
 * 37.x 上传 swiftshader_indirect 会出现 GL 初始化失败/直接退出（设备差异很大）。
 * 因此必须按版本挑候选，且每个候选都有退路。
 *
 * 按 GPU 厂商微调优先级：
 *   NVIDIA：host 几乎总是最优（驱动成熟），swangle 兜底
 *   AMD：host 在部分驱动下会崩（尤其老驱动），swangle 提到第二优先
 *   Intel：host 通常 OK，但集显性能弱时 swangle 更稳
 *   unknown：保持默认顺序
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  const base = modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
  const vendor = detectGpuVendor();
  if (vendor === 'amd' && modern) {
    // AMD 驱动在某些版本下 host 模式会 GL 初始化失败，把 swangle 提到前面
    return ['swangle', 'host', 'software', 'swiftshader'];
  }
  return base;
}

/** Windows 8.3 短路径：中文用户名 / 中文安装目录时 emulator 会找不到文件 */
/**
 * 屏幕规格。landscape=true 时给出真正的横屏面板（1280x720）。
 *
 * 为什么必须改面板尺寸而不是运行时 wm size：模拟器的 LCD 是「物理面板」，
 * Qt 按面板尺寸开窗口并把画面贴在左上角。运行时改 wm size 只会改 Android 的
 * 逻辑分辨率，物理面板仍是竖的 —— 结果就是画面躺倒 90°、只占左上角一条、
 * 四周大片黑边、点击坐标错位。只有把 hw.lcd.width/height 真的换成横屏并重启，
 * 才能得到「正立 + 铺满」的横屏。
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 被关闭时保持原路径 */ }
  return p;
}

/**
 * 推导零配置启动参数。
 * 用户设置里若显式给了 engine.memoryMB / cores / gpuMode，则作为上限/覆盖，
 * 但不会再因为「没设置」而用 4G/4核 硬编码把小内存机器搞崩。
 */
/**
 * 「轻量容器」配额：只约束最影响主机手感的那一项 —— vCPU 数。
 *
 * 旧逻辑给 16 核机器分 4 核，qemu 的 4 个 vCPU 线程会长期占满物理核，
 * Windows 桌面、鼠标、浏览器只能抢剩下的时间片，表现就是「一打开就卡」。
 * 实际跑一个 Android App 2 个 vCPU 已经绰绰有余，多给只是拖慢主机。
 *
 * 内存、分辨率刻意不动：内存上限本来就是 2~3G，降分辨率还会让 quickboot
 * 快照指纹变化、每次切模式都要重新冷启动，得不偿失。
 *
 * 纯函数，settings 为 null 时返回 null（保持旧调用方/单测的行为不变）。
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // 老逻辑是 floor(核数/4) 再夹到 2~3 —— 8 核机器只给 2 个 vCPU，软件解码视频
    // （红果/抖音这类）直接卡成幻灯片。改成「一半物理核、上限 4」：
    // 8 核给 4、4 核给 2，桌面仍有富余核，视频也够用。
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3GB 足够 Android 14 与主流应用；再高只会放大内存占用和 quickboot 快照体积
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // 「省资源」模式：刷视频/看小说这类轻负载用不到 3G，把上限压到 2G。
  // 直接效果是 qemu 常驻内存少约 1GB、quickboot 快照也小 1GB（磁盘同步受益）。
  // 只有用户没手动指定内存时才收敛，手动值永远优先。
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // 物理可用内存不够时下调；Android 14 最低 2G，低于此只能靠 TCG 慢速跑
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) {
    // 上限跟着宿主走：早先写死 8192，结果 32GB 机器上也最多只能分 8GB，
    // 大型游戏（尤其带高清资源包的）进场景就频繁回收贴图，表现是卡顿/黑屏。
    const lim = memoryLimits(host.totalMB);
    memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, lim.maxMB);
  }

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) {
    // 同样跟着宿主：至少留 1 核给 Windows，单核机器仍然给 1 核
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // 用户没手动指定核数时才由轻量模式收敛，手动值永远优先
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data 容量：应用本体、游戏资源包和它们的「更新包」都占这里，4GB 太容易满
  // （表现就是应用内更新时提示「磁盘空间不足」）。默认按磁盘余量给 6/8GB，
  // 用户也可以直接在设置里指定（改大后下次开机就地扩容，不丢数据）。
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // 自动值也跟磁盘余量走：50GB 级游戏解包后接近 90GB，余量大的机器给 16GB 起步，
  // 免得装完第一个大游戏就开始报「空间不足」。
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // 用户指定时按「所在磁盘的 80%」封顶：填 128GB 但盘里只有 20GB，只会装到一半失败
  const dataMaxMB = disk ? Math.max(2048, Math.floor((disk * 0.8) / 1024) * 1024) : 262144;
  const dataMB = wantGB > 0
    ? clamp(Math.round(wantGB * 1024), 2048, Math.min(262144, dataMaxMB))
    : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // 渲染分辨率：auto 时按加速状态选（软件模拟降到 540x960 保流畅）
  // 横屏优先：横屏是由「物理面板尺寸」决定的，必须写进 AVD 并重启才生效，
  // 所以这里先按 settings.display.landscape 定方向，再叠加 renderSize。
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // 用户显式分辨率若与当前方向不一致，按方向校正（横屏取长边作宽）
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // 无加速的纯软件模拟在 Windows 上确实能起来，但 Android 14 冷启动可能 5-10 分钟
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * 把「高级参数」里的用户设置转成 overrides。
 * 0 / auto / 未设置一律视为「不覆盖」，仍然走自动推导；
 * 只有用户主动关掉自动内存并填了具体数值才生效。
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * 展示 / 诊断用的统一入口：不启动 Android 也能算出与真实开机一致的参数。
 * 之前设置页直接调 chooseProfile()（不带版本和加速状态），会在 37.x 机器上
 * 错误地显示已弃用的 swiftshader_indirect / 软件模拟，和实跑参数对不上。
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // host 可注入：单测/诊断想复现「4 核小机器」时不用真的换机器。
    // 不传就按本机实际情况算（正常运行时都是这条路径）。
    host: host || hostInfo(),
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * 失败重试矩阵：从「最优」到「最保守」，最多 4 次。
 * 依次换 GPU 后端 → 关硬件加速走 TCG → 降内存并强制冷启动清快照。
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'aceleración por hardware' : 'Emulación por software'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Emulación por software sin aceleración (lenta, pero la más compatible)',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Arranque en frío conservador (memoria mínima + sin instantánea)',
    // 这里**绝对不能** wipe：以前写的是 wipe:true，而磁盘写满时每次尝试都会失败，
    // 于是连续重试把用户已装的应用和存档一起「清快照 + 清数据」了 ——
    // 「磁盘满了，结果打开 LanzadorAPK 应用全没了」就是这么发生的。
    // 需要重建 userdata 时由 ensureDataPartition 自己判断（它只在镜像损坏时重建），
    // 不靠启动参数里的 -wipe-data。
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Deduplicate: never retry the same gpu/accel/wipe/memory/snapshot combination twice.
  // On low-RAM hosts (memoryMB already 2048) the "software" step and the last-resort step
  // used to be identical, wasting a full boot timeout (up to 4 min). When they collide, the
  // last-resort step (smaller data partition, flagged lastResort) replaces the earlier one.
  const byKey = new Map();
  for (const v of out) {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}`;
    if (!byKey.has(k) || v.lastResort) byKey.set(k, v);
  }
  return out.filter((v) => byKey.get(`${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}`) === v);
}

/** 检测一对空闲端口（emulator console + adb 注册端口必须相邻偶数/奇数） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * adb server 端口：固定不复用探测。
 * 之前是"从 5044 往上找一个空闲端口"，但 adb server 本身是常驻进程，占着这个端口，
 * 于是每启动一次 LanzadorAPK 就会多一个 adb server（实测一次会话跑出 6 个），
 * 而且端口老是变，下次启动想接管上次的模拟器时对不上号。
 * 5044 是 LanzadorAPK 专用端口（用户自己的 adb 在 5037），直接固定用。
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.LANZADORAPK_ADB_PORT) || start;
}

/**
 * 配置指纹：只有「镜像 / 数据分区 / 引擎版本」变化才作废快照。
 * 故意不包含 GPU、加速方式、内存 —— 那些是自动重试会频繁切换的参数，
 * 若纳入会让每次重试都触发 -wipe-data，把用户已装的应用清空。
 */
/**
 * quickboot 快照的「配置指纹」：只有这些变化会让旧快照失效（加载后黑屏/起不来）。
 *
 * 刻意**不包含 dataMB**：数据分区调大以后旧快照照样能用（qemu 会按新的分区大小
 * 重新挂载），把它算进指纹的后果是「用户只想扩个容，结果快照作废 + 冷启动 +
 * 数据被删」—— 实测踩过一次，代价是整机应用全丢。
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * 系统镜像的「身份」：只保留 `system-images/...` 之后的部分。
 *
 * 镜像放哪个盘都无所谓，同一套镜像换个目录不该被当成「换了镜像」——
 * 否则用户把运行时从 C 盘挪到 D 盘（我们自己在设置里就建议这么做）以后，
 * AVD 里的 sysdir 与新路径不一致 → 判定镜像变了 → -wipe-data → 已装应用全丢。
 * 这个坑在实测中真的会踩到，所以两个地方（AVD 配置、快照指纹）都必须用身份而不是绝对路径。
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // Windows 上 emulator/qemu 以 0xC0000005（十进制 3221225477）退出：
    // 实测多见于「显卡驱动 / Vulkan 后端在 guest 刚要启动时崩掉」，
    // 与 CPU、内存、镜像都无关（同机换 -gpu software 往往就能过）。
    // 必须排在 GPU_INIT 前面：崩溃日志里通常也带着渲染初始化信息，先判崩溃更准。
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'El motor de renderizado falló (violación de acceso 0xC0000005)',
    hint: 'Se reintentó automáticamente con un motor de renderizado más conservador, y se recordará para no volver a probar el anterior primero. '
      + 'Si se repite, actualiza el controlador de la tarjeta gráfica; o baja la calidad en Configuración → Rendimiento y recursos, y desactiva el escritorio remoto o el paso de GPU a máquinas virtuales.',
  },
  {
    code: 'GPU_INIT',
    // 只匹配「失败」语境：正常日志里也会出现 Vulkan/EGL/ANGLE 字样，不能误判为致命错误
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'No se pudo iniciar el motor de renderizado de la GPU',
    hint: 'Se cambió automáticamente a renderizado por software. Si sigue fallando, actualiza el controlador de la tarjeta gráfica o desactiva el escritorio remoto o el paso de GPU a máquinas virtuales.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'El runtime actual no acepta este modo de GPU',
    hint: 'Se reintentó automáticamente con un modo de GPU compatible con la versión del runtime (swiftshader_indirect en versiones antiguas, software en las nuevas).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: 'Aceleración por hardware no disponible',
    hint: 'Se pasó automáticamente a emulación por software (el primer arranque será bastante más lento). Para que vaya fluido, marca «Plataforma de máquina virtual» en «Características de Windows» o instala el controlador AEHD y reinicia.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足|memoria insuficiente/i,
    title: 'Error al asignar memoria',
    hint: 'Se redujo automáticamente la memoria y los núcleos asignados a Android. Cierra programas que usen mucha memoria e inténtalo de nuevo.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'El puerto del emulador está ocupado',
    hint: 'Se cambió automáticamente a un puerto libre. Si se repite, cierra otros emuladores (BlueStacks, Nox, MuMu, etc.) o reinicia el equipo.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'La ejecución anterior dejó archivos de bloqueo',
    hint: 'Se borraron automáticamente los archivos de bloqueo del AVD y se volvió a iniciar.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'La imagen del sistema falta, está dañada o no es compatible con los datos de usuario anteriores',
    hint: 'Se reinició automáticamente con datos de usuario limpios. Si sigue fallando, borra la imagen en «Runtime» y vuelve a descargarla.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: 'El antivirus borró componentes del runtime o falta Microsoft Visual C++ Redistributable',
    hint: 'Agrega la carpeta de Lanzador APK a las exclusiones del antivirus, vuelve a descomprimir el instalador e instala Microsoft VC++ 2015-2022.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足|espacio en disco insuficiente/i,
    title: 'No hay espacio en disco suficiente para iniciar Android',
    hint: 'Mueve la carpeta del runtime (Configuración → Integración con el sistema → Carpeta de datos del runtime) a un disco con espacio suficiente, '
      + 'o desactiva «Conservar instantánea de arranque rápido» / reduce la partición de datos en Configuración. Los datos de Android no se borran automáticamente.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
    title: 'La ruta de instalación tiene acentos o caracteres especiales',
    hint: 'Se usó automáticamente la ruta corta de Windows. Si sigue fallando, mueve Lanzador APK a una carpeta con nombre solo en ASCII (p. ej. C:\\LanzadorAPK).',
  },
  {
    // 上次被强制结束后 AVD 目录会留下 hardware-qemu.ini.lock / multiinstance.lock，
    // 模拟器一律拒绝启动，报出来的却是容易被误读成 CPU 问题的话。必须排在 CPU 规则前。
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'La ejecución anterior no se cerró bien y dejó archivos de bloqueo',
    hint: 'Lanzador APK borrará los bloqueos y lo reintentará; si se repite, revisa si otro emulador está usando el mismo runtime.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'A la CPU le faltan instrucciones que el runtime necesita',
    hint: 'En algunas CPU antiguas esto es solo una advertencia y Android arranca igual; si de verdad no arranca, usa en «Runtime» una versión del motor más antigua y compatible, o un equipo con VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Instantánea de arranque rápido dañada',
    hint: 'Se descartó automáticamente la instantánea y se hizo un arranque en frío; la próxima salida normal generará una nueva.',
  },
];

/** 把日志翻译成 {code,title,hint}，供 UI 展示与自动重试决策 */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'El runtime no terminó de arrancar',
    hint: 'Se reintentó automáticamente con varias combinaciones de parámetros. Pulsa «Exportar informe de diagnóstico» y envía el registro al equipo de soporte para revisarlo.',
  };
}

/** 人类可读的一行摘要，放在设置页让高级用户知道自动选了什么 */
function describeProfile(p) {
  return `Automático: ${(p.memoryMB / 1024).toFixed(1)}GB de memoria · ${p.cores} núcleos · ${p.gpu} renderizado · `
    + `${p.accelOk ? 'aceleración por hardware' : 'Emulación por software'} · ${p.snapshot ? 'instantánea bajo demanda' : 'arranque en frío'}`
    + `${p.lite ? ' · contenedor ligero' : ''} · puerto ${p.port}`;
}

/** 导出诊断报告（纯文本，便于发邮件/贴 issue） */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'Informe de diagnóstico de Lanzador APK',
    `Generado: ${new Date().toLocaleString()}`,
    '',
    '== Este equipo ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Configuración automática ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Diagnóstico ==',
    `${d.code}: ${d.title}`,
    d.hint,
    '',
    '== Información adicional ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Registro del runtime (últimas 300 líneas) ==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * 检测微软 VC++ 2015-2022 x64 运行库是否安装。
 * 安卓模拟器（Qt6）与 qemu 都依赖它；缺了在「其他电脑」上会直接起不来
 * （报 0xc0000135 / MSVCP140 缺失）。安装版我们已内置 vc_redist.x64.exe，
 * 这里只做检测，供启动前给出明确提示与一键安装入口。
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // 先看 DLL：msvcp140 / vcruntime140 正是 Qt6 与 qemu 真正依赖的两个文件。
  // 用文件判断既不用起 reg.exe（部分安全软件会拦、也会拖慢每 60s 的自检），
  // 也不会因为注册表项被清理工具删掉而误报「没装」。
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* 走注册表兜底 */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* 键不存在 = 没装 */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, detectGpuVendor, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
