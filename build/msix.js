'use strict';
/**
 * Empaquetado para Microsoft Store (MSIX).
 *
 * Por qué no se usa el destino appx de electron-builder:
 *   - la 26.x solo tiene appx (no msix) y al compilar descarga a escondidas todo un juego de herramientas del Windows SDK
 *     (windows-kits-bundle-10_0_26100_0.zip) como dependencia opaca;
 *   - necesitamos poner cosas propias en el manifiesto (runFullTrust, asociación de archivos, la identidad
 *     que corresponde a las notas de revisión); escribir el manifiesto a mano es más controlable que modificar su plantilla.
 * Por eso aquí armamos el stage y llamamos a makeappx nosotros mismos; solo dependemos de dos exe del Windows SDK.
 *
 * Uso:
 *   node build/msix.js                       # paquete sin firmar desde dist/release/win-unpacked
 *   node build/msix.js --stage <dir>         # carpeta ya desempaquetada
 *   node build/msix.js --sign                # genera un certificado autofirmado y firma (para pruebas locales)
 *   node build/msix.js --identity Name --publisher "CN=..." --display Nombre
 *
 * También con variables de entorno: LANZADORAPK_MSIX_IDENTITY / LANZADORAPK_MSIX_PUBLISHER / LANZADORAPK_MSIX_DISPLAY
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodePng, drawAppIcon } = require('../src/core/png');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

// ---------------- Parámetros ----------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const VERSION = String(pkg.version || '0.0.0');
// La versión MSIX debe tener cuatro partes y la cuarta siempre 0 (requisito de la Store)
function msixVersion(v) {
  const p = String(v).split(/[.\-+]/).filter((x) => /^\d+$/.test(x)).slice(0, 3);
  while (p.length < 3) p.push('0');
  return `${p[0]}.${p[1]}.${p[2]}.0`;
}

// Los dos valores de Partner Center → Product management → Product identity.
// Se dejan como valores por defecto a propósito; si el valor por defecto fuera un marcador cualquiera,
// un `node build/msix.js` hecho al azar generaría un paquete que la Store rechazaría.
const PLACEHOLDER_PUBLISHER = 'CN=zaiddia';
const CONFIRMED_IDENTITY = 'zaiddia.LanzadorAPK';
// Fill in the value from Partner Center → Product management → Product identity.
const CONFIRMED_PUBLISHER = 'CN=PON-AQUI-TU-PUBLISHER-DE-PARTNER-CENTER';
const IDENTITY = arg('identity') || process.env.LANZADORAPK_MSIX_IDENTITY || CONFIRMED_IDENTITY;
const PUBLISHER = arg('publisher') || process.env.LANZADORAPK_MSIX_PUBLISHER || CONFIRMED_PUBLISHER;
const PUBLISHER_DISPLAY = arg('publisherDisplay') || process.env.LANZADORAPK_MSIX_PUBLISHER_DISPLAY || 'zaiddia';
const DISPLAY = arg('display') || process.env.LANZADORAPK_MSIX_DISPLAY || 'LanzadorAPK';
const APP_ID = arg('appId') || 'LanzadorAPK';
const DO_SIGN = !!arg('sign', false);

const STAGE = path.resolve(String(arg('stage')
  || path.join(ROOT, 'dist', 'release', 'win-unpacked')));
const OUT_DIR = path.resolve(String(arg('out') || path.join(ROOT, 'dist', 'store')));

/**
 * Elige la «carpeta de contenido»: el LanzadorAPK.exe + resources que van en `app\` dentro del MSIX.
 *
 * Dos fuentes posibles, primero la que no necesita red:
 *   A. dist/LanzadorAPK-win64-portable: resultado de `node build/pack.js`, **no necesita internet**.
 *      Solo tiene el envoltorio sin runtime, así que aquí se copia además build/runtime a
 *      resources/runtime (lo mismo que hace extraResources de electron-builder).
 *   B. dist/release/win-unpacked: resultado de `electron-builder --win dir`, trae
 *      resources/runtime. Pero ese paso descarga herramientas de una CDN y sin red queda a medias
 *      (solo electron.exe, sin copiar el runtime), así que es la segunda opción.
 *
 * Con --payload se puede indicar explícitamente.
 */
function resolvePayload() {
  const explicit = arg('payload');
  if (explicit) return { dir: path.resolve(String(explicit)), addRuntime: false };
  const portable = path.join(ROOT, 'dist', 'LanzadorAPK-win64-portable');
  const runtime = path.join(ROOT, 'build', 'runtime');
  if (fs.existsSync(path.join(portable, 'LanzadorAPK.exe'))) {
    const hasRuntime = fs.existsSync(path.join(portable, 'resources', 'runtime', 'emulator', 'emulator.exe'));
    return { dir: portable, addRuntime: !hasRuntime && fs.existsSync(runtime), runtime };
  }
  return { dir: STAGE, addRuntime: false };
}

// ---------------- Iconos de recursos ----------------
// El manifiesto solo usa las 5 imágenes de tamaño 100 %. Si en la carpeta aparecen archivos .scale-* / .targetsize-*
// hay que generar además resources.pri (makepri) y la complejidad se dispara; la primera versión no lo toca.
const ASSETS = [
  { file: 'StoreLogo.png', w: 50, h: 50 },
  { file: 'Square44x44Logo.png', w: 44, h: 44 },
  { file: 'Square71x71Logo.png', w: 71, h: 71 },
  { file: 'Square150x150Logo.png', w: 150, h: 150 },
  { file: 'Square310x310Logo.png', w: 310, h: 310 },
  { file: 'Wide310x150Logo.png', w: 310, h: 150 },
  { file: 'SplashScreen.png', w: 620, h: 300 },
];

const BG = [20, 22, 27];        // #14161b fondo oscuro
const ACCENT = [61, 220, 132];  // #3ddc84 verde Android

/** Prueba de rectángulo redondeado (para dibujar el icono de marca en lienzos no cuadrados) */
function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Dibuja en el centro de un lienzo w×h el icono de marca de lado side (bloque oscuro redondeado + triángulo verde) */
function composeIcon(w, h, side) {
  const rgba = new Uint8Array(w * h * 4);
  const ox = (w - side) / 2;
  const oy = (h - side) / 2;
  const pad = side * 0.06;
  const box = { x: ox + pad, y: oy + pad, w: side - pad * 2, h: side - pad * 2, r: side * 0.24 };
  const tW = side * 0.30;
  const tH = side * 0.34;
  const tcx = ox + side * 0.5 + side * 0.02;
  const tcy = oy + side * 0.5;
  const ax = tcx - tW * 0.38;
  const ay = tcy - tH / 2;
  const bx = tcx - tW * 0.38;
  const by = tcy + tH / 2;
  const cx2 = tcx + tW * 0.62;
  const cy2 = tcy;
  const inTri = (px, py) => {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx2) * (by - cy2) - (bx - cx2) * (py - cy2);
    const d3 = (px - ax) * (cy2 - ay) - (cx2 - ax) * (py - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Fondo: todo oscuro (mosaicos y pantalla de inicio son fondos completos)
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      let a = 255;
      const px = x + 0.5;
      const py = y + 0.5;
      if (inRoundRect(px, py, box.x, box.y, box.w, box.h, box.r)) {
        const t = (x / w) * 0.6 + (y / h) * 0.4;
        r = Math.round(20 + t * 14);
        g = Math.round(26 + t * 18);
        b = Math.round(33 + t * 24);
        if (inTri(px, py)) { r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2]; }
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return encodePng(w, h, rgba);
}

/** Recursos prerenderizados: logo principal y logos pequeños generados por build/build-icons.js */
const STORE_ASSETS = path.join(ROOT, 'build', 'store-assets');

function writeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const made = [];
  for (const a of ASSETS) {
    const pre = path.join(STORE_ASSETS, a.file);
    let buf = null;
    if (fs.existsSync(pre)) {
      buf = fs.readFileSync(pre);
    } else {
      // Respaldo: si no se ejecutó build-icons igual se genera el paquete, pero los iconos pueden no ser coherentes entre tamaños
      buf = (a.w === a.h)
        ? drawAppIcon(a.w)
        : composeIcon(a.w, a.h, Math.min(a.h * 0.72, a.w * 0.42));
      console.warn(`  [回退] ${a.file} 未在 build/store-assets 找到，改用程序化绘制`);
    }
    fs.writeFileSync(path.join(dir, a.file), buf);
    made.push(`${a.file} ${a.w}x${a.h}`);
  }
  return made;
}

// ---------------- Manifiesto ----------------

function manifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  LanzadorAPK · Microsoft Store (MSIX) 清单
  由 build/msix.js 生成，不要手改；改模板请改 build/msix.js。

  两个必须和 Partner Center 逐字一致的字段：
    Identity/@Name          ← Product identity → Package/Identity/Name
    Identity/@Publisher     ← Product identity → Package/Identity/Publisher
  本地自签测试时，Publisher 必须等于自签证书的 Subject。
-->
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">

  <Identity
    Name="${IDENTITY}"
    Publisher="${PUBLISHER}"
    Version="${msixVersion(VERSION)}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${DISPLAY}</DisplayName>
    <PublisherDisplayName>${PUBLISHER_DISPLAY}</PublisherDisplayName>
    <Description>${pkg.description || DISPLAY}</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>

  <Resources>
    <Resource Language="es-ES" />
    <Resource Language="en-US" />
  </Resources>

  <Capabilities>
    <!-- 全信任桌面应用（Desktop Bridge）唯一必需的能力。 -->
    <rescap:Capability Name="runFullTrust" />
    <!--
      刻意不声明 unvirtualizedResources / broadFileSystemAccess：
      前者只给微软及其合作方发行的 PC 游戏，Store 基本不批；后者是给
      AppContainer 应用突破沙箱用的，full-trust 应用本来就是用户身份。
      为了避开 AppData 写重定向，我们把数据目录放到了 %USERPROFILE%\\LanzadorAPK，
      完全不进虚拟化范围（见 src/core/store.js 的 STORE_BUILD）。
    -->
  </Capabilities>

  <Applications>
    <Application Id="${APP_ID}" Executable="app\\LanzadorAPK.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${DISPLAY}"
        Description="${pkg.description || DISPLAY}"
        BackgroundColor="#14161B"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <!--
          小磁贴/大磁贴的 logo 只能挂在 uap:DefaultTile 上，不能写在
          uap:VisualElements 的属性里 —— 放错位置时 MakeAppx 会直接拒收整个包：
          "?? DTD/??????? 'VisualElements' ??? 'Square71x71Logo'?"
          （0x80080204 The package manifest is not valid）
        -->
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png"
          Square71x71Logo="Assets\\Square71x71Logo.png"
          Square310x310Logo="Assets\\Square310x310Logo.png" />
        <uap:SplashScreen Image="Assets\\SplashScreen.png" BackgroundColor="#14161B" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;
}

// ---------------- Buscar makeappx / signtool ----------------

function which(exe) {
  const cands = [];
  const push = (p) => { if (p) cands.push(p); };
  // 1) PATH
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
  }
  // 2) Windows SDK (cualquier 10.0.x, preferiblemente x64)
  const kits = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'App Certification Kit'),
  ];
  for (const k of kits) {
    let versions = [];
    try { versions = fs.readdirSync(k); } catch (_) { continue; }
    for (const v of versions) {
      for (const arch of ['x64', 'x86', '']) {
        const p = arch ? path.join(k, v, arch, exe) : path.join(k, v, exe);
        try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
      }
    }
  }
  // 3) caché de herramientas que descarga electron-builder (existe tras ejecutar una vez --win appx)
  const cacheRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  const stack = [cacheRoot];
  let guard = 0;
  while (stack.length && guard < 6000) {
    const dir = stack.pop();
    guard += 1;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === exe.toLowerCase()) push(p);
    }
  }
  if (!cands.length) return null;

  /**
   * Elige la versión más nueva de la herramienta.
   *
   * Este paso es clave: el juego de herramientas de winCodeSign trae signtool.exe de tres generaciones,
   * windows-6 / windows-8 / windows-10. El de windows-6 falla al firmar MSIX con
   * `0x80080209 (SignerSign failed)` porque no conoce la estructura SIP de MSIX.
   * Por eso hay que preferir explícitamente windows-10\x64, no «el primero que aparezca».
   */
  const score = (p) => {
    const l = p.toLowerCase();
    let s = 0;
    if (/\\windows-10\\x64\\/.test(l)) s += 100;
    else if (/\\windows-10\\/.test(l)) s += 60;
    if (/\\windows-1[01]\\x64\\/.test(l)) s += 40;
    if (/\\x64\\/.test(l)) s += 10;
    if (/\\windows-6\\|\\windows-8\\|\\darwin\\|\\linux\\/.test(l)) s -= 200;
    return s;
  };
  cands.sort((a, b) => (score(b) - score(a)) || b.localeCompare(a, 'en'));
  return cands[0];
}

function run(exe, args, opts = {}) {
  return execFileSync(exe, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

// Vigilante de independencia: el MSIX no puede contener MuMu u otros emuladores de terceros (el runtime propio es la única dependencia)
const { assertStandalone } = require('./guard-standalone');

// ---------------- Flujo principal ----------------

function stagePackage() {
  const pick = resolvePayload();
  const appSrc = pick.dir;
  if (!fs.existsSync(path.join(appSrc, 'LanzadorAPK.exe'))) {
    console.error(`\n找不到 ${path.join(appSrc, 'LanzadorAPK.exe')}。`);
    console.error('两条路：');
    console.error('  A) node build/pack.js          （离线，推荐；本脚本会自动把 build/runtime 塞进去）');
    console.error('  B) npx electron-builder --win dir --x64 --config electron-builder.yml');
    console.error('     —— 这一步会去 CDN 拉工具集，没网时只会解一半，最后 Win-unpacked 是残的。\n');
    process.exit(1);
  }
  const work = path.join(OUT_DIR, '.stage');
  fs.rmSync(work, { recursive: true, force: true });
  const appDir = path.join(work, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  console.log(`复制应用载荷（来源 ${appSrc}）…`);
  fs.cpSync(appSrc, appDir, { recursive: true });
  // Son archivos intermedios de Electron/electron-builder; no deben ir en el paquete
  for (const junk of ['builder-debug.yml', 'builder-effective-config.yaml', '.icon-ico', 'VERSION.txt']) {
    fs.rmSync(path.join(appDir, junk), { force: true, recursive: true });
  }
  // La versión portátil no trae runtime: se copia build/runtime (equivale a extraResources de electron-builder)
  if (pick.addRuntime) {
    console.log(`内置运行时 ${pick.runtime} → app/resources/runtime（约 1 GB，需要一会儿）…`);
    fs.cpSync(pick.runtime, path.join(appDir, 'resources', 'runtime'), { recursive: true });
  }
  const rtExe = path.join(appDir, 'resources', 'runtime', 'emulator', 'emulator.exe');
  if (!fs.existsSync(rtExe)) {
    console.error(`\n警告：${rtExe} 不存在 —— 这个包装上之后仍会联网下载运行时。`);
    console.error('先跑 node build/prepare-runtime.js 生成 build/runtime。\n');
  } else {
    console.log('运行时已内置（emulator / platform-tools / system-images）');
  }
  // Revisión inmediata tras armar el contenido: el paquete de la Store debe traer su runtime y no incluir emuladores de terceros
  assertStandalone(appDir, { label: 'MSIX 载荷 app/' });
  console.log('生成商店图标…');
  const made = writeAssets(path.join(work, 'Assets'));
  for (const m of made) console.log(`  ${m}`);
  fs.writeFileSync(path.join(work, 'AppxManifest.xml'), manifest(), 'utf8');
  console.log(`清单：Identity=${IDENTITY} Publisher=${PUBLISHER} Version=${msixVersion(VERSION)}`);
  return work;
}

function main() {
  console.log(`LanzadorAPK MSIX 打包  版本 ${VERSION} → ${msixVersion(VERSION)}`);
  // Vigilante de identidad: un paquete con Publisher de marcador siempre lo rechaza la Store (0x800B0109 / identidad no coincide).
  // Avisar en la documentación no basta: el valor por defecto llegó a ser un marcador y una recompilación casual sobrescribió el paquete bueno.
  if ((/PON-AQUI/i.test(String(PUBLISHER)) || PUBLISHER === PLACEHOLDER_PUBLISHER) && !process.argv.includes('--allow-placeholder')) {
    console.error(`\nPublisher 不是 Partner Center 确认过的值：${PUBLISHER}`);
    console.error(`已确认值是 ${CONFIRMED_PUBLISHER}（Identity ${CONFIRMED_IDENTITY}）。`);
    console.error('占位 Publisher 打出来的包上传时会被商店直接拒收。');
    console.error('确实要打占位版（仅本地试验，不上架）就加 --allow-placeholder。\n');
    process.exit(3);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = stagePackage();

  const makeappx = which('makeappx.exe');
  if (!makeappx) {
    console.error('\n找不到 makeappx.exe。两条路任选：');
    console.error('  A. 装 Windows SDK（只勾 Windows SDK 即可，不用装 Visual Studio）：');
    console.error('     https://developer.microsoft.com/windows/downloads/windows-sdk/');
    console.error('  B. 先跑一次 npx electron-builder --win appx，让它把 windows-kits-bundle 下到缓存里，');
    console.error('     这个脚本会自动从 electron-builder 缓存里找。');
    console.error(`\nstage 目录已经准备好，手工打包：\n  "${'<makeappx.exe>'}" pack /d "${work}" /p "${path.join(OUT_DIR, artifactName())}" /o\n`);
    process.exit(2);
  }
  const out = path.join(OUT_DIR, artifactName());
  console.log(`\n用 ${makeappx} 打包…`);
  fs.rmSync(out, { force: true });
  run(makeappx, ['pack', '/d', work, '/p', out, '/o', '/v']);

  const mb = fs.statSync(out).size / 1048576;
  console.log(`\n完成：${out}  (${mb.toFixed(0)} MB)`);

  // Autocomprobación con ZipFile de .NET: el paquete debe tener manifiesto + mapa de bloques + tipos de contenido
  try {
    const { execFileSync: ex } = require('child_process');
    const ps = [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem;`
      + `$z=[IO.Compression.ZipFile]::OpenRead('${out.replace(/'/g, "''")}');`
      + `$n=$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose();`
      + `foreach($k in @('AppxManifest.xml','AppxBlockMap.xml','[Content_Types].xml')){`
      + ` if($n -contains $k){ "OK   $k" } else { "MISS $k" } }`
      + `"entries: " + $n.Count`,
    ];
    ex('powershell.exe', ps, { stdio: 'inherit', windowsHide: true });
  } catch (_) { /* Si la autocomprobación falla, el resultado no se ve afectado */ }

  if (DO_SIGN) sign(out);
  else {
    console.log('\n未签名（Store 会用自己的证书重签，提交时不需要签名）。');
    console.log('本地想装的话加 --sign 生成自签证书并签名。');
  }
  // stage es un intermedio de 1,3 GB; conservarlo no sirve y hace pensar que «el paquete está duplicado»,
  // así que se borra tras empaquetar con éxito (para depurar, agrega --keep-stage).
  if (!process.argv.includes('--keep-stage')) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
      console.log('已清理中间目录 dist/store/.stage');
    } catch (_) { /* Si está en uso se deja; no afecta el resultado */ }
  }
  console.log('\nAntes de subirlo a la Store, revisa la sección «Microsoft Store» del README.');
}

function artifactName() {
  return `LanzadorAPK_${msixVersion(VERSION)}_x64.msix`;
}

function sign(file) {
  const signtool = which('signtool.exe');
  if (!signtool) {
    console.error('\n找不到 signtool.exe，跳过签名。');
    return;
  }
  const pfx = path.join(OUT_DIR, 'LanzadorAPK-test.pfx');
  const pwd = process.env.LANZADORAPK_MSIX_PFX_PASSWORD || 'LanzadorAPK!test';
  const subject = PUBLISHER;   // Debe coincidir exactamente con el Publisher del manifiesto
  if (!fs.existsSync(pfx)) {
    console.log(`\n生成自签证书（Subject=${subject}）…`);
    const ps = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$c = New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature`
      + ` -CertStoreLocation 'Cert:\\CurrentUser\\My'`
      + ` -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')`
      + ` -Subject '${subject}' -FriendlyName 'LanzadorAPK MSIX Test';`
      + `$p = ConvertTo-SecureString -String '${pwd}' -Force -AsPlainText;`
      + `Export-PfxCertificate -Cert ("Cert:\\CurrentUser\\My\\" + $c.Thumbprint) -FilePath '${pfx}' -Password $p | Out-Null;`
      + `"thumbprint=" + $c.Thumbprint`,
    ];
    try { run('powershell.exe', ps); } catch (e) { console.error(`生成证书失败：${e.message}`); return; }
  }
  console.log('签名…');
  try {
    run(signtool, ['sign', '/a', '/v', '/fd', 'SHA256', '/f', pfx, '/p', pwd, file]);
  } catch (e) {
    console.error(`签名失败：${e.message}`);
    console.error('\n注意：electron-builder 缓存里的 winCodeSign 工具集是裁剪过的，');
    console.error('里面的 signtool.exe 签 MSIX 会报「A required function is not present」');
    console.error('（缺少 MSIX 的 SIP 提供程序注册）。真要本地试装，请用完整 Windows SDK 里的 signtool：');
    console.error('  "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe" \\');
    console.error(`    sign /fd SHA256 /a /f "${pfx}" /p "${pwd}" "${file}"`);
    console.error('\n**上架不需要本地签名**：Microsoft Store 会用自己的证书重签你上传的包。');
    return;
  }
  console.log('\n信任证书（管理员 PowerShell 里执行一次，之后才能 Add-AppxPackage）：');
  console.log(`  Import-PfxCertificate -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople' -FilePath '${pfx}' -Password (ConvertTo-SecureString '${pwd}' -Force -AsPlainText)`);
  console.log(`  Add-AppxPackage -Path '${file}'`);
}

if (require.main === module) main();

module.exports = { msixVersion, manifest, composeIcon, which, ASSETS };
