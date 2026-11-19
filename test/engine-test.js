'use strict';
/**
 * Pruebas del motor y de la cadena de arranque inicial (sin QEMU / adb / Android reales)
 * Cubre: descargador (con reanudación), descompresión ZIP, comprobación del entorno, parámetros de arranque de QEMU, protocolo del monitor
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// Carpeta de datos de prueba aislada, para no contaminar la configuración real del usuario
const TMP = path.join(os.tmpdir(), `lanzadorapk-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'lanzadorapk'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Aserción fallida'); }

(async () => {
  console.log('\n[download.js]');
  const { download, downloadParallel, head, sha256File } = require('../src/core/download');

  // Servidor HTTP local que simula la fuente de descarga (con reanudación por Range)
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': payload.length - start,
        });
        return res.end(payload.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': payload.length });
      return res.end(payload);
    }
    // Soporte completo de Range start-end (para la prueba de bloques en paralelo)
    if (req.url === '/ranged.bin') {
      server.rangeHits = (server.rangeHits || 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        return res.end(payload);
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
      });
      return res.end(payload.subarray(start, end + 1));
    }
    // Sin soporte explícito de Range
    if (req.url === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'none' });
      return res.end(payload);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/big.bin' });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('Descarga completa + seguir redirecciones', async () => {
    const dest = path.join(TMP, 'dl1.bin');
    await download(`http://127.0.0.1:${port}/redirect`, dest);
    assert(fs.statSync(dest).size === payload.length, 'El tamaño no coincide');
  });

  await test('Reanudación de descarga (ya hay un archivo a medias)', async () => {
    const dest = path.join(TMP, 'dl2.bin');
    fs.writeFileSync(dest, payload.subarray(0, 100000));
    let lastPercent = 0;
    await download(`http://127.0.0.1:${port}/big.bin`, dest, {
      onProgress: (p) => { lastPercent = p.percent; },
    });
    assert(fs.statSync(dest).size === payload.length, `Tamaño tras reanudar ${fs.statSync(dest).size}`);
    assert(fs.readFileSync(dest).equals(payload), 'El contenido reanudado no coincide');
    assert(lastPercent > 50, 'No se reportó progreso');
  });

  await test('Sondeo HEAD + SHA256', async () => {
    const h = await head(`http://127.0.0.1:${port}/big.bin`);
    assert(h.size === payload.length, 'El tamaño de HEAD no coincide');
    const sum = await sha256File(path.join(TMP, 'dl1.bin'));
    assert(/^[0-9a-f]{64}$/.test(sum), 'Formato de sha256 anómalo');
  });

  await test('Si la verificación SHA256 falla se borra el archivo', async () => {
    const dest = path.join(TMP, 'dl3.bin');
    let threw = false;
    try {
      await download(`http://127.0.0.1:${port}/big.bin`, dest, { expectSha256: 'deadbeef'.repeat(8) });
    } catch (_) { threw = true; }
    assert(threw, 'Debería lanzar un error');
    assert(!fs.existsSync(dest), 'Si la verificación falla debería borrar el archivo');
  });

  await test('Descarga en bloques paralelos: el contenido unido de varias conexiones coincide', async () => {
    const dest = path.join(TMP, 'dl4.bin');
    server.rangeHits = 0;
    let maxPercent = 0;
    const r = await downloadParallel(`http://127.0.0.1:${port}/ranged.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
      onProgress: (p) => { maxPercent = Math.max(maxPercent, p.percent); },
    });
    assert(fs.readFileSync(dest).equals(payload), 'El contenido no coincide tras unir los bloques');
    assert(r.parallel > 1, `No se activó el modo paralelo: ${r.parallel}`);
    assert(server.rangeHits >= r.parallel, `Muy pocas peticiones de bloques: ${server.rangeHits}`);
    assert(maxPercent > 0, 'No se reportó progreso');
  });

  await test('Si la fuente no admite Range se vuelve sola a una sola conexión', async () => {
    const dest = path.join(TMP, 'dl5.bin');
    const r = await downloadParallel(`http://127.0.0.1:${port}/norange.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
    });
    assert(fs.readFileSync(dest).equals(payload), 'El contenido no coincide tras volver a una sola conexión');
    assert(!r.parallel, 'No debería usar el modo paralelo');
  });

  server.close();

  console.log('\n[provision.js]');
  const { Provisioner } = require('../src/core/provision');
  const store = require('../src/core/store');

  await test('La carpeta del runtime por defecto está dentro de la carpeta de datos', async () => {
    const p = new Provisioner('C:/fake/app');
    assert(p.paths().root.startsWith(store.DATA_DIR), `Ruta anómala: ${p.paths().root}`);
    assert(p.paths().qemuExe.endsWith('qemu-system-x86_64.exe'), 'Ruta de qemu anómala');
    assert(p.paths().adbExe.endsWith('adb.exe'), 'Ruta de adb anómala');
  });

  await test('Comprobación con entorno vacío: adb no listo, estructura de componentes completa', async () => {
    const p = new Provisioner(path.join(TMP, 'nonexistent'));
    const env = await p.checkEnv();
    assert(env.adb.ok === false, 'adb no debería estar listo');
    // QEMU puede estar instalado a nivel de sistema (p. ej. con winget en Program Files); entonces debe encontrarse
    if (env.qemu.ok) assert(env.qemu.version, 'Si qemu está listo debe incluir el número de versión');
    assert(env.ready === false, 'No debería estar listo');
    assert(typeof env.hypervisor.whpx === 'boolean', 'Falta la información del hipervisor');
  });

  await test('La descompresión ZIP incluida funciona', async () => {
    const { ZipArchive } = require('../src/core/zip');
    // Construye un zip mínimo en modo stored
    const name = Buffer.from('platform-tools/adb.exe');
    const data = Buffer.from('fake-adb-binary');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 14);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt32LE(data.length, 20);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zipPath = path.join(TMP, 'pt.zip');
    fs.writeFileSync(zipPath, Buffer.concat([loc, name, data, cen, name, eocd]));

    const out = path.join(TMP, 'unzip');
    const p = new Provisioner(TMP);
    await p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', 'El contenido descomprimido no coincide');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'Error al leer el zip');
  });

  await test('Las url relativas del índice del SDK se completan como direcciones absolutas', async () => {
    const { absUrl, baseOf, SOURCES } = require('../src/core/provision');
    // repository2-3.xml (emulator) relativo a la raíz del repositorio
    assert(absUrl('emulator-windows_x64-16847572.zip') === `${baseOf(SOURCES.sdkIndex)}emulator-windows_x64-16847572.zip`,
      'La ruta relativa de emulator no se completó');
    // El índice sys-img es relativo a sys-img/android/; no debe unirse por error a la raíz del repositorio
    const sysBase = baseOf(SOURCES.sysImgIndexes[0]);
    assert(sysBase.endsWith('/sys-img/android/'), `Carpeta base de sys-img anómala: ${sysBase}`);
    assert(absUrl('x86_64-30_r11.zip', sysBase) === 'https://dl.google.com/android/repository/sys-img/android/x86_64-30_r11.zip',
      'Error al completar la ruta relativa de sys-img');
    // Las direcciones absolutas se devuelven tal cual
    assert(absUrl('https://example.com/a.zip') === 'https://example.com/a.zip', 'Se reescribió una dirección absoluta');
  });

  await test('Las direcciones de emulator / imagen del sistema obtenidas son URL absolutas descargables', async () => {
    const p = new Provisioner(TMP);
    const emuUrl = await p.resolveEmulatorUrl();
    const imgUrl = await p.resolveSysimgUrl();
    for (const u of [emuUrl, imgUrl]) {
      assert(/^https?:\/\//i.test(u), `No es una URL absoluta: ${u}`);
      assert(/\.zip$/i.test(u), `No es un paquete zip: ${u}`);
    }
    assert(/windows_x64/i.test(emuUrl), `Plataforma incorrecta del paquete emulator: ${emuUrl}`);
  });

  await test('La configuración del AVD usa arquitectura de 64 bits (x86_64 no puede quedar como x86)', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(TMP);
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2 });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg), `hw.cpu.arch debería ser x86_64; real: ${cfg.match(/^hw\.cpu\.arch=.*$/m)}`);
    assert(/^abi\.type=x86_64$/m.test(cfg), 'abi.type debería ser x86_64');
    assert(/^image\.sysdir\.1=\S*system-images\//m.test(cfg), 'Falta image.sysdir.1');
  });

  await test('Traducción de motivos de fallo de instalación: NO_MATCHING_ABIS da una indicación en español', async () => {
    const { friendlyInstallError } = require('../src/core/adb');
    const out = friendlyInstallError(
      'Performing Streamed Install\nadb.exe: failed to install x.apk: '
      + 'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    );
    assert(out.includes('nativas ARM'), `Debería explicar el problema de bibliotecas nativas ARM: ${out}`);
    assert(out.includes('INSTALL_FAILED_NO_MATCHING_ABIS'), 'Debería conservar el código de error original');
    const other = friendlyInstallError('Failure [INSTALL_FAILED_INVALID_APK: x]');
    assert(other.includes('dañado') || other.includes('incompleto'), `Los errores desconocidos también deben ser legibles: ${other}`);
  });

  await test('Verificación de imagen: distingue ISO9660 válida / dañada / sin terminar de descargar', async () => {
    const p = new Provisioner(TMP);
    const mk = (file, size, writeMagic) => {
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, size);
      if (writeMagic) {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 0x8000);
        fs.writeSync(fd, Buffer.from('CD001', 'latin1'), 0, 5, 0x8001);
      }
      fs.closeSync(fd);
      return file;
    };

    const good = mk(path.join(TMP, 'good.iso'), 450 * 1024 * 1024, true);
    const a = p.inspectIso(good);
    assert(a.ok && a.iso9660, `Una ISO válida se consideró inválida: ${a.reason}`);

    const broken = mk(path.join(TMP, 'broken.iso'), 450 * 1024 * 1024, false);
    const b = p.inspectIso(broken);
    assert(!b.ok && /ISO9660/.test(b.reason), `No se detectó la imagen dañada: ${JSON.stringify(b)}`);

    const partial = mk(path.join(TMP, 'partial.iso'), 2 * 1024 * 1024, true);
    const c = p.inspectIso(partial);
    assert(!c.ok && /no terminó/.test(c.reason), `No se detectó la imagen sin terminar: ${JSON.stringify(c)}`);

    for (const f of [good, broken, partial]) fs.rmSync(f, { force: true });
  });

  await test('Análisis de la lista stat remota (mtime real, para evitar reenvíos infinitos)', async () => {
    const { parseStatList } = require('../src/core/adb');
    const rows = parseStatList('1794309868|1234|./a.txt\n1794309900|99|./sub/b.png');
    assert(rows && rows.length === 2, `Cantidad analizada anómala: ${JSON.stringify(rows)}`);
    assert(rows[0].rel === 'a.txt' && rows[0].size === 1234, 'Campo erróneo en la primera línea');
    assert(rows[1].rel === 'sub/b.png', 'Ruta relativa de subcarpeta errónea');
    assert(rows[1].mtime === 1794309900000, 'mtime no se convirtió a milisegundos');
    assert(parseStatList('ls: /nope: No such file') === null, 'Una salida que no es de stat debe devolver null para recurrir al respaldo');
    assert(Array.isArray(parseStatList('')) && parseStatList('').length === 0, 'Una carpeta vacía debe devolver un arreglo vacío');
  });

  console.log('\n[engine.js]');
  const { Runtime } = require('../src/core/engine');

  await test('Parámetros de arranque de QEMU: el modo instalación monta la ISO y arranca desde la unidad óptica', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: true };
    store.saveSettings({
      runtime: { isoPath: 'C:/img/android.iso', diskPath: 'C:/img/disk.qcow2' },
      engine: { memoryMB: 4096, cores: 4 },
    });
    const args = rt.buildArgs({ install: true }).join(' ');
    assert(args.includes('-cdrom C:/img/android.iso'), 'Falta -cdrom');
    assert(/order=d/.test(args), 'Debería arrancar desde la unidad óptica');
    assert(/accel=whpx/.test(args), 'Debería usar WHPX');
    assert(/-cpu host/.test(args), 'WHPX debería usar la CPU host');
    assert(/hostfwd=tcp:127\.0\.0\.1:5555-:5555/.test(args), 'Falta el reenvío de puertos de adb');
    assert(args.includes('-monitor tcp:127.0.0.1:5556'), 'Falta monitor');
    assert(/-m 4096/.test(args), 'Parámetro de memoria erróneo');
  });

  await test('Parámetros de arranque de QEMU: el arranque normal inicia desde el disco', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false }).join(' ');
    assert(!args.includes('-cdrom'), 'No debería montar la ISO');
    assert(/order=c/.test(args), 'Debería arrancar desde el disco duro');
    assert(/accel=tcg/.test(args), 'Sin WHPX debería recurrir a TCG');
    assert(/-cpu max/.test(args), 'TCG debería usar la CPU max');
    assert(args.includes('if=virtio,format=qcow2'), 'Parámetro de disco erróneo');
  });

  await test('El modo headless oculta la ventana de la máquina virtual', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ headless: true }).join(' ');
    assert(args.includes('-display none'), 'No debería haber ventana');
  });

  await test('Protocolo del monitor de QEMU: saludo y envío de comandos', async () => {
    // Simula el monitor de QEMU: al conectar responde "(qemu) " y al recibir un comando responde ok
    const srv = net.createServer((sock) => {
      sock.write('QEMU 8.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
      sock.on('data', (d) => {
        srv.lastCmd = d.toString().trim();
        sock.write('ok\r\n(qemu) ');
      });
    });
    await new Promise((r) => srv.listen(5556, '127.0.0.1', r));

    const rt = new Runtime(TMP);
    await rt.monitorCmd('system_powerdown');
    assert(srv.lastCmd === 'system_powerdown', `Recibido en realidad: ${srv.lastCmd}`);
    await new Promise((r) => srv.close(r));
  });

  await test('Sin sistema instalado ensure devuelve needsSetup', async () => {
    store.saveSettings({ runtime: { installed: false }, engine: { mode: 'builtin' } });
    const rt = new Runtime(TMP);
    // Con un adb falso isOnline falla rápido
    const r = await rt.ensure({ onLog: () => {} });
    assert(r.ok === false, 'No debería estar listo');
    assert(['provision', 'install'].includes(r.needsSetup), `needsSetup=${r.needsSetup}`);
  });

  await test('Si el precalentamiento y el clic coinciden solo se lanza el runtime una vez (idempotente, sin arrancar dos máquinas)', async () => {
    const rt = new Runtime(TMP);
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.emulator.setPriority = async () => 0;
    let calls = 0;
    rt._ensureInner = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, engine: 'emulator' };
    };
    // El precalentamiento (se ejecuta solo a los 4 s de iniciar) y que el usuario abra una app (ensure) ocurren a la vez
    const [a, b] = await Promise.all([rt.prewarm({}), rt.ensure({})]);
    assert(calls === 1, `El arranque de bajo nivel se disparó ${calls} veces; solo debería lanzarse un emulador`);
    assert(a && a.ok && b && b.ok, 'Ambas rutas deberían obtener el resultado listo');
  });

  await test('Decisión de arranque listo: hay que esperar a boot_completed + el gestor de paquetes', async () => {
    const rt = new Runtime(TMP);
    const calls = [];
    const fake = {
      isOnline: async () => true,
      connect: async () => true,
      shell: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('sys.boot_completed')) return '1';
        if (cmd.includes('pm path android')) return 'package:/system/framework/framework-res.apk';
        return '';
      },
    };
    const r = await rt.waitAndroidReady(fake, 5000, () => {});
    assert(r.ok, 'Debería considerarse listo');
    assert(calls.some((c) => c.includes('sys.boot_completed')), 'No se comprobó boot_completed');
    assert(calls.some((c) => c.includes('pm path android')), 'No se comprobó el gestor de paquetes');
  });

  await test('Si el sistema no terminó de arrancar devuelve la fase (kernel)', async () => {
    const rt = new Runtime(TMP);
    const fake = { isOnline: async () => true, connect: async () => true, shell: async () => '0' };
    const r = await rt.waitAndroidReady(fake, 1200, () => {});
    assert(!r.ok && r.stage === 'kernel', `Debería quedarse en la fase kernel: ${JSON.stringify(r)}`);
  });

  console.log('\n[provision.js imagen compatible / versión completa]');

  await test('playImageInfo verifica la integridad de la imagen compatible API 34', async () => {
    const dir = path.join(TMP, 'lanzadorapk', 'runtime', 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    const prov = new Provisioner(path.join(__dirname, '..'));
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(64));
    assert(!prov.playImageInfo().ok, 'Una imagen demasiado pequeña no debe considerarse lista');
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(301 * 1024 * 1024));
    const info = prov.playImageInfo();
    assert(info.ok && info.api === '34' && info.tag === 'google_apis_playstore', `Debería considerar lista la imagen compatible API 34: ${JSON.stringify(info)}`);
  });

  await test('Sin espejos de terceros, Gitee, Xiaomi ni códigos QR de redes sociales', async () => {
    const root = path.join(__dirname, '..');
    assert(fs.existsSync(path.join(root, 'build', 'fetch-runtime.js')), 'falta el script de runtime completo');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(!/qr\.jpg|douyin|gitee/i.test(html), 'la interfaz todavía referencia QR / Douyin / Gitee');
    const { KNOWN_MIRRORS, SOURCES } = require('../src/core/sources');
    assert(KNOWN_MIRRORS.length === 0, 'no debe haber espejos públicos predeterminados');
    assert(!SOURCES.gitee, 'Gitee no debe estar entre las fuentes');
    for (const f of ['adb.js', 'emulator.js']) {
      const src = fs.readFileSync(path.join(root, 'src', 'core', f), 'utf8');
      assert(!/miui/i.test(src), `${f} todavía usa el servidor de Xiaomi`);
    }
  });

  console.log(results.join('\n'));
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
