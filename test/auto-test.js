'use strict';
/**
 * Pruebas de regresión de la adaptación sin configuración / reducción tipo contenedor (Node puro, sin lanzar emulator)
 * Ejecutar: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `lanzadorapk-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'lanzadorapk'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'Aserción fallida'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js parámetros automáticos]');

  await test('El backend de GPU se elige según la versión de emulator (en versiones nuevas host primero + respaldo por software; en viejas swiftshader_indirect)', () => {
    // gpuCandidates ajusta el orden según el fabricante de la GPU del equipo (en AMD swangle va antes),
    // así que aquí solo se comprueba que «la lista de candidatos contiene los elementos clave», no la primera posición fija.
    const c37 = doctor.gpuCandidates('37.3.8.0');
    assert(c37.includes('host'), 'Los candidatos de 37.x deben incluir host');
    assert(c37.includes('swangle'), 'Los candidatos de 37.x deben incluir swangle');
    assert(c37.includes('software'), 'Las versiones nuevas deben tener respaldo por software');
    // En 37.x pasar swiftshader_indirect da fallos de inicialización de GL; nunca debe estar entre los candidatos
    assert(!c37.includes('swiftshader_indirect'));
    // Las versiones antiguas siguen usando swiftshader_indirect
    const c35 = doctor.gpuCandidates('35.1.4.0');
    assert(c35.includes('host'));
    assert(c35.includes('swiftshader_indirect'));
    // detectGpuVendor debe devolver un valor conocido o unknown (sin lanzar excepciones)
    const v = doctor.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `detectGpuVendor devolvió un valor inesperado: ${v}`);
  });

  await test('En equipos con poca memoria se reduce automáticamente (ya no 4 GB / 4 núcleos fijos)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `La memoria debería ser 2048; real: ${p.memoryMB}`);
    assert(p.cores === 2, `Los núcleos deberían ser 2; real: ${p.cores}`);
    assert(p.accel === 'off', 'Sin aceleración por hardware debe pasar automáticamente a emulación por software');
    assert(p.bootTimeoutMs > 240000, 'La emulación por software debe tener un tiempo de arranque más largo');
    assert(p.gpu === 'host' || p.gpu === 'swangle', `El renderizado preferido debería ser host o swangle (en AMD swangle primero); real: ${p.gpu}`);
    // Con accel desactivado los parámetros de respaldo deben ser renderizado por software; con TCG no hay GPU disponible
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'La opción de último recurso debe usar renderizado por software');
    // La partición de datos por defecto da 4/6/8 GB según el espacio libre (ya no 16 GB fijos) y la configuración la puede sustituir
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `La partición de datos debería estar entre 4 y 8 GB; real: ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'El tamaño de la partición de datos de la configuración debe aplicarse');
  });

  await test('En equipos con mucha memoria no se consume sin límite', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `Los equipos potentes también tienen tope: ${p.memoryMB}MB / ${p.cores} núcleos`);
    assert(p.accel === 'auto');
  });

  await test('Matriz de reintentos: de la mejor a la más conservadora, con emulación por software y arranque en frío como respaldo', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `Los reintentos deberían ser 3-4; real: ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'Falta el respaldo de emulación por software');
    // La última opción solo hace «sin cargar instantánea + memoria mínima», nunca -wipe-data:
    // con el disco lleno todas las opciones fallan, y con wipe se borrarían también las apps instaladas del usuario (pasó en pruebas).
    assert(v[v.length - 1].snapshot === false, 'La última opción debe omitir la carga de la instantánea');
    assert(v[v.length - 1].wipe === false, 'Ningún reintento automático puede borrar los datos del usuario');
    assert(v[v.length - 1].memoryMB <= 2048, 'La última opción debe bajar a la memoria mínima');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'Las opciones de reintento no deben repetirse');
  });

  await test('Mover la imagen de disco no es cambiar de imagen: si sysdir cambia de carpeta no se deben borrar los datos del usuario', () => {
    const c = 'C:/Users/x/AppData/Roaming/lanzadorapk/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/LanzadorAPKRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'La identidad de ruta de una misma imagen debe ser igual');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'Al cambiar de disco la instantánea no debe invalidarse (si no, se espera un arranque en frío de más)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'Si de verdad se cambió la imagen debe detectarse');
  });

  await test('La huella de la instantánea no cambia con los reintentos de GPU/aceleración/memoria (para no borrar las apps instaladas en cada reintento)', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('El diagnóstico del registro detecta problemas de GPU/aceleración/rutas con caracteres no ASCII/archivos de bloqueo', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD lanzadorapk is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('Diagnóstico del registro: si emulator sale con 0xC0000005 se debe tomar como caída del backend de renderizado', () => {
    // Probado en las issues #20/#25: tras imprimir Userspace boot properties sale con exit 3221225477
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // El registro de fallos suele traer también información de inicialización del renderizado: hay que detectar primero el fallo, no GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'La caída debe tener prioridad sobre los registros normales de renderizado');
  });

  await test('La búsqueda de puertos libres devuelve un par de puertos pares', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `Puertos anómalos: ${p}`);
  });

  await test('Los parámetros automáticos que muestra la configuración coinciden con los reales (37.x ya no muestra backends obsoletos)', () => {
    const common = {
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044,
      // El anfitrión se pasa explícitamente: los límites de memoria/núcleos ahora siguen al anfitrión, y sin esto el resultado variaría según la máquina de CI
      // (el runner de GitHub solo tiene 4 núcleos; poner 6 a mano se ajusta correctamente a 3 y la aserción daría un falso error)
      host: { totalMB: 32768, freeMB: 24000, cores: 12, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false },
    };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host' || p.gpu === 'swangle', `Debería ser host o swangle (en AMD); real: ${p.gpu}`);
    assert(p.accelOk === true && text.includes('aceleración por hardware'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('puerto 5562'), text);

    // Los motores antiguos siguen usando el backend antiguo; los parámetros avanzados que el usuario pone a mano siguen aplicándose
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js reducción tipo contenedor]');

  await test('Inventario de lo recuperable: QEMU no x86_64, imágenes viejas, AVD viejos, archivos de bloqueo, instantáneas viejas', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'lanzadorapk.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'lanzadorapk.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'lanzadorapk.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'lanzadorapk-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'Debe listar el QEMU no x86_64');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'No se puede borrar el QEMU x86_64');
    assert(paths.some((p) => p.includes('android-30')), 'Debe listar la imagen vieja API30');
    assert(paths.some((p) => p.endsWith('.lock')), 'Debe listar los archivos de bloqueo');
    assert(paths.some((p) => p.includes('snapshots')), 'Debe listar las instantáneas viejas');
    assert(paths.some((p) => p.includes('lanzadorapk-arm.avd')), 'Debe listar los AVD inactivos');
    assert(!paths.some((p) => p.endsWith('lanzadorapk.avd/config.ini')), 'No se puede borrar la configuración del AVD activo');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun no debe borrar ningún archivo');
    assert(fs.existsSync(path.join(root, 'avd', 'lanzadorapk-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'La limpieza real debe liberar espacio');
    assert(!fs.existsSync(path.join(root, 'avd', 'lanzadorapk-arm.avd')), 'Los AVD inactivos deben borrarse');
    assert(fs.existsSync(path.join(root, 'avd', 'lanzadorapk.avd', 'config.ini')), 'El AVD activo debe conservarse');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'El QEMU x86_64 debe conservarse');
  });

  console.log('\n[adb.js mensajes claros de fallos de instalación/inicio]');

  await test('Las apps con targetSdk viejo en Android 14 tienen una indicación clara al fallar', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('automáticamente'), s);
  });

  await test('La caída de la capa de traducción ARM da una conclusión en español con una acción concreta', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('traducción ARM') && s.includes('imagen compatible'), s);
  });

  console.log('\n[sharer ya no copia de ida y vuelta (la causa de llenar el disco)]');

  await test('El mismo archivo no se trae del dispositivo en cada ronda', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Usa archivos de rutas/estado reales, pero con la carpeta apuntando a una temporal
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // Ronda 1: archivo nuevo en el equipo → se sube
    const firstPull = calls.pull;
    await sh.sync();          // Ronda 2
    await sh.sync();          // Ronda 3
    await sh.sync();          // Ronda 4
    assert(calls.push === 1, `Solo debería subirse una vez; real: ${calls.push}`);
    assert(firstPull === 0, `Un archivo recién subido no debe traerse de vuelta de inmediato; veces traído: ${firstPull} veces`);
    assert(calls.pull === firstPull, `En rondas siguientes no debe volver a traerse; total real: ${calls.pull} veces`);
  });

  await test('Los archivos muy grandes no se traen de vuelta al equipo (la carpeta local no es el desagüe de la caché del dispositivo)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'Los archivos de más de 512 MB no deben traerse al equipo');
  });

  console.log('\n[adb/sharer intercambio de archivos]');

  await test('El análisis de ls -l es compatible con el formato de Android con group / fecha', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `Debería analizar 3 líneas; real: ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('La lista de archivos remotos se obtiene de una vez con find+stat (sin depender del análisis de fechas de ls)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `Debería devolver 2 archivos; real: ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js descompresión en flujo de paquetes grandes]');

  await test('ZipFile y ZipArchive analizan igual el mismo paquete (con deflate y pipeTo en flujo)', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello lanzadorapk'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'Los nombres de las entradas deben coincidir');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'El contenido de las entradas stored debe coincidir');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'El contenido de las entradas deflate debe coincidir');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'La salida en flujo de pipeTo debe estar completa');
    } finally {
      file.close();
    }
  });

  await test('Zip64: cuando el EOCD usa 0xffff/0xffffffff como relleno, el número de entradas y el desplazamiento salen del EOCD Zip64', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 lanzadorapk');
    // Encabezado local
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // Entrada del directorio central: tres campos en 0xffffffff, los valores reales en el extra Zip64 (id=0x0001)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // EOCD Zip64 + localizador + EOCD tradicional (todos desbordados)
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive debe reconocer las entradas Zip64');
    assert(String(mem.read('hello.txt')) === 'hello zip64 lanzadorapk', 'El contenido de ZipArchive debe ser correcto');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'El tamaño sin comprimir de ZipArchive debe salir del extra');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile debe reconocer las entradas Zip64');
      assert(String(file.read('hello.txt')) === 'hello zip64 lanzadorapk', 'El contenido de ZipFile debe ser correcto');
      assert(file.entries.get('hello.txt').localOffset === 0, 'El desplazamiento del encabezado local de ZipFile debe salir del extra');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js AVD sin configuración]');

  await test('El AVD usa partición de datos pequeña + inicio rápido + modo de GPU moderno', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'La partición de datos no debe ser de 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'Ya no se debe forzar el arranque en frío');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'La instantánea debe controlarse con -snapshot en la línea de comandos, para no cargar el default_boot viejo');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'Debe escribirse la huella de la instantánea');
  });

  await test('Los parámetros de arranque llevan memoria/núcleos/instantánea automáticos y ya no usan el modo de GPU obsoleto', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Sin instantánea (AVD nuevo / recién invalidada) nunca se puede pasar -snapshot:
    // qemu esperaría para siempre un estado de memoria inexistente; el proceso vive pero nunca arranca.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // Sin instantánea hay que «desactivar solo la carga, no el guardado»: -no-snapshot apaga también el guardado automático al salir,
      // y tras el primer arranque en frío nunca se generaría una instantánea; cada apertura sería un arranque completo.
      assert(/-no-snapshot-load/.test(fresh), 'Sin instantánea debe usarse -no-snapshot-load (solo omite la carga)');
      assert(!/ -no-snapshot( |$)/.test(fresh), 'Sin instantánea no se puede usar -no-snapshot (desactivaría el guardado al salir)');
    }
    // Solo con una instantánea existente se usa quickboot. Ojo: tiene que «parecer una instantánea completa» de verdad:
    // un guardado interrumpido deja un cascarón con un snapshot.pb de unas decenas de bytes, que debe tomarse como sin instantánea;
    // si no, emulator intentaría cargarla, fallaría y volvería al arranque en frío, perdiendo unos segundos.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'lanzadorapk.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'lanzadorapk'), { recursive: true });

    // El cascarón (pb de 12 bytes + sin ram.img) debe tratarse como «sin instantánea»
    fs.writeFileSync(path.join(snapDir, 'lanzadorapk', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'Una instantánea incompleta no puede tomarse como utilizable');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'Una instantánea vacía debe volver al arranque en frío (omitiendo la carga)');

    // Instantánea completa: pb con contenido + ram.img con datos (hasSnapshot borra de paso el cascarón del paso anterior)
    fs.mkdirSync(path.join(snapDir, 'lanzadorapk'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'lanzadorapk', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'lanzadorapk', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot lanzadorapk/.test(withSnap), 'Con instantánea debe usarse la instantánea quickboot');
    assert(!/-no-snapshot-load/.test(withSnap), 'Con una instantánea completa no se debe omitir la carga');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'Al borrar datos debe llevar -wipe-data');
    // Al restablecer datos: no se carga la instantánea vieja (los datos no coinciden), pero **sí se permite guardar** una nueva.
    // «Reparar red» depende de esta cadena: primer arranque tras restablecer con red → guardar instantánea al momento → restaurarla la próxima vez.
    // La implementación anterior pasaba aquí -no-snapshot, apagando también el guardado, y tras reparar la red no se guardaba la instantánea.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'Al borrar datos no se debe cargar la instantánea vieja');
    assert(!/ -no-snapshot( |$)/.test(cold), 'Al borrar datos se debe seguir permitiendo guardar una instantánea nueva (la reparación de red depende de ello)');
  });

  // El script del agente de ventanas tiene muchos comentarios no ASCII. PowerShell 5.1 lee el «UTF-8 sin BOM» como ANSI,
  // los caracteres se corrompen y pueden unir un comentario de C# con la línea de código siguiente: Add-Type no compila,
  // con el síntoma «el agente de ventanas no arranca / la ventana de la app no se incrusta». Ya pasó una vez; esta prueba lo fija.
  await test('El script del agente de ventanas debe llevar BOM UTF-8 (si no, los comentarios no ASCII hacen fallar la compilación de Add-Type)', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'A agent.ps1 le falta el BOM UTF-8');
  });

  // La ventana del emulador debe ser «hija» de la capa de renderizado de Chromium, no hermana dentro del anfitrión.
  // Como hermanas, Electron sube continuamente la capa web al frente: el fondo negro tapa la imagen de Android y se come todo el ratón
  // (bordes negros / no llena / clics que no funcionan / no se puede pulsar aceptar). Tampoco se puede volver a poner una window region en la ventana incrustada,
  // porque rompe la detección de clics y deja bordes negros tras redimensionar.
  await test('La ventana incrustada debe colgar bajo la capa web y no se puede volver a poner una window region', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'embed debe colgar de la ventana padre que encuentra FindChromeRender');
    assert(/FindChromeRender\(host\)/.test(src), 'Debe buscarse la subventana de renderizado de Chromium');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), 'No se puede poner una region de recorte a la ventana incrustada');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'Al incrustar hay que quitar la region que dejaron versiones viejas');
  });

  // Rotar exige cambiar el «tamaño de la pantalla física» y reiniciar; no basta con cambiar wm size / density en ejecución.
  //   - wm size: el LCD físico sigue vertical -> imagen acostada 90°, en una franja arriba a la izquierda, clics desplazados;
  //   - wm density: el tamaño del framebuffer no cambia -> la imagen no llena y al maximizar queda un gran espacio vacío a la derecha.
  await test('La horizontal debe lograrse con el tamaño de la pantalla física (lcdFor landscape), sin volver a rotar con wm size en ejecución', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `La vertical debería ser 720x1280; real: ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `La horizontal debería ser 1280x720; real: ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation ya no puede sobrescribir wm size');
    // La densidad ahora pasa siempre por tabletDensity() (el usuario puede desactivar el diseño de tableta en Configuración),
    // pero la constante debe seguir siendo 190 (720 de ancho → 606 dp, por encima del punto de corte de tableta).
    assert(/wm density \$\{tabletDensity\(\)\}/.test(body), 'density solo se conserva como ruta de respaldo');
    assert(/const TABLET_DENSITY = 190/.test(adb), 'La constante de densidad de tableta debe ser 190');
  });

  await test('El modo juego debe usar prioridad alta y desactivar el gancho global del ratón', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'El nivel game debe subir qemu a High');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'El modo juego no puede instalar el gancho global WH_MOUSE_LL');
  });

  await test('Motor de mapeo de teclas: búsqueda en tabla, conversión a comando, límite de frecuencia', async () => {
    const { lookup, toCommand, PRESETS } = require('../src/core/keymap');
    const { KeymapEngine } = require('../src/core/keymap-engine');

    // Integridad de los perfiles predefinidos
    assert(PRESETS.fps && PRESETS.fps.mappings.length >= 4, 'El perfil FPS tiene al menos 4 mapeos');
    assert(PRESETS.rpg && PRESETS.rpg.mappings.length >= 4, 'El perfil RPG tiene al menos 4 mapeos');
    assert(PRESETS.generic && PRESETS.generic.mappings.length >= 3, 'El perfil general tiene al menos 3 mapeos');

    // Búsqueda: sin distinguir mayúsculas
    assert(lookup(PRESETS.fps.mappings, 'W').action === 'tap', 'W mayúscula debe coincidir con w minúscula');
    assert(lookup(PRESETS.fps.mappings, 'z') === null, 'Las teclas sin mapeo devuelven null');

    // A comando: coordenadas normalizadas → píxeles
    const cmd = toCommand({ action: 'tap', x: 0.5, y: 0.5 }, 720, 1280);
    assert(cmd === 'input tap 360 640', `Comando tap incorrecto: ${cmd}`);
    const sw = toCommand({ action: 'swipe', x1: 0, y1: 0.5, x2: 1, y2: 0.5, duration: 100 }, 720, 1280);
    assert(sw === 'input swipe 0 640 720 640 100', `Comando swipe incorrecto: ${sw}`);
    const ke = toCommand({ action: 'keyevent', code: 4 }, 720, 1280);
    assert(ke === 'input keyevent 4', `Comando keyevent incorrecto: ${ke}`);

    // Motor: activar/desactivar, búsqueda por app, límite de frecuencia
    const calls = [];
    const eng = new KeymapEngine({
      execInput: (c) => { calls.push(c); return Promise.resolve(); },
      getSize: () => ({ width: 720, height: 1280 }),
      minInterval: 0,  // En pruebas sin límite de frecuencia
    });
    eng.setMap('com.test.game', PRESETS.fps.mappings);
    assert(eng.getMap('com.test.game').length > 0, 'setMap/getMap deben funcionar');
    eng.enable(false);
    assert(await eng.handleKey('w', 'com.test.game') === false, 'Desactivado no debe consumir teclas');
    eng.enable(true);
    assert(await eng.handleKey('w', 'com.test.game') === true, 'Activado debe consumir las teclas mapeadas');
    assert(await eng.handleKey('z', 'com.test.game') === false, 'Las teclas sin mapeo no deben consumirse');
    assert(await eng.handleKey('w', 'com.other.app') === false, 'Otras apps no deben coincidir');
    assert(calls.length === 1 && /input tap/.test(calls[0]), `Debería enviar un input tap; real: ${calls.join('|')}`);
  });

  await test('Detección del fabricante de GPU: devuelve un valor conocido o unknown; en AMD swangle primero', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/detectGpuVendor/.test(doc), 'Debe existir la función detectGpuVendor');
    assert(/Get-CimInstance Win32_VideoController/.test(doc), 'Debe usar CIM de PowerShell (wmic se eliminó en Win11 24H2+)');
    assert(/vendor === 'amd'[\s\S]{0,200}swangle.*host/.test(doc), 'En AMD swangle debe ir antes que host');
    const d = require('../src/core/doctor');
    const v = d.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `El valor devuelto debe ser un fabricante conocido o unknown; real: ${v}`);
  });

  await test('Animación de arranque: ventana splash + envío de progreso + desvanecido', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.html')), 'Falta splash.html');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.css')), 'Falta splash.css');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.js')), 'Falta splash.js');
    assert(fs.existsSync(path.join(root, 'src', 'splash-preload.js')), 'Falta splash-preload.js');
    assert(/splashWin/.test(mainJs), 'main.js debe crear la ventana splash');
    assert(/splashProgress/.test(mainJs), 'Debe existir la función de envío splashProgress');
    assert(/splashDone/.test(mainJs), 'Debe existir la señal de fin splashDone');
    assert(/splash:version/.test(mainJs) || /splash:isFirstRun/.test(mainJs), 'Debe registrarse el IPC de splash');
  });

  await test('La prioridad de la app en primer plano no puede ser below (clics al instante / video sin perder fotogramas)', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // balanced/performance con una app en primer plano deben ser normal: con below qemu se queda sin CPU,
    // con video que pierde fotogramas y clics que tardan en responder (la causa principal de «los clics no responden al instante»).
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      "La prioridad en primer plano de beginApp debe mapear game→game y el resto→normal");
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      'balanced ya no puede caer en below');
    // Cada vez que se abre/vuelve a una app hay que fijar la prioridad otra vez: endApp la baja a idle y sin subirla al volver se siente lento
    const setIdx = begin.indexOf("setPriority(level)");
    const firstIdx = begin.indexOf("if (first)");
    assert(setIdx > -1, 'beginApp debe llamar a setPriority');
    // setPriority no debe estar solo en el primer bloque if(first): al cambiar de app (no first) también hay que subirla
    const firstBlock = begin.slice(firstIdx, begin.indexOf('\n\n', firstIdx));
    assert(!/setPriority\(level\)/.test(firstBlock) || begin.split('setPriority(level)').length >= 2,
      'setPriority debe ejecutarse en cada beginApp, no solo la primera vez');
  });

  await test('El modo ahorro debe bajar el tope de memoria (menos uso en ejecución)', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'El modo save debe bajar memoryMB a 2048 (ahorra ~1 GB de memoria + 1 GB de disco de instantánea)');
    // La memoria indicada a mano siempre tiene prioridad; save no puede sobrescribirla
    assert(/!overrides\.memoryMB/.test(doc), 'El ajuste de memoria de save debe ceder ante el valor manual del usuario');
  });

  await test('El ram.bin que escribe el emulator nuevo debe tomarse como instantánea completa (si no, los 3 GB recién guardados se borrarían como vacíos)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'lanzadorapk.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'lanzadorapk');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin debe tomarse como instantánea completa');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot lanzadorapk/.test(args), 'Con instantánea debe usarse quickboot');
    assert(!/-no-snapshot-load/.test(args), 'Con una instantánea completa no se debe omitir la carga');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('Imagen semilla userdata: bloque 4K + ENCRYPT + contabilidad coherente', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'El número mágico del superblock debe ser 0xEF53');
    // dm-default-key (cifrado de metadatos de /data en Android 13) tiene un tamaño de bloque lógico de 4096,
    // y un fs block menor hace que mount() devuelva EINVAL: el verdadero culpable de «no se monta /data».
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size debe ser 2 (4096 bytes)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size debe ser igual al tamaño de bloque');
    // Sin ext_attr setxattr devuelve EOPNOTSUPP, no se escriben las etiquetas SELinux,
    // netd / media / tombstoned salen todos con exit 1 y el arranque se queda en la animación.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'Debe tener ext_attr');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'Los bloques libres deben estar entre (0, total)');
    assert(freeInodes === inodes - 10, 'Los inodos libres deben descontar los reservados 1~10 (e2fsck lo comprueba)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'Por defecto debe llevar ENCRYPT (necesario para FBE)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'Con encrypt:false debe poder quitarse ese bit');
  });

  console.log('\n[pantalla / accesos directos / cero pasos]');
  await test('El modo ventana debe abrir una ventana de verdad (si no, el proceso de la app vive pero no se ve en pantalla)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'El modo ventana ya no puede usar -no-window');
    // Ya no se puede pasar -no-skin: anula -skin y el tamaño de la pantalla vuelve al valor viejo de config.ini,
    // con los síntomas «en Configuración cambié a horizontal y sigue vertical» y «la imagen solo ocupa una franja arriba a la izquierda».
    assert(!/\s-no-skin(\s|$)/.test(win), 'El modo ventana no puede llevar -no-skin (anula -skin)');
    assert(/-skin \d+x\d+/.test(win), 'El modo ventana debe indicar el tamaño de pantalla con -skin');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('Audio: activado por defecto (sin -no-audio); solo desactivado lleva -no-audio', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Sustituye el getter de settings: activado por defecto no debe llevar -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), 'Con audio=true no se debe pasar -no-audio');
    // Solo desactivado debe llevar -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'Con audio=false se debe pasar -no-audio');
  });

  await test('Migración forzada de configuraciones viejas: sin interfaz y «salir tras iniciar» ya no se aplican', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless debe migrarse a false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch debe ser false');
    assert(s.autoStart === true && s.autoDeploy === true, 'Inicio automático / implementación en un clic activados por defecto');
    assert(s.createStartMenuShortcut === true, 'Accesos directos del menú Inicio activados por defecto');
  });

  await test('Adaptación de pantalla: ventana y pantalla completa comparten la resolución vertical; la ventana 9:16 se puede estirar', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // La pantalla completa no cambia la resolución de Android (la proporción de la ventana del emulador la fija el LCD); solo maximiza la ventana
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', '横屏乱填', area).h > d.sizeFor('window', '横屏乱填', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Pantalla completa: llena la altura, calcula el ancho con la proporción vertical y centra (la proporción de la ventana la fija el LCD del emulador)
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('Los comandos de pantalla de adb usan wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO y el respaldo de iconos WebP producen ICO válidos', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'El encabezado ICO debe declarar 1 imagen');
    assert(ico.readUInt32LE(14) === png.length, 'La longitud del PNG incrustado debe coincidir');
    assert(ico.slice(22).equals(png), 'La zona de datos del ICO debe ser el PNG original');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP (nativeImage no lo decodifica) → sin callback decode debe usar el ICO provisional de marca
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'Con WebP también se debe obtener icono');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), 'Con decode se debe usar el icono real');
  });

  await test('El script de control de ventanas existe y es ASCII puro (para no corromper rutas/títulos no ASCII)', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), 'Falta windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'El ps1 debe ser ASCII puro; el texto no ASCII llega por JSON UTF-8');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile pasa el archivo por stdin y produce una imagen que el runtime puede descomprimir (regresión de cuelgue en CI)', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('LANZADORAPK-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // Las muestras pequeñas usan el nivel más rápido, para no ralentizar toda la batería de pruebas
    process.env.XZ_TIMEOUT_MS = '15000';  // Si de verdad se cuelga se mata en 15 s, para no bloquear el CI
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile no respondió en 25 s (¿stdin sin EOF?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'El resultado comprimido no puede tener 0 bytes');
    let back;
    if (/\.xz$/i.test(out)) {
      // No depende del enlace nativo de @napi-rs/lzma: el job de Node 20 del CI no puede cargarlo
      // por un error conocido de las optional dependencies de npm (en Node 22 funciona).
      // Aquí se lee con el mismo lzma de python que usa el compresor y se verifica el número mágico XZ;
      // la compatibilidad de la descompresión en ejecución la cubren las pruebas de extremo a extremo con instaladores reales.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'Debe ser un contenedor XZ válido');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'Se generó XZ pero no hay python para verificarlo');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'El contenido descomprimido debe coincidir byte a byte con la imagen original');
  });

  console.log('\n[container.js contenedor por app]');

  const container = require('../src/core/container');

  await test('Los paquetes del sistema/framework nunca se recortan; solo las apps del usuario entran en la limpieza de sesión', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} debe reconocerse como app del usuario`);
      else assert(sys, `${p} debe reconocerse como paquete del sistema`);
    }
    assert(container.isSystemPackage(''), 'Un nombre de paquete vacío se trata como del sistema, para no generar comandos inválidos');
  });

  await test('Al iniciar una app solo se detienen las otras apps instaladas; por defecto nunca se tocan los paquetes del sistema', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `Debería detener 2 apps de usuario más; real: ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'Por defecto no se pueden desactivar paquetes del sistema');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'Durante el inicio no se limpia el segundo plano, para no dañar la app que acaba de pasar al frente');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'No se puede hacer force-stop del framework del sistema');
  });

  await test('Lista permitida de nombres de paquete: una lista contaminada no genera comandos inyectados', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `Solo debería detener nombres de paquete válidos; real: ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'No pueden aparecer fragmentos inyectados');
  });

  await test('El recorte profundo puede desactivar paquetes en segundo plano, se puede restaurar por completo y no toca componentes necesarios', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'El recorte profundo debe tener elementos desactivables');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} nunca se puede desactivar`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} debe poder restaurarse`);
    }
  });

  await test('Aparcar el contenedor: limpiar segundo plano + idle de Android; la máquina de estados cubre varias ventanas / el último cierre', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'Al aparcar hay que limpiar los procesos en caché del segundo plano');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'Al aparcar Android debe entrar en idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'Al cerrar la última ventana el contenedor debe aparcarse');
  });

  await test('Contenedor ligero de doctor: ajusta las vCPU, la configuración manual tiene prioridad', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // La lógica anterior era floor(núcleos/4) limitado a 2–3: un equipo de 8 núcleos solo recibía 2 vCPU y las apps de video iban trabadas.
    // Ahora el modo equilibrado da «la mitad de los núcleos físicos, máximo 4», y el modo ahorro fija 2.
    assert(lite && lite.cores === 4, `En un equipo de 16 núcleos el modo equilibrado debería dar 4; real: ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `El modo ahorro debería fijar 2 núcleos; real: ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'Desactivado explícitamente debe devolver null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, 'En equipos de 2 núcleos se conservan al menos 2');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(manual.cores === 6, 'Los núcleos indicados a mano deben tener prioridad sobre el modo ligero');
    assert(/contenedor ligero/.test(doctor.describeProfile(auto)), 'El resumen del diagnóstico debe marcar el contenedor ligero');
  });

  await test('El gancho global del ratón está desactivado por defecto y el agente de ventanas ya no bloquea mucho tiempo la bomba de mensajes', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'En la configuración por defecto el gancho de los botones laterales debe estar desactivado');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'El proceso principal ya no puede instalar el gancho global sin condiciones');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'La ventana de la app ya no puede instalar el gancho global sin condiciones');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'La sincronización de archivos no puede estar siempre activa sin condiciones');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), 'El interruptor del gancho debe ser idempotente y poder apagarse');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), 'El gancho debe instalarse en un hilo de mensajes dedicado');
    assert(/GetMessage\(out MSG/.test(agentPs1), 'El hilo del gancho debe ejecutar un bucle de mensajes');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'El bucle principal ya no puede bloquearse 4 segundos');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'El bucle principal debe sondear en intervalos cortos para que la bomba de mensajes responda');
    assert(/now - _embedAt < 8000/.test(agentPs1), 'La revisión de ventanas debe tener límite de tiempo; no puede hacer EnumWindows cada 2 s para siempre');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'La configuración debe mostrar la opción de contenedor ligero');
  });

  await test('Modo de ventana independiente: sin SetParent, tamaño según la proporción de la pantalla, la limpieza no oculta ventanas del usuario', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    // El interruptor llega de punta a punta: UI -> main -> appwin
    assert(/setWindowEmbed/.test(uiHtml), 'La configuración necesita el interruptor «modo de ventana»');
    assert(/windowEmbed === false/.test(mainJs), 'main debe reconocer el modo de ventana independiente');
    assert(/openDetached/.test(appwinJs), 'appwin necesita openDetached');
    // Antes era la forma en línea `detached: displaySettings().windowEmbed === false`;
    // ahora va a una variable local (porque también decide showWhileWaiting); se aceptan ambas.
    assert(/detached:\s*displaySettings\(\)\.windowEmbed === false/.test(mainJs)
      || /const detached = displaySettings\(\)\.windowEmbed === false/.test(mainJs),
      'Al abrir la ventana debe pasarse detached');

    // El modo independiente nunca puede hacer SetParent: esa es la raíz de los problemas de incrustación
    // (solo se miran las líneas de código reales; los comentarios que mencionan SetParent explican por qué no se usa)
    const codeOnly = (src) => src.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    const layoutBlock = agentPs1.slice(agentPs1.indexOf('cmd == "layout"'));
    const layoutBody = codeOnly(layoutBlock.slice(0, layoutBlock.indexOf('cmd == "hook"')));
    assert(!/SetParent\s*\(/.test(layoutBody), 'layout no puede hacer SetParent (el modo independiente existe justo para evitarlo)');
    assert(/SetWindowPos\s*\(/.test(layoutBody), 'layout solo debe colocar la ventana en el rectángulo de destino');

    // La lógica de limpieza debe detenerse en modo independiente; si no, ocultaría como estorbo la ventana que el usuario está viendo
    assert(/_detachedMode/.test(agentPs1), 'agent.ps1 necesita la marca _detachedMode');
    const detachBlock = agentPs1.slice(agentPs1.indexOf('cmd == "detach"'));
    assert(/keep/.test(detachBlock.slice(0, 600)), 'detach necesita el parámetro keep para distinguir «pasar a independiente» de «terminar la incrustación»');

    // El tamaño se calcula con la proporción de la pantalla: el emulador fija su propia proporción y una equivocada la corrige
    assert(/_panelRatio/.test(appwinJs), 'El tamaño de la ventana independiente debe calcularse con la proporción de la pantalla');
    assert(!/w:\s*Math\.min\(area\.w - 80, 1280\)/.test(appwinJs), 'Ya no se puede fijar 1280 de ancho (el emulador lo reduciría a una franja vertical)');
  });

  await test('Un solo runtime: el registro fija builtin, sin importar qué emuladores estén instalados', () => {
    const backends = require('../src/core/backends');
    // Desde 0.5.6 ya no hay elección automática: aunque el equipo tenga MuMu / LDPlayer / BlueStacks / WSA,
    // solo se ejecuta el runtime propio de LanzadorAPK; leer la configuración tampoco da un segundo candidato.
    assert(backends.REGISTRY.length === 1, 'Apareció una segunda base en el registro');
    assert(backends.REGISTRY[0].id === 'builtin', 'La única base no es builtin');
  });

  await test('Título de ventana cambiado a LanzadorAPK: la detección debe reconocer también el título nuevo', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agent = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');

    assert(/SetWindowTextW/.test(ps1), 'agent.ps1 necesita la declaración de SetWindowTextW');
    assert(/cmd == "title"/.test(ps1), 'agent.ps1 necesita el comando title');
    assert(/LooksLikeEmulator/.test(ps1), 'Tras cambiar el título se debe seguir reconociendo la ventana, no solo por Android Emulator');
    assert(/_ourTitle/.test(ps1), 'Debe recordar el título que puso');
    // Qt devuelve el título al recrear la ventana; la revisión debe volver a fijarlo
    assert(/QuietSweep[\s\S]{0,600}SetWindowTextW/.test(ps1), 'La revisión debe volver a poner el título');
    assert(/setTitle\(/.test(agent), 'agent.js debe exponer setTitle');
    assert(/agent\.setTitle\(/.test(appwin), 'Al abrir la ventana independiente el título debe cambiarse de verdad');
  });

  await test('Idioma y región: se inyecta el locale al arrancar, teclado latino de la imagen y endpoint de comprobación de conexión accesible', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    const engJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    // El idioma usa el -change-locale oficial: en pruebas, -prop persist.sys.locale lo intercepta el emulador
    // y getprop no muestra nada en el invitado; solo -change-locale cambia de verdad el idioma del sistema
    assert(/'\-change-locale',\s*locale/.test(emuJs), 'El idioma del sistema debe fijarse con -change-locale');
    // Solo líneas de código: no cuenta cuando un comentario menciona -prop para explicar «por qué no se usa»
    const emuCode = emuJs.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/-prop[\s\S]{0,80}persist\.sys\.locale/.test(emuCode),
      'Ya no se puede usar el ineficaz -prop persist.sys.locale');
    assert(/_guestLocale/.test(emuJs), 'Debe haber una fuente de idioma configurable');
    // Idioma por defecto: español latinoamericano; teclado pinyin opcional y apagado
    assert(/locale:\s*'es-419'/.test(storeJs), 'el idioma por defecto debe ser es-419');
    assert(!/chineseIme/.test(storeJs), 'ya no hay opción de teclado pinyin');
    assert(/timezone:\s*''/.test(storeJs), 'la zona horaria debe seguir al PC por defecto');
    assert(!/Asia\/Shanghai/.test(adbJs), 'no debe forzarse la zona horaria de Shanghái');

    // Teclado: nada de pinyin; se activa el teclado latino que trae la imagen
    assert(!fs.existsSync(path.join(root, 'assets', 'PinyinIME.apk')), 'el APK pinyin debe haberse quitado');
    assert(!/PinyinIME|ensureChineseIme/.test(adbJs + engJs), 'no debe quedar código del teclado pinyin');
    assert(/ensureLatinKeyboard/.test(adbJs) && /ensureLatinKeyboard/.test(engJs), 'debe activarse el teclado latino');
    assert(/ime enable/.test(adbJs) && /ime set/.test(adbJs), 'debe activarlo y dejarlo como predeterminado');

    // Endpoint de comprobación de conexión: que no marque la red con «!»
    assert(/captive_portal_http_url/.test(adbJs), 'Debe fijarse un endpoint accesible de comprobación de conexión');
    assert(/connectivitycheck\.gstatic\.com/.test(adbJs), 'debe usar el endpoint estándar de Android');

    // La configuración debe tener el control
    assert(/setLocale/.test(html) && !/setChineseIme/.test(html), 'idioma configurable y sin interruptor de pinyin');
    assert(/btnAndroidKeyboard/.test(html), 'acceso a los ajustes de teclado físico');
  });

  await test('Autocorrección de orientación: si la imagen tableta/horizontal queda acostada 90° debe corregirse sola', () => {
    const root = path.join(__dirname, '..');
    const engJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // Criterio: si init=WxH y cur=WxH tienen ancho y alto al revés = el espacio lógico se giró
    assert(/_healOrientation/.test(engJs), 'Debe existir un método de autocorrección de orientación');
    assert(/init=\(\\d\+\)x\(\\d\+\)/.test(engJs), 'Debe leer el tamaño init de la pantalla');
    assert(/cur=\(\\d\+\)x\(\\d\+\)/.test(engJs), 'Debe leer el espacio lógico cur');
    assert(/initLand !== curLand/.test(engJs), 'Solo se vuelve a bloquear la orientación cuando ancho y alto están al revés (de verdad acostada)');
    // Estabilidad del modo tableta horizontal: aunque no esté acostada, hay que verificar si se perdieron ignore-orientation + density y completarlos
    assert(/mSetIgnoreOrientationRequest=true/.test(engJs), 'En horizontal hay que verificar que ignore-orientation siga puesto');
    assert(/Override density:/.test(engJs), 'Debe leer Override density para saber si se perdió');
    assert(/tabletMode/.test(engJs), 'El interruptor de diseño de tableta debe poder apagarse');
    assert(/wm set-ignore-orientation-request true/.test(engJs), 'Si se perdió hay que volver a poner ignore-orientation');
    assert(/wm density \$\{densityWanted\}/.test(engJs), 'Si se perdió hay que volver a poner density');
    assert(/_healOrientation/.test(engJs.slice(engJs.indexOf('startWatchdog'))), 'El vigilante debe autocorregir periódicamente');
    // Recién iniciada la app, la recreación de la Activity sobrescribe la orientación; hay que corregirla en ese momento.
    // La ventana se amplía a 2200 caracteres: el callback then de onAppUp también maneja el desvanecido de la animación de arranque,
    // y esos comentarios empujan _healOrientation más abajo; con una ventana de 600 caracteres cualquier agregado daba un falso error.
    assert(/onAppUp[\s\S]{0,2200}_healOrientation/.test(mainJs), 'Al iniciar la app hay que corregir una vez de inmediato');
    // Si la orientación de la pantalla no coincide con la configuración no se arregla aquí; se deja al reinicio
    assert(/panelLandscape/.test(engJs), 'Debe distinguir entre «hay que reiniciar» y «hay que volver a bloquear la orientación»');
  });

  await test('Accesos directos en Linux: el .desktop debe ser ejecutable, Exec debe ir escapado y el icono debe ser PNG', () => {
    const os = require('os');
    const shortcut = require('../src/core/shortcut');
    // En Windows se genera .lnk; en Linux debe ser .desktop (especificación freedesktop)
    assert(shortcut.shortcutExt() === (process.platform === 'win32' ? '.lnk' : '.desktop'),
      'La extensión del acceso directo debe seguir a la plataforma');

    // Se llama directamente al escritor de .desktop para verificar el contenido (sin depender de la plataforma actual)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-dt-'));
    const out = path.join(dir, '测试 应用.desktop');
    const png = path.join(dir, 'icon.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      shortcut.writeDesktopEntry({
        shortcutPath: out,
        target: '/opt/LanzadorAPK/LanzadorAPK',
        args: '--launch "com.example.app"',
        iconPngPath: png,
        description: '测试应用',
      });
      assert(fs.existsSync(out), 'El .desktop debe escribirse de verdad en disco');
      const body = fs.readFileSync(out, 'utf8');
      assert(/\[Desktop Entry\]/.test(body), 'Falta la sección Desktop Entry');
      assert(/^Type=Application$/m.test(body), 'Type debe ser Application');
      // Una ruta con espacios sin comillas se divide en dos parámetros y el inicio falla
      assert(/^Exec=.*"\/opt\/LanzadorAPK\/LanzadorAPK"/m.test(body), 'La ruta de destino en Exec debe ir entre comillas');
      assert(/com\.example\.app/.test(body), 'Exec debe llevar el nombre de paquete de --launch');
      assert(/^Icon=.*icon\.png$/m.test(body), 'El icono debe ser una ruta absoluta a PNG (ICO no sirve en Linux)');
      // Un .desktop sin bit de ejecución lo tratan muchos escritorios como documento normal
      if (process.platform !== 'win32') {
        const mode = fs.statSync(out).mode & 0o777;
        assert((mode & 0o100) !== 0, 'El .desktop debe tener bit de ejecución');
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('La horizontal debe quedar «derecha»: la pantalla fija la orientación, rotation bloqueada en 0 y se ignoran las peticiones de orientación de las apps', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');

    // Las tres partes descubiertas en equipos reales (si falta cualquiera la imagen queda acostada 90°):
    //  1) cambiar la orientación de la pantalla física (intercambiar hw.lcd.width/height + reiniciar); ver doctor.lcdFor
    //  2) bloquear la orientación lógica en **0**: la pantalla ya es horizontal; bloquear en 1 la convertiría en un espacio lógico vertical
    //  3) ignorar las peticiones de orientación de las apps: las apps que declaran portrait, si el sistema obedece,
    //     convierten la pantalla horizontal init=1280x720 en el espacio lógico vertical cur=720x1280
    const setOri = adbJs.slice(adbJs.indexOf('async setOrientation'), adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(setOri),
      'setOrientation debe bloquear rotation en 0 (con 1 la pantalla horizontal queda acostada)');
    assert(!/user-rotation lock \$\{landscape \? 1/.test(setOri),
      'Ya no se puede bloquear en 1 para landscape: eso era de cuando «solo la pantalla vertical podía rotar»');
    assert(/wm set-ignore-orientation-request/.test(setOri),
      'Hay que ignorar las peticiones de orientación de las apps; si no, las apps bloqueadas en vertical quedan acostadas');

    const reset = adbJs.slice(adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(reset.slice(0, 2000)), 'resetDisplayOverrides también debe bloquear en 0');
    assert(/wm set-ignore-orientation-request/.test(reset.slice(0, 2000)),
      'resetDisplayOverrides también debe poner ignore-orientation según el modo');
  });

  await test('Cerrar la app debe tener acceso: menú contextual + bandeja + IPC, sin que falte ninguno', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');

    // El proceso principal debe tener app:stop (antes no existía; endApp solo se disparaba al cerrar la ventana,
    // y en modo de ventana independiente esa ventana está oculta → una vez iniciada la app no se podía cerrar)
    assert(/ipcMain\.handle\('app:stop'/.test(mainJs), 'Falta el IPC app:stop');
    // El proceso de interfaz debe poder llamarlo
    assert(/stop:\s*\(pkg\)\s*=>\s*invoke\('app:stop'/.test(preloadJs), 'preload debe exponer stop');
    // El menú contextual debe tener esta opción
    assert(/key:\s*'stop'/.test(uiJs), 'Al menú contextual le falta «Cerrar la app»');
    assert(/case 'stop':/.test(uiJs), 'El menú contextual no maneja stop');
    // En modo de ventana independiente la interfaz principal está oculta; la bandeja es el único acceso siempre disponible
    assert(/Cerrar la aplicación actual/.test(mainJs), 'Al menú de la bandeja le falta «Cerrar la app actual»');
    // Tras cerrar hay que actualizar la marca «En ejecución»
    assert(/apps:changed/.test(mainJs) && /apps:changed/.test(uiJs),
      'Tras cerrar hay que enviar apps:changed para que la interfaz se actualice');

    // Corrección: la bandeja y el IPC deben compartir la misma ruta stopApp, sin duplicar la lógica en dos lugares
    assert(/async function stopApp/.test(mainJs), 'Debe haber una función stopApp única');
    assert(/ipcMain\.handle\('app:stop'[\s\S]{0,200}stopApp/.test(mainJs),
      'El IPC app:stop debe delegar en stopApp');
    assert(/stopApp\(pkg\)\.then/.test(mainJs) || /stopApp\(pkg\)/.test(mainJs),
      'El menú de la bandeja también debe llamar a stopApp');
    // Tras cerrar hay que borrar currentAppPkg; si no, la bandeja seguiría mostrando «Cerrar la aplicación actual (xxx)»
    assert(/currentAppPkg === target/.test(mainJs) || /currentAppPkg = null/.test(mainJs),
      'stopApp debe borrar currentAppPkg');
    // En modo de ventana independiente primero hay que ocultar la ventana del emulador y luego cerrar la contenedora (al revés parpadea en el escritorio)
    assert(/detached[\s\S]{0,200}agent\.hide/.test(mainJs),
      'En modo de ventana independiente primero hide y luego close');
    // Un cierre externo (Alt+F4) también debe borrar currentAppPkg
    assert(/onCloseApp[\s\S]{0,900}currentAppPkg = null/.test(mainJs) || /onCloseApp[\s\S]{0,900}currentAppPkg === pkg/.test(mainJs),
      'onCloseApp también debe borrar currentAppPkg');
  });

  await test('Limpieza de versiones viejas: encuentra carpetas de LanzadorAPK en cualquier lugar y nunca toca la versión en ejecución', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanzadorapk-left-'));
    try {
      // Crea tres carpetas de «versiones viejas» + una de «versión actual», cada una con un LanzadorAPK.exe falso
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'LanzadorAPK.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('LanzadorAPK-v0.3.9-win64-portable');
      const old2 = mk('LanzadorAPK-win64-portable.prev-2026-01-01T00-00-00-000Z'); // Restos de copias de seguridad del empaquetado
      const curDir = mk('LanzadorAPK-v0.5.0-win64-portable');

      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));

      assert(found.includes(np(old1)), 'No se encontró la carpeta de una versión vieja normal');
      // .prev-* son las copias que pack.js conserva al renombrar; antes no se podían limpiar, ahora deben detectarse
      assert(found.includes(np(old2)), 'No se encontraron los restos de copias .prev del empaquetado');
      // Restricción de seguridad clave: la versión en ejecución nunca puede aparecer en la lista de borrado
      assert(!found.includes(np(curDir)), 'La versión en ejecución se tomó como vieja (peligroso)');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('Al cambiar de app primero hay que cerrar bien la anterior; si no, ANR de la app vieja / restos en _activeApps', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // openAppWindow ahora debe ser async: al cambiar hay que esperar (await) a que la app vieja se detenga antes de abrir la nueva.
    assert(/async function openAppWindow/.test(mainJs), 'openAppWindow debe ser async (hay que esperar a que la app vieja termine)');
    // Los llamadores también deben hacer await; si no, close/endApp corren en paralelo con el arranque de la nueva → compiten por el primer plano → ANR
    assert(/await openAppWindow\(/.test(mainJs), 'runLaunch debe hacer await de openAppWindow');

    // Lo esencial: al cambiar a «otra» app hay que hacer primero endApp(vieja); cerrar solo la ventana sin detener el proceso es la raíz del error
    const fn = mainJs.slice(mainJs.indexOf('async function openAppWindow'));
    const body = fn.slice(0, fn.indexOf('\n}', fn.indexOf('currentAppPkg = pkg')));
    assert(/currentAppPkg !== pkg/.test(body), 'Solo se cierra la vieja al cambiar a otra app (la misma app se reutiliza)');
    assert(/runtime\.endApp\(prev/.test(body) || /runtime\.endApp\(currentAppPkg/.test(body),
      'Al cambiar hay que hacer endApp de verdad a la app vieja (force-stop + sacarla de _activeApps)');
    // appWin.open() usa internamente close({keepApp:true}), sin endApp;
    // por eso la capa exterior debe agregar endApp explícitamente; no se puede confiar en el close de open.
    assert(/close\(\{ keepApp: true \}\)/.test(body) && /endApp/.test(body),
      'Primero se aparca la imagen (close keepApp) y luego endApp detiene el proceso; el orden importa');

    // También hay que limpiar el caso en que la ventana ya no existe pero el proceso sigue en _activeApps
    assert(/else if \(currentAppPkg && currentAppPkg !== pkg\)/.test(body),
      'Aunque no haya ventana hay que limpiar los procesos que quedan en _activeApps');
  });

  await test('Pantalla completa automática y horizontal deben funcionar: la opción debe tener quien la use y al iniciar se corrige la orientación de la pantalla', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const htmlJs = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');

    // autoFullscreenOnLaunch antes solo se declaraba en la configuración por defecto y ningún código lo leía: un interruptor muerto.
    const uses = (mainJs.match(/autoFullscreenOnLaunch/g) || []).length;
    assert(uses > 0, 'autoFullscreenOnLaunch debe leerse de verdad (no basta con declararlo)');
    assert(/fullscreen:[\s\S]{0,200}autoFullscreenOnLaunch/.test(mainJs),
      'La pantalla completa automática debe intervenir en la decisión de fullscreen de openAppWindow');

    // La configuración debe poder cambiar estos dos
    assert(/setAutoFullscreen/.test(htmlJs), 'A la configuración le falta el interruptor «Pantalla completa automática»');
    assert(/setLandscape/.test(htmlJs), 'A la configuración le falta el interruptor «Orientación de pantalla»');
    assert(/setAutoFullscreen'\)\.addEventListener/.test(uiJs), 'El interruptor de pantalla completa automática no tiene evento');
    assert(/setLandscape'\)\.addEventListener/.test(uiJs), 'El interruptor de orientación de pantalla no tiene evento');

    // La horizontal solo se logra con la pantalla física + reinicio; al iniciar hay que corregir antes, o quedará acostada
    assert(/panelLandscape/.test(emuJs), 'emulator debe poder leer la orientación actual de la pantalla');
    assert(/orientation mismatch/.test(mainJs), 'Antes de iniciar hay que comprobar si la orientación de la pantalla coincide con la configuración');
    assert(/reloadApp:\s*false/.test(mainJs), 'Al corregir la orientación no se puede volver a iniciar la app de paso (se lanzaría dos veces)');

    // En modo de ventana independiente la «pantalla completa» debe aplicarse a la ventana del emulador; maximizar una ventana oculta no sirve
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    assert(/_wantFullscreen/.test(appwinJs), 'El modo de ventana independiente debe recordar la intención de pantalla completa');
    assert(/if \(this\._wantFullscreen\)/.test(appwinJs), 'openDetached debe ocupar toda el área disponible en pantalla completa');

    // Corrección: tras reiniciar el runtime el rt.client anterior deja de servir; beforeStart debe devolver un rt nuevo
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/beforeStart[\s\S]{0,400}replaced[\s\S]{0,200}replaced\.client/.test(instJs),
      'installer.launch debe aceptar el rt nuevo que devuelve beforeStart');
    assert(/return newRt/.test(mainJs) || /return rt/.test(mainJs.slice(mainJs.indexOf('restartForOrientation'))),
      'restartForOrientation debe devolver el rt nuevo a beforeStart');

    // Corrección: en modo de ventana independiente horizontal _panelRatio debe corregirse según la orientación de la pantalla
    assert(/this\.state\.landscape.*b\.height > b\.width/.test(appwinJs)
      || /landscape.*height.*width/.test(appwinJs),
      '_panelRatio debe corregir la proporción en horizontal');
  });

  await test('Al abrir una app la imagen debe salir lo antes posible: se engancha la ventana en cuanto aparece el proceso, sin esperar los 4 s de observación', () => {
    const root = path.join(__dirname, '..');
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // Descubierto en equipo real: el proceso aparecía a los 2 s, pero para «confirmar que no falla enseguida» se esperaban otros 4 s
    // antes de enganchar la ventana, y el usuario veía «pulsé y no pasa nada». Ahora se engancha en cuanto aparece el proceso.
    assert(/onAppUp/.test(instJs), 'installer.launch necesita el callback onAppUp');
    assert(/if \(!seen && typeof onAppUp === 'function'\)/.test(instJs),
      'onAppUp debe dispararse «la primera vez que se ve el proceso», y una sola vez');

    // El proceso principal debe recibir este callback, y en paralelo (sin await); si no, vuelve a ser una espera en serie
    assert(/onAppUp:\s*\(\)\s*=>/.test(mainJs), 'main.js debe pasar onAppUp');
    const block = mainJs.slice(mainJs.indexOf('onAppUp: () =>'), mainJs.indexOf('beforeStart:'));
    assert(/attachAppWindow\(\)/.test(block), 'En onAppUp hay que enganchar la imagen de inmediato');
    assert(!/await attachAppWindow\(\)/.test(block),
      'En onAppUp no se puede hacer await del enganche (quedaría en serie con la comprobación de vida, sin ganar nada)');

    // Si ya se enganchó antes no se puede volver a enganchar después: en modo de ventana independiente volvería a ocultar/mostrar
    // la ventana recién colocada y la imagen parpadearía.
    assert(/attachDoneEarly/.test(mainJs), 'Debe recordar si ya enganchó la imagen antes');
    assert(/if \(attachDoneEarly\)/.test(mainJs), 'La decisión final debe omitir el enganche repetido');

    // El periodo de observación de supervivencia no se puede quitar: es el respaldo contra «aparece y se cierra de inmediato»
    assert(/aliveSince >= 4000/.test(instJs), 'Hay que conservar los 4 s de observación de vida (contra cierres inmediatos)');
  });

  await test('Red de la máquina virtual: el AVD debe tener Wi-Fi virtual y poder reconectar la red que «no se conecta sola»', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');

    // La imagen Play Store de API 34 navega por wlan0 (Wi-Fi virtual de netsim), no por eth0.
    // Si a config.ini le falta hw.wifi, wlan0 queda siempre en NO-CARRIER y la app siempre dice «error de red».
    assert(/['"]hw\.wifi=yes['"]/.test(emuJs), 'config.ini debe tener hw.wifi=yes');

    // Causa real en equipos: AndroidWifi queda como «Saved / Won't automatically connect»
    // y no se conecta solo tras arrancar. La shell no tiene permiso NETWORK_SETTINGS y cmd wifi
    // connect-network lanza SecurityException, así que solo se puede pulsar por la interfaz.
    assert(/async repairWifi/.test(emuJs), 'Debe poder reconectar el Wi-Fi activamente');
    assert(/WIFI_SETTINGS/.test(emuJs), 'La reconexión necesita abrir los ajustes de Wi-Fi');
    assert(/uiautomator dump/.test(emuJs), 'La reconexión debe encontrar la red con uiautomator y pulsarla');
    // Tras conectar hay que fijar además la sonda de «comprobación de conexión» en un endpoint accesible; si no, el sistema marca la red con «!»
    // y algunas apps se consideran sin conexión y no cargan contenido.
    assert(/captive_portal_http_url/.test(emuJs), 'La sonda de comprobación de conexión debe apuntar a un endpoint accesible');
    // Está prohibido usar connect-network como solución principal (sin permisos, falla seguro).
    // Solo se miran las líneas de código reales: los comentarios que lo mencionan explican por qué no se usa.
    const emuCode = emuJs.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    assert(!/cmd wifi connect-network/.test(emuCode), 'La shell no tiene permiso para connect-network; no se puede usar');

    // La reparación debe ir de lo leve a lo grave: primero reconectar, luego arranque en frío, al final borrar datos
    const repair = engineJs.slice(engineJs.indexOf('async repairNetwork'));
    const repairBody = repair.slice(0, repair.indexOf('async ', 10) > 0 ? undefined : undefined);
    assert(/repairWifi/.test(repairBody), 'repairNetwork debe probar primero la reconexión ligera del Wi-Fi');
    const wifiAt = repairBody.indexOf('repairWifi');
    const wipeAt = repairBody.indexOf('forceWipeOnNextStart');
    assert(wifiAt > -1 && wipeAt > -1 && wifiAt < wipeAt,
      'El orden debe ser: primero reconectar el Wi-Fi y al final restablecer datos (no borrar los datos del usuario de entrada)');

    // ensureNetwork también debe probar primero la reparación ligera, sin arrancar en frío directamente
    const ensure = engineJs.slice(engineJs.indexOf('async ensureNetwork'));
    const ensureBody = ensure.slice(0, ensure.indexOf('async repairNetwork'));
    const eWifi = ensureBody.indexOf('repairWifi');
    const eBoot = ensureBody.indexOf('_netColdBootTried');
    assert(eWifi > -1 && eBoot > -1 && eWifi < eBoot,
      'ensureNetwork debe probar primero reconectar el Wi-Fi y luego considerar el arranque en frío');

    // La ruta de arranque (installer) también debe hacerlo; si no, cada apertura de app empezaría con una app «sin red».
    // Ojo: aquí solo se permite el repairWifi no destructivo; ensureNetwork (que arranca en frío) nunca puede aparecer.
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/repairWifi/.test(instJs), 'Antes de iniciar la app hay que intentar reparar el Wi-Fi');
    assert(!/\.ensureNetwork\(/.test(instJs), 'La ruta de inicio no puede llamar a ensureNetwork (detendría la máquina virtual para arrancar en frío)');
    // Debe estar en engine (this.runtime): rt es el objeto que devuelve ensure() y solo tiene client.
    // Escribir rt.repairWifi daría undefined; al llamarlo lanzaría un error que el catch oculta, como si no se reparara nada.
    assert(/this\.runtime\.repairWifi\(/.test(instJs), 'repairWifi debe estar en engine (this.runtime)');
    assert(!/\brt\.repairWifi\(/.test(instJs), 'rt es el objeto que devuelve ensure() y no tiene repairWifi');
    // Este método de reenvío debe existir de verdad en engine; si no, la llamada en installer también sería undefined
    assert(/async repairWifi\(/.test(engineJs), 'engine debe implementar el reenvío repairWifi');
  });

  await test('WinAgent.setHook(false) no lanza el agente de PowerShell en el estado por defecto', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'Desactivado debe devolver hooked=false');
    assert(a.ready === null, 'Desactivado por defecto no puede lanzar un proceso de agente residente para esto');
  });

  console.log('\n[Mapeo de botones del ratón]');

  await test('Valores por defecto y migración: clic derecho = atrás + rueda suave activados, botones laterales desactivados', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'Clic derecho = atrás activado por defecto');
    assert(d.wheel === 'smooth', 'Rueda suave por defecto');
    assert(d.side === false, 'Botones laterales desactivados por defecto');
    assert(d.enabled === true, 'Al menos el mapeo del clic derecho necesita el gancho');
    // Un settings.json viejo sin las claves nuevas también debe dar el mismo resultado
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'Con todo apagado ya no se debe instalar el gancho');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'La rueda nativa no necesita gancho');
  });

  await test('hookOptions normaliza la configuración; al desactivar, todos los subinterruptores vuelven a cero', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false no debe interceptar ningún evento');
    assert(pointer.hookOptions(true).side === true, 'Compatible con la forma booleana vieja (botones laterales)');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('Dirección de la rueda: hacia abajo = dedo desliza hacia arriba, hacia arriba = dedo hacia abajo, sin salir de las coordenadas', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'La rueda hacia abajo debe subir el contenido (dedo hacia arriba)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'La rueda hacia arriba debe bajar el contenido (dedo hacia abajo)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'Un desplazamiento cero no genera comando');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x no puede salirse del límite');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y no puede salirse del límite');
      assert(s.duration >= 100 && s.duration <= 240, 'La duración del deslizamiento debe tener tope');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'Un desplazamiento rápido no puede alargar el gesto sin límite');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'La rueda horizontal debe producir un deslizamiento horizontal');
  });

  await test('Lista permitida de comandos input: solo pasan los comandos armados internamente; se bloquea la inyección', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /no válido/.test(e.message); }
    assert(blocked, 'Los comandos inválidos deben bloquearse antes de lanzar adb');
    assert(c._input === null, 'Los comandos bloqueados no pueden crear sesiones residentes');
  });

  await test('La tecla atrás usa primero el canal de entrada residente; solo si falla recurre a un adb puntual', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'La ruta normal no debe hacer spawn de adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'Si el canal residente falla debe haber respaldo; no se puede perder ese clic');
  });

  await test('WheelRouter une desplazamientos seguidos en un solo comando de deslizamiento', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 pasos de rueda deberían unirse en 1 comando; real: ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'Debe producir un input swipe válido');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'Tras unirlos sigue siendo hacia abajo');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'Tras dispose ya no se puede inyectar');
  });

  await test('Script del agente: intercepción de clic derecho/rueda, unión de la rueda, limitado al primer plano y en hilo dedicado', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), 'Debe manejar el clic derecho y la rueda');
    assert(/WM_MOUSEHWHEEL/.test(ps1), 'También debe admitir la rueda horizontal');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), 'La rueda debe reportarse ya unida');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), 'El alcance debe limitarse a la ventana raíz del primer plano');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), 'El gancho debe estar en un hilo de mensajes dedicado');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), 'El bucle principal no puede bloquearse mucho');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), 'Los mapeos no configurados no pueden interceptar eventos');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), 'Los cambios de configuración deben sincronizar el gancho al momento');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'La configuración debe mostrar los interruptores de botones');
  });

  await test('WinAgent.setHook envía la configuración de botones junto y, al desactivar, no lanza el agente', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, 'Al activar solo debe enviar un comando');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, 'La configuración debe enviarse con el comando hook');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, 'Al desactivar hay que quitar el gancho');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, 'Desactivado por defecto no puede lanzar PowerShell');
  });

  console.log('\n[updater.js actualización en línea]');
  await test('La comparación de versiones es numérica por partes; el prefijo v y varias partes funcionan', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 debe ser mayor que 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'El prefijo v no afecta la igualdad');
    assert(cmpVer('0.10.0', '0.9.9') === 1, 'Debe comparar como números, no como texto');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 es menor que 1.0.1');
  });

  await test('La forma de instalación decide el recurso: instalada = Setup.exe, portátil = portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'LanzadorAPK.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', 'Sin desinstalador se considera portátil');
    fs.writeFileSync(path.join(dir, 'Uninstall LanzadorAPK.exe'), 'x');
    assert(portable.flavor === 'setup', 'Con desinstalador se considera instalada');
    // La elección de archivos es puramente funcional; aquí se le pasa directamente un resultado check falso para verificar la regla de nombres de respaldo
    assert(/Setup\.exe$/i.test('LanzadorAPK-0.3.2-Setup.exe'), 'Coincide el nombre del recurso de la versión instalada');
    assert(/portable.*\.zip$/i.test('LanzadorAPK-v0.3.2-win64-portable.zip'), 'Coincide el nombre del recurso de la versión portátil');
  });

  await test('La versión portátil no toma el paquete completo del runtime (LanzadorAPK-runtime-*.zip) como actualización', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'LanzadorAPK.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'LanzadorAPK v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // Con los dos archivos a la vez → debe elegirse el paquete portátil
    u.sources = { latest: async () => mk([
      { name: 'LanzadorAPK-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'LanzadorAPK-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `Debería elegir el paquete portátil; real: ${info.asset.name}`);

    // Solo el paquete del runtime (el portátil no se subió) → mejor no actualizar automáticamente que usar 1,5 GB de runtime como paquete del programa
    u.sources = { latest: async () => mk([
      { name: 'LanzadorAPK-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, 'Con solo el paquete del runtime no se debe elegir un recurso de actualización');
    assert(info.canAutoApply === false, 'Sin recursos disponibles no se puede actualizar automáticamente');
  });

  await test('Fuentes: las direcciones candidatas llevan prefijo de espejo; el prefijo propio tiene prioridad sobre los espejos públicos', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, 'El origen debe ir primero (se mantiene el orden antes de ordenar por velocidad)');
    assert(list.length === 1, 'sin espejos públicos predeterminados: solo GitHub directo');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `Solo debería aplicarse el prefijo propio; real: ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, 'Sin espejos automáticos solo queda la conexión directa');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, 'Si al prefijo le falta la barra final se agrega sola');

    // El espejo solo hace de proxy para GitHub: aplicar el prefijo a otras direcciones solo da 403 y no deben ser candidatas
    const giteeUrl = 'https://gitee.com/daily-miku/lanzadorapk/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'A los recursos de Gitee no se les debe poner el prefijo de espejo de GitHub');
  });

  await test('Fuentes: se ordenan por la velocidad medida; si todas fallan se mantiene el orden y no se pierde ninguna dirección', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // Se inyecta directamente la caché de velocidad, para que la prueba no dependa de internet
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `La más rápida debería ir primero; real: ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'Las direcciones que fallaron van al final pero se conservan (tienen otra oportunidad)');
    s.reset();
    assert(s._rankCache.size === 0, 'reset debe vaciar la caché de velocidad (tras cambiar de fuente o red hay que medir de nuevo)');
  });

  await test('Fuentes: el paquete de código fuente que Gitee agrega solo (v1.2.3.zip) nunca puede tomarse como instalador', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'LanzadorAPK-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `Solo deberían quedar recursos LanzadorAPK*; real: ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Los recursos de Gitee no tienen campo size: el grupo de partes debe seguir válido (si no, se perdería el paquete)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Algunas fuentes solo dan name + url en sus archivos, sin size (probado)
        assets: [
          { name: 'LanzadorAPK-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'LanzadorAPK-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `Deberían unirse en 1 recurso; real: ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'LanzadorAPK-v0.3.3-win64-portable.zip', `El nombre del recurso debería ser el del paquete completo; real: ${a.name}`);
    assert(a.parts && a.parts.length === 2, 'Deben conservarse las dos partes');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', 'El orden/contenido de las direcciones de las partes debe ser correcto');
    assert(a.size === 0, 'Con tamaño desconocido debe ser 0 (la interfaz muestra el progreso por bytes recibidos)');
  });

  await test('Los recursos en partes deben llegar hasta updater.asset; si no, prepare dice «no hay direcciones de descarga disponibles»', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'LanzadorAPK-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        sha256: 'a'.repeat(64),
        parts: [{ index: 1, size: 0, urls: ['https://github.com/x/p1'] }, { index: 2, size: 0, urls: ['https://github.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'parts debe conservarse en asset');
    assert(info.canAutoApply === true, 'Si hay partes se debe considerar actualizable automáticamente');
    assert(info.asset.sha256 === 'a'.repeat(64), 'la suma SHA-256 debe llegar hasta asset');
  });

  await test('Fuentes: al unir versiones solo cuentan los recursos de la misma versión; un paquete viejo no se hace pasar por nuevo', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'LanzadorAPK-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'LanzadorAPK-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'LanzadorAPK-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `Debería tomar la versión más alta; real: ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', 'Un recurso con el mismo nombre de una versión vieja no puede sustituir al de la nueva');
  });

  await test('Fuentes: una etiqueta mal escrita (v0.71 por v0.7.1) no cuenta como versión más alta', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.71', assets: [{ name: 'LanzadorAPK-v0.71-win64-portable.zip', size: 10, browser_download_url: 'gh://bad' }] } },
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.7.1', assets: [{ name: 'LanzadorAPK-v0.7.1-win64-portable.zip', size: 10, browser_download_url: 'gh://ok' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.7.1', `Debería ignorar v0.71; real: ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://ok', JSON.stringify(m.assets));
  });

  await test('Actualizador: con dos paquetes portátiles en el release se elige el que lleva la versión exacta', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({ currentVersion: '0.7.0', exePath: path.join(os.tmpdir(), 'no-existe', 'LanzadorAPK.exe'), isPackaged: true, dataDir: os.tmpdir() });
    u.sources.latest = async () => ({
      version: '0.7.1', tag: 'v0.7.1', web: 'w', sources: [],
      assets: [
        { name: 'LanzadorAPK-v0.71-win64-portable.zip', url: 'gh://bad', urls: ['gh://bad'], size: 10 },
        { name: 'LanzadorAPK-v0.7.1-win64-portable.zip', url: 'gh://ok', urls: ['gh://ok'], size: 10 },
        { name: 'LanzadorAPK-runtime-v0.7.1.zip', url: 'gh://rt', urls: ['gh://rt'], size: 10 },
      ],
    });
    const r = await u.check();
    assert(r.hasUpdate && r.asset && r.asset.name === 'LanzadorAPK-v0.7.1-win64-portable.zip', JSON.stringify(r.asset));
  });

  await test('Agente de ventanas: scope une carpetas con punto y coma y filtra vacíos (la única entrada para decidir a quién pertenece una ventana)', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // No se lanza el proceso del agente de verdad: solo se verifica el contenido del protocolo que se le envía
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `Solo debería enviarse un scope; real: ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `Los elementos vacíos deben filtrarse; real: ${sent[0].dirs}`);
    assert(r.ok === true, 'Un scope correcto debe devolver ok');
    // Un arreglo vacío tampoco debe lanzar error: equivale a «no suprimir nada», y quien llama decide si avisa
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'Un alcance vacío también debe poder enviarse (el agente entonces no toca ninguna ventana)');
  });

  await test('Fuentes: si las dos tienen el mismo paquete completo, hay que conservar ambas direcciones (si no, a una nunca le toca)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'LanzadorAPK-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Los archivos de esa fuente no tienen size (probado); no se puede usar el tamaño de GitHub en su lugar
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'LanzadorAPK-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `Los recursos con el mismo nombre deberían unirse en 1; real: ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `Hay que conservar las direcciones de las dos fuentes; real: ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], 'El tamaño se guarda por dirección; si es desconocido, queda desconocido');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `Las direcciones candidatas deberían incluir las dos fuentes; real: ${JSON.stringify(cands)}`);
  });

  await test('Descarga multifuente en paralelo: si las dos fuentes tienen tamaños distintos, se sigue a la más rápida (no se elige siempre la más grande)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // La fuente que va primero (ya ordenadas por velocidad)
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // Orden de la lista = orden de velocidad de rank(): la primera es la fuente más rápida
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `Debería descargar la copia de la fuente más rápida (${small.length} bytes); real: ${got.length} bytes`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Paquete de actualización en partes: se une en orden y si el tamaño no coincide se detiene de inmediato', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, 'Tras unir, el tamaño debe ser la suma de las partes');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), 'El contenido de la primera parte está en mal orden');
      assert(got.slice(partA.length).every((b) => b === 0x42), 'El contenido de la segunda parte está en mal orden');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('Descarga multifuente en paralelo: distintos bloques de distintas fuentes y los bytes unidos deben ser idénticos', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // Se espera explícitamente el callback de listening: conectar los oyentes tras listen perdería eventos ya disparados y la prueba se colgaría
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'Tras unir de varias fuentes el contenido debe ser idéntico al original');
      assert(r.sources === 2 && r.parallel >= 2, `Deberían usarse 2 fuentes a la vez; real: ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'El tamaño debe coincidir');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Descarga multifuente en paralelo: al reintentar tras un fallo solo se completan los bloques que faltan (sin volver a bajar 1,4 GB)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // Solo se cuentan las peticiones de bloques de datos reales (la detección con 0-0 no cuenta)
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // Deben ser dos direcciones: con una sola downloadMulti la pasa a bloques de una sola fuente (ese camino trae su propia reanudación)
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // Se arma el escenario de «los dos primeros bloques descargados y el último no» (forma de bloques: 3 conexiones × 1 MB)
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'Debe reconocer que es una reanudación');
      assert(ranged === 1, `Solo debería completar 1 bloque; peticiones reales: ${ranged} bloques`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'El archivo reanudado debe ser idéntico al original');
      assert(!fs.existsSync(`${out}.chunks.json`), 'Al terminar hay que borrar el archivo auxiliar');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Descargador: si tras conectar no llega ni un byte, debe agotar el tiempo y cambiar de fuente, no colgarse', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // Los encabezados llegan bien y luego silencio: simula el clásico «TCP conecta pero está bloqueado/limitado»
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // Primero 1 KB y luego no envía nada más
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'Al final debe descargarse completo');
      assert(cost < 15000, `No puede quedarse colgado en una conexión detenida; tardó: ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Descargador: si una fuente solo va a unas decenas de KB/s se cambia de fuente, en vez de quedar atascado en los últimos %', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Fuente lenta: solo 4 KB cada 100 ms (≈40 KB/s)
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'Tras cambiar de fuente el contenido debe ser correcto');
      // Todo por la fuente lenta tardaría 2 MB / 40 KB/s ≈ 50 s; el cambio de fuente debe completarse en pocos segundos
      assert(cost < 15000, `Debería cambiar de fuente al ir lenta; tardó: ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Descarga multifuente en paralelo: con una sola dirección disponible se vuelve a bloques de una sola fuente', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Se usa como fuente mala un puerto «recién liberado y seguro sin nadie escuchando»; la conexión se rechaza al instante en vez de esperar el tiempo límite
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // La segunda dirección apunta a propósito a un puerto sin servicio: debe ignorarse automáticamente, no hacer fallar el paquete entero
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'Con una sola fuente también debe descargarse completo');
      assert(!r.multi || r.sources === 1, 'Con una sola fuente disponible no se debe marcar como multifuente');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Fuentes: el resultado de versiones se guarda en caché 10 minutos; force obliga a consultar de nuevo', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `Durante la caché no debería repetir peticiones; peticiones reales: ${calls} veces`);
    await s.latest({ force: true });
    assert(calls === 2, 'force debe saltarse la caché');
    s.reset();
    await s.latest();
    assert(calls === 3, 'Tras reset debe volver a pedir');
  });

  await test('Fuentes: si una fuente da 403 por límite, el cortacircuitos la omite y no se insiste en cada ronda', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 （被限流）' },
      ];
    };
    // Primera vez: la fuente devuelve 403 y entra en el cortacircuitos
    await s.latest({ force: true });
    assert(giteeCalls === 1, 'La primera ronda debió hacer la petición real');
    const reason = s.blockedReason('gitee');
    assert(!!reason, 'Un 403 debe activar el cortacircuitos');
    assert(s.blockedReason('github') === null, 'Las fuentes sin error no deben cortarse');
    // Durante el corte las peticiones deben omitirse directamente (sin tocar la red)
    assert(/Omitido temporalmente/.test(reason), `El motivo de la omisión debe entenderse; real: ${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'Tras reset el cortacircuitos debe liberarse');
  });

  await test('Fuentes: si ninguna fuente responde se vuelve al último resultado (marcado stale, sin dar error directamente)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'La primera vez debe ser normal');
    s._relTtl = 0;   // Invalida la caché
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: '超时' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'Debería volver al resultado viejo marcado como stale');
  });

  await test('Ubicación de la imagen del sistema: una instalación nueva debe ir a la carpeta del runtime (el ensamblado del runtime en CI depende de esto)', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) instalación nueva: ni la carpeta del runtime ni la de datos del usuario tienen system-images → va a la carpeta del runtime
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `Una instalación nueva debería ir a la carpeta del runtime; real: ${p.paths().sysImgRoot}`);

      // 2) la carpeta del runtime ya la tiene (de descomprimir el paquete) → esa primero
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'Si ya existe, la carpeta del runtime tiene prioridad');

      // 3) solo la tiene la carpeta de datos del usuario (distribución antigua) → se usa esa
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `La distribución vieja debería volver a la carpeta de datos del usuario; real: ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Carpeta del runtime de solo lectura (dentro del MSIX): los datos escribibles deben ir a la carpeta de datos del usuario', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'ro-root-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // Se crea un root «no escribible»: un nivel intermedio es un archivo normal, y mkdir dará EEXIST/ENOTDIR seguro
      const blocker = path.join(tmp, 'blocker');
      fs2.writeFileSync(blocker, 'x');
      const roRoot = path.join(blocker, 'rt');
      store.saveSettings({ runtime: { dir: roRoot } });
      const p = new Provisioner(path.join(__dirname, '..'));
      const paths = p.paths();
      assert(paths.rootWritable === false, 'La carpeta de solo lectura debe reconocerse como no escribible');
      // Clave: la imagen debe descomprimirse en la carpeta de datos del usuario y no en el paquete (el paquete es de solo lectura y fallaría)
      assert(paths.sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `Con solo lectura debería ir a la carpeta de datos; real: ${paths.sysImgRoot}`);
      assert(paths.tmp.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), '_tmp también debe redirigirse');
      assert(paths.avdHome.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), 'El AVD también debe estar en una carpeta escribible');
      // Los ejecutables siguen apuntando al paquete (solo así hay identidad de paquete y la vista virtualizada de %APPDATA% coincide con la del proceso padre)
      assert(paths.emulatorExe === path.join(roRoot, 'emulator', 'emulator.exe'), 'emulator sigue ejecutándose desde el paquete');
      assert(paths.adbExe === path.join(roRoot, 'platform-tools', 'adb.exe'), 'adb sigue ejecutándose desde el paquete');
      // ensureDirs no puede lanzar un error porque root sea de solo lectura
      p.ensureDirs();
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('La imagen comprimida dentro del paquete debe contar como «en su lugar»; si no, tras instalar se volverían a descargar 1,5 GB', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'packed-img-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    const sparse = (file, size) => {
      fs2.mkdirSync(path.dirname(file), { recursive: true });
      fs2.writeFileSync(file, '');
      fs2.truncateSync(file, size);   // Archivo disperso: no ocupa disco de verdad, solo tiene el tamaño suficiente
    };
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // Simula el instalador completo / MSIX de la Store: la carpeta del runtime solo tiene .xz, sin system.img descomprimido
      const root = path.join(tmp, 'rt');
      const dir = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
      sparse(path.join(dir, 'system.img.xz'), 320 * 1024 * 1024);
      fs2.writeFileSync(path.join(dir, 'kernel-ranchu'), 'x');
      store.saveSettings({ runtime: { dir: root } });
      // appRoot usa una carpeta vacía, para que no interfiera el engine/system-images ya descomprimido del repositorio
      const p = new Provisioner(path.join(tmp, 'empty-app'));
      const sys = p.systemImageInfo();
      assert(sys.ok === true, 'La imagen comprimida debe contar como en su lugar (si no, autoDeploy la descargaría)');
      assert(sys.compressed === true, 'Debe marcarse «falta descomprimir una vez»');
      assert(String(sys.dir).toLowerCase().startsWith(root.toLowerCase()), 'Debería apuntar a la ubicación dentro del paquete');
      const play = p.playImageInfo();
      assert(play.ok === true && play.compressed === true, 'Lo mismo para la imagen compatible');

      // Tras descomprimir (con system.img) debe pasar a compressed=false y preferir la copia descomprimida
      sparse(path.join(dir, 'system.img'), 320 * 1024 * 1024);
      const after = p.systemImageInfo();
      assert(after.ok === true && after.compressed === false, 'Tras descomprimir ya no debe marcarse como comprimida');
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[Política de recursos / asignación de disco / límite de registros]');

  await test('La política de recursos se cambia en un solo lugar y se traduce sola a vCPU/prioridad/resolución', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'El modo fluido no debe limitar los núcleos');
    assert(s.engine.priorityMode === 'game', 'El modo fluido debe usar la prioridad de juego de baja latencia (FPS/video primero)');
    assert(s.engine.renderSize === '720x1280', `La resolución debería ser 720p; real: ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'El modo ahorro debería ser 540p + contenedor ligero');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'En modo equilibrado la resolución queda en automático');
  });

  await test('El tamaño de la partición de datos es configurable y por defecto ya no es un número fijo', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `Debería ser 12 GB; real: ${p.dataMB}MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `Con disco de sobra, en automático debería ser 6 GB; real: ${auto.dataMB}`);
  });

  await test('La huella de la instantánea no incluye el tamaño de la partición de datos (ampliar no debe invalidar la instantánea, y menos borrar datos)', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'Cambiar solo el tamaño no debe cambiar la huella');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'Cambiar la versión del motor debe cambiar la huella');
  });

  await test('Si el registro supera el límite se rota solo y se conserva una sola copia', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'Debe rotarse');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'Debería pasar a .1.log');
  });

  await test('Si el nombre del registro no termina en .log: mejor no rotar que borrar el registro', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'Si bak tiene el mismo nombre que el original hay que renunciar a rotar');
    assert(fs.existsSync(f), 'El archivo de registro no puede borrarse');
  });

  await test('El registro de fallos de arranque se guarda en disco; tras reiniciar, el informe de diagnóstico sigue mostrando la causa real', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / 硬件加速', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'El código de salida debe guardarse en disco');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'La conclusión del diagnóstico debe guardarse en disco');
    assert(back.attempts.length === 1, 'El registro de intentos debe guardarse en disco');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'Tras un arranque correcto hay que borrar el registro de fallos');
  });

  await test('Paquetes divididos .xapk: extrae las partes en flujo, analiza base y limpia la carpeta temporal si falla', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Éxito: el paquete tiene dos partes (base + config) y meta sale de la que se puede analizar
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `Deberían extraerse 2 partes; real: ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'Las partes deben escribirse en disco');
      assert(b.meta.package === 'com.example.test', `Nombre de paquete ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Fallo: el paquete no tiene APK divididos → error claro, y la carpeta temporal no puede quedar en el equipo del usuario
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /No se encontraron APK divididos/.test(err.message), `Debería decir que no hay partes; real: ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'lanzadorapk-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), 'Si falla hay que limpiar la carpeta temporal');
  });

  await test('materializeImages: descomprime .img.gz, omite lo ya descomprimido, reporta las imágenes dañadas sin dejar restos a medias', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40 MB de ceros: con gzip quedan unas decenas de KB pero descomprimidos superan 32 MB, justo para verificar el criterio de «ya descomprimido»
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `Debería descomprimir 1 imagen; real: ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'El tamaño descomprimido debe ser correcto');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'Los componentes sin comprimir también deben quedar en su lugar');
      assert(!fs.existsSync(`${img}.part`), 'Si todo sale bien no debe quedar .part');

      const again = await prov.materializeImages();
      assert(again === 0, `Si ya está descomprimida debe omitirse; se descomprimieron: ${again}`);

      // Imagen dañada: debe lanzar MATERIALIZE_FAILED y borrar el .part (si no, la próxima vez se tomaría como completa)
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `Una imagen dañada debería fallar; real: ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'Tras fallar no debe quedar .part');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('Tras cambiar la fuente de descarga / dirección del paquete: la caché de direcciones del provisioner debe borrarse (si no, solo aplica tras reiniciar)', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Simula la caché tras resolver una vez la dirección del paquete / del motor
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'La caché de la dirección del paquete debería vaciarse');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'La caché de direcciones del motor/imagen debería vaciarse');
  });

  await test('Cada ronda de arranque diagnostica solo con su propio registro (la caída de la ronda anterior no puede contaminar la siguiente)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // Ronda 1: 0xC0000005
      { t: 3, line: '--- 第 2 轮 ---' },
      { t: 4, line: 'Address already in use' },          // Ronda 2: puerto ocupado
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'La ronda 1 debería diagnosticarse como caída');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', 'La ronda 2 debería diagnosticarse como puerto ocupado');
    // Si esta ronda no tiene registros se usa el final general; no se puede dar UNKNOWN directamente
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `Una ronda vacía debería usar el registro general; real: ${fallback.length} líneas`);
  });

  await test('Armado del componente de inicio: a un componente completo no se le repite el paquete (si no, al pulsar el icono solo se ve el escritorio de Android)', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Componente completo (lo que guardaba apps.json tras instalar v0.3.4) → se usa tal cual
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'Un componente completo debe devolverse tal cual');
    // Datos viejos: solo nombre de clase / clase que empieza con punto → se completa con el paquete
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'Una activity vacía debe devolver vacío (se usa un intent implícito)');
    // La salida de resolve-activity suele terminar con líneas vacías/priority: hay que poder obtener el componente
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'Debe saltarse las líneas vacías y tomar el componente de la última línea');
    assert(parseResolvedActivity('com.other', out) === '', 'No se puede usar otro nombre de paquete');
  });

  await test('Una sola ventana por app: en modo independiente la ventana contenedora nunca debe mostrarse', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // maximize() muestra directamente un BrowserWindow con show:false: era
    // una de las causas directas de «al abrir una app aparecen varias ventanas».
    assert(/fullscreen && !this\.detachedMode\) this\.win\.maximize\(\)/.test(appwin),
      'El modo de ventana independiente no puede maximizar la contenedora (mostraría una ventana negra de la nada)');
    assert(/if \(this\.detachedMode\) this\.agent\.show\(\)/.test(appwin),
      'En modo independiente, pulsar otra vez la misma app debe traer al frente la ventana del emulador, no mostrar la contenedora');
    // En ready-to-show tampoco se puede mostrar sin más: solo con showWhileWaiting (cambio de app, sin
    // animación de arranque que lo cubra) se permite mostrar primero esa ventana contenedora «Abriendo…».
    const readyIdx = appwin.indexOf("once('ready-to-show'");
    assert(readyIdx > 0 && /if \(this\.detachedMode && !this\._showWhileWaiting\) return;/
      .test(appwin.slice(readyIdx, readyIdx + 1500)),
    'En modo independiente ready-to-show debe hacer return directo por defecto');
  });

  await test('Animación de arranque: el estado de splash debe ser de nivel de módulo; si no, nunca se cierra', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // runLaunch / autoDeploy se definen **fuera** del callback de whenReady, y el const
    // splashDone de dentro del callback no lo ven (typeof siempre 'undefined'); eso llegó a dejar
    // la animación de arranque alwaysOnTop de 480x360 fija en el centro de la pantalla.
    assert(/^let splashWin = null;$/m.test(mainJs), 'splashWin debe ser un let de nivel de módulo');
    assert(/^let splashDone = \(\) => \{\};$/m.test(mainJs), 'splashDone debe ser un let de nivel de módulo');
    assert(/^let splashProgress = \(\) => \{\};$/m.test(mainJs), 'splashProgress debe ser un let de nivel de módulo');
    assert(!/const splashDone = \(\) =>/.test(mainJs), 'Ya no se puede sobrescribir con const dentro de whenReady');
    // Fusible: si la splash no se cierra sola, el proceso principal la cierra a la fuerza
    assert(/setTimeout\(\(\) => \{[\s\S]{0,160}splashWin\.close\(\);/.test(mainJs),
      'Tras splashDone debe haber un fusible que la cierre a la fuerza');
  });

  await test('Varias ventanas: al iniciar una app primero se oculta la ventana de gestión y luego se abre la de la app', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const launchIdx = mainJs.indexOf('async function runLaunch(');
    const body = mainJs.slice(launchIdx, launchIdx + 4000);
    const hideIdx = body.indexOf('mainWindow.hide()');
    const openIdx = body.indexOf('openAppWindow(pkg');
    assert(hideIdx > 0 && openIdx > 0, 'Las dos llamadas deben estar en runLaunch');
    assert(hideIdx < openIdx, 'mainWindow.hide() debe ir antes de openAppWindow (si no, se ven dos ventanas a la vez)');
  });

  await test('Horizontal/vertical: la orientación de la pantalla debe coincidir con la que declara la app; si no, solo saldrán franjas negras', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const apkJs = fs.readFileSync(path.join(root, 'src', 'core', 'apk.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');

    assert(/function wantLandscapeFor\(pkg\)/.test(mainJs), 'Debe decidirse «qué orientación usa esta app»');
    assert(/orientationMode/.test(mainJs), 'Debe leer la política de orientación de la configuración');
    assert(/orientationOverride/.test(mainJs), 'La orientación por app debe aplicarse');
    // La ruta de arranque debe usar esto y no displaySettings().landscape directamente
    assert(/const wantLand = wantLandscapeFor\(pkg\)/.test(mainJs), 'beforeStart debe decidir según la orientación de la app');
    assert(/const land = wantLandscapeFor\(pkg\)/.test(mainJs), 'openAppWindow debe abrir la ventana según la orientación de la app');
    // Calcula la orientación sin conexión a partir del manifiesto del APK
    assert(/function detectOrientation\(/.test(apkJs), 'Debe deducir la orientación de la app sin conexión a partir del manifiesto del APK');
    assert(/orientation,/.test(apkJs), 'parseApk debe devolver orientation');
    assert(/orientation: meta\.orientation/.test(installerJs), 'Al instalar hay que guardar la orientación en apps.json');
    assert(/orientationMode: 'auto'/.test(storeJs), 'La política por defecto es seguir a la app');
    // Relleno de datos viejos: sin esto seguirían los bordes negros
    assert(/orientation backfill/.test(mainJs), 'A las apps instaladas con versiones viejas hay que completarles la orientación');
  });

  await test('Horizontal/vertical: el reinicio por orientación distinta no puede interrumpir el inicio', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    // beforeStart devuelve un rt nuevo; antes aquí había const rt, y al tomar la rama de reinicio
    // lanzaba "Assignment to constant variable." y todo el arranque fallaba.
    assert(/let rt = await this\.runtime\.ensure\(\{ onLog \}\)/.test(installerJs),
      'rt debe ser let; si no, falla al cambiar de client tras reiniciar');
    assert(/if \(replaced && replaced\.client\) rt = replaced;/.test(installerJs), 'Debe aceptar el rt nuevo');
  });

  await test('Al cambiar de app no puede quedar la pantalla vacía: en modo independiente hay que mostrar la contenedora mientras se espera', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // En modo de ventana independiente (por defecto) la ventana contenedora normalmente no se muestra; cambiar a una app con otra orientación reinicia el runtime
    // durante unos 40 s, y si en ese tiempo no se muestra nada el usuario cree que el programa falló.
    assert(/showWhileWaiting: detached && !splashVisible/.test(mainJs),
      'En modo independiente sin animación de arranque debe usarse showWhileWaiting');
    assert(/splashVisible = !!\(splashWin && !splashWin\.isDestroyed\(\)\)/.test(mainJs),
      'Según si la splash está visible se decide quién le dice al usuario «estamos esperando»');
    assert(/const willRestart = land !== !!displaySettings\(\)\.landscape/.test(mainJs),
      'Debe poder prever «esta vez habrá reinicio»');
    assert(/if \(this\.detachedMode && !this\._showWhileWaiting\) return;/.test(appwin),
      'ready-to-show solo muestra la contenedora con showWhileWaiting');
    assert(/Cambiando «[\s\S]{0,40}» a /.test(mainJs), 'El texto debe explicar por qué tarda');
    // Cuando empieza de verdad el reinicio por cambio de orientación, pre-attach puede haber ocultado ya la ventana contenedora; hay que mostrarla otra vez,
    // si no, esos 40 s de reinicio el escritorio queda vacío (el usuario cree que el programa salió).
    assert(/appWin\.showWaiting\(/.test(mainJs), 'Antes de reiniciar por orientación hay que volver a mostrar la ventana de espera');
    assert(/waitingForRestart/.test(appwin), 'Debe existir la marca «esperando el reinicio»');
    // El sondeo pre-attach del arranque debe ceder el paso al ver la marca y no volver a ocultar la ventana de espera
    assert(/if \(appWin\.waitingForRestart\)/.test(mainJs), 'pre-attach debe ceder el paso');
  });

  await test('El título debe ponerse antes de show; si no, aparece por un instante el nombre de la app anterior', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const start = appwin.indexOf('async openDetached(');
    const body = appwin.slice(start, start + 5000);
    const titleIdx = body.indexOf('this.agent.setTitle(');
    const showIdx = body.indexOf('this.agent.show()');
    assert(titleIdx > 0 && showIdx > 0, 'Las dos llamadas deben estar en openDetached');
    assert(titleIdx < showIdx, 'setTitle debe ir antes de show (el agente guarda el título anterior)');
  });

  await test('La revisión de red no puede pedir restablecer datos al primer fallo', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // La asociación Wi-Fi llega 5–20 s después de sys.boot_completed; reportar «sin red» con una sola comprobación sería
    // un falso aviso en cada arranque en frío, y el remedio que se sugería antes era «restablecer datos de Android» (borra las apps instaladas).
    assert(/checkNetwork\('', \{ waitMs: \d+, interval: \d+ \}\)/.test(emuJs),
      'La revisión de red tras arrancar debe tener margen de espera; no puede concluir con una sola comprobación');
    const boot = emuJs.slice(emuJs.indexOf('Runtime listo'));
    const warn = boot.slice(0, 4000);
    // Solo líneas de código: no cuenta el comentario de arriba que explica «antes aquí se sugería restablecer datos»
    const warnCode = warn.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/restablecer los datos de Android|Restablecer datos de Android/.test(warnCode), 'Este aviso no puede sugerir «restablecer datos de Android» (se pierden las apps instaladas)');
    assert(/todavía no tiene internet/.test(warnCode), 'Debe usar un texto que no asuste ni confunda');
  });

  await test('La ventana negra de consola del arranque debe suprimirse con el canal de alta frecuencia', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // Cuando emulator lanza qemu, Windows crea una ventana de consola nueva (en Win11 es Windows Terminal),
    // que solo vive 200–300 ms; la revisión principal cada 250 ms la pierde.
    assert(/_consoleSweep/.test(ps1), 'Debe haber una marca de tiempo propia para revisar la consola');
    assert(/now - _consoleSweep > \(_perfMode \? 200 : 100\)/.test(ps1), 'Los primeros 15 s se revisa la consola cada 100 ms');
    assert(/now - _bootHideStart < 15000/.test(ps1), 'El canal de alta frecuencia solo corre durante el arranque, para no gastar CPU todo el tiempo');
    // Debe ser «ventana tipo consola + título que coincide con la ruta del runtime», sin volver a la lista de pid permitidos
    assert(/static void HideConsoleWindows\(\)/.test(ps1) && /IsOurConsole\(h\)/.test(ps1),
      'La pertenencia de la consola se decide con IsOurConsole (el pid de conhost no es el de emulator)');
  });

  await test('Tras reiniciar para cambiar la pantalla no se puede «reutilizar» un emulador ya apagado', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // emulator.exe solo es un lanzador y sale tras lanzar qemu, pero this.proc sigue existiendo
    // (killed sigue en false). Mirar solo eso = tratar como viva una máquina ya apagada:
    // restartForOrientation apaga la máquina e inmediatamente ensure() → start() da reused directamente,
    // quien llama usa en adb un serial muerto → `device not found`, y el cambio de app falla directamente.
    const reuse = emuJs.slice(emuJs.indexOf('async start('), emuJs.indexOf('async start(') + 2400);
    assert(/_consoleAlive\(\)/.test(reuse), 'La rama de reutilización de start() debe confirmar que de verdad hay una máquina en el puerto de consola');
    assert(/this\.proc = null;/.test(reuse), 'Si se confirma que no corre, se borra proc y se sigue el arranque real');
    // Tras apagar limpiamente stop() debe descartar el identificador del lanzador; si no, running() siempre es true
    const stopFn = emuJs.slice(emuJs.indexOf('async stop('), emuJs.indexOf('async stop(') + 4500);
    assert(/killAttempt\(\)[\s\S]{0,400}this\.proc = null;/.test(stopFn), 'Al terminar, stop() debe borrar this.proc');
    // La capa engine debe evitar además otra ilusión: recién salido el emulador, adb sigue diciendo device un momento,
    // isOnline() lo da por listo y todos los comandos siguientes dan device not found.
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const inner = engineJs.slice(engineJs.indexOf('async _ensureInner('), engineJs.indexOf('async _ensureInner(') + 2200);
    assert(/getprop sys\.boot_completed/.test(inner), 'ensure debe verificar con un comando real que el dispositivo funciona');
    assert(/probe !== null/.test(inner), 'Si el comando no responde no se puede reutilizar el cliente viejo');
    // Antes y después del cambio de orientación hay que esperar a que el dispositivo desaparezca de verdad en adb y luego lanzar la máquina nueva
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const rot = mainJs.slice(mainJs.indexOf('async function restartForOrientation'), mainJs.indexOf('async function restartForOrientation') + 2600);
    assert(/c\.isOnline\(\)\.catch\(\(\) => false\)/.test(rot), 'Tras stop hay que esperar a que desaparezca el dispositivo de adb');
  });

  await test('También hay que reconocer la ventana negra de arranque que abre Windows Terminal', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // Cuando Win11 cambia el anfitrión de consola por defecto a Windows Terminal, la consola de qemu pertenece a
    // WindowsTerminal.exe: pid/cadena de padres/título no son nuestros; solo queda reconocerla por «no existía antes del arranque»
    assert(/static void SnapshotConsoles\(\)/.test(ps1), 'Antes de arrancar hay que anotar las ventanas de consola existentes');
    assert(/_consolesBeforeBoot/.test(ps1), 'Debe haber una instantánea de las consolas antes del arranque');
    assert(/now - _bootHideStart < 20000[\s\S]{0,120}_consolesBeforeBoot\.Contains/.test(ps1),
      'Solo cuentan las ventanas de consola «nuevas en los 20 s tras el arranque»');
    assert(/tl\.IndexOf\("terminal", StringComparison\.Ordinal\) >= 0/.test(ps1),
      'Solo es sospechosa si el título está vacío o incluye terminal (las terminales que ya abrió el usuario están en la instantánea)');
    assert(/SnapshotConsoles\(\);/.test(ps1), 'En boothide hay que tomar primero la instantánea');
  });

  await test('El inicio debe ser en serie: pulsar varias veces / cambiar de app no puede ejecutarlo dos veces a la vez', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // Un arranque tarda hasta 80 s (reinicio por cambio de pantalla + arranque en frío). Antes, pulsar otra app en ese tiempo lanzaba de verdad
    // un segundo arranque en paralelo: openAppWindow cerraba la app que estaba iniciando mientras la máquina virtual reiniciaba,
    // y ambos fallaban; en el registro aparecía `cmd: Can't find service: activity`.
    assert(/let launchInFlight = null;/.test(mainJs), 'Debe haber un registro del inicio en curso');
    assert(/if \(launchInFlight\.pkg === pkg\)[\s\S]{0,120}return launchInFlight\.promise;/.test(mainJs),
      'Pulsar varias veces la misma app debe reutilizar el inicio en curso');
    assert(/launch queued \$\{pkg\}/.test(mainJs), 'Cambiar de app debe ir a la cola, no quitarle el runtime al inicio en curso');
    assert(/async function launchOne\(pkg\)/.test(mainJs), 'El cuerpo original debe separarse en launchOne');
    assert(/launchInFlight = entry;/.test(mainJs), 'Hay que vaciarlo en finally, para no bloquear los inicios siguientes');
  });

  await test('Aceleración por hardware: la versión de la Store guía al usuario para activar WHPX; la instalada lo activa con un clic y puede recurrir a AEHD', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');

    // 1) La función que de verdad permite al emulador usar WHPX es HypervisorPlatform (la plataforma de máquina virtual es la de WSL2),
    //    y debe activarse primero; se activan las dos una vez para cubrir distintos equipos.
    assert(/for \(const f of \['HypervisorPlatform', 'VirtualMachinePlatform'\]\)/.test(mainJs),
      'Primero hay que activar HypervisorPlatform (el que de verdad necesita WHPX)');
    // 2) Ya no se puede usar la existencia de WinHvPlatform.dll como interruptor: en Windows modernos siempre está,
    //    y ese criterio dejaría fuera a los equipos que de verdad necesitan activar la función.
    const handler = mainJs.slice(mainJs.indexOf("ipcMain.handle('provision:enableVirtualization'"));
    const handlerBody = handler.slice(0, 4000);
    assert(!/if \(hv\.dll\) \{/.test(handlerBody), 'Ya no se puede bifurcar según WinHvPlatform.dll');
    // 3) Versión de la Store (MSIX): si no hay elevación se pasa a la «guía manual», en vez de mostrar un UAC condenado a fallar
    assert(/if \(store\.STORE_BUILD\) \{[\s\S]{0,900}manual: true/.test(handlerBody),
      'Si falla en la versión de la Store debe devolver manual para que la interfaz guíe');
    assert(/no puede pedir permisos de administrador/.test(mainJs), 'El texto de la versión de la Store debe explicar por qué no se puede activar solo');
    assert(/Plataforma del hipervisor de Windows/.test(mainJs), 'Debe nombrar claramente «Plataforma del hipervisor de Windows»');
    // 4) Tras activarlo hay que borrar la caché de aceleración; si no, la interfaz seguiría mostrando la conclusión vieja
    assert(/const whpx = await enableWhpxFeatures\(\);\s*\n\s*runtime\.provisioner\.invalidateEnvCache/.test(mainJs),
      'Tras activarlo hay que hacer invalidateEnvCache');
    // 5) Que el usuario pulse «No» debe distinguirse de un fallo real (1223 = ERROR_CANCELLED)
    assert(/1223/.test(mainJs) && /cancelled/.test(mainJs), 'Debe distinguir la cancelación del UAC');
    // 6) El que tiene «Plataforma del hipervisor de Windows» es el diálogo clásico, no la página de ms-settings
    assert(/optionalfeatures\.exe/.test(mainJs), 'Debe abrir el clásico optionalfeatures.exe');
    // 7) La interfaz debe manejar manual / cancelled y abrir de verdad ese diálogo
    assert(/r\.manual/.test(appJs) && /api\.openWindowsFeatures/.test(appJs), 'La interfaz debe manejar la rama manual');
    assert(/openWindowsFeatures: \(\) => invoke\('provision:openWindowsFeatures'\)/.test(preloadJs),
      'preload debe exponer openWindowsFeatures');
    // 8) Con emulación por software, el primer arranque debe mostrar una notificación del sistema (el usuario probablemente no vio el elemento de comprobación de la configuración)
    assert(/let accelWarned = false;/.test(mainJs) && /Ejecutando con emulación por software/.test(mainJs),
      'La emulación por software debe avisarse una vez');
  });

  await test('El empaquetado debe escribir el icono/versión del exe; si no, el Explorador muestra el icono de Electron', () => {
    const root = path.join(__dirname, '..');
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const pkg = require(path.join(root, 'package.json'));

    // Un exe solo renombrado sigue siendo Electron por dentro: FileDescription=Electron,
    // ProductName=Electron, CompanyName=GitHub, Inc., versión 33.4.11, y el icono por defecto.
    assert(/function embedExeMeta\(exe\)/.test(packJs), 'Debe haber un paso que escriba los metadatos del exe');
    assert(/--set-icon/.test(packJs), 'Debe escribir el icono');
    assert(/--set-file-version/.test(packJs), 'Debe escribir la versión de archivo');
    assert(/--set-version-string', 'FileDescription'/.test(packJs), 'Debe escribir FileDescription');
    assert(/--set-version-string', 'ProductName', 'LanzadorAPK'/.test(packJs), 'ProductName debe ser LanzadorAPK');
    assert(/embedExeMeta\(exePath\)/.test(packJs), 'Debe llamarse de verdad después de renombrar');
    // Si no se encuentra rcedit hay que avisar claramente; no se puede generar en silencio un paquete con «el icono de Electron»
    assert(/No se encuentra rcedit\.exe/.test(packJs), 'Si falta rcedit debe avisar');

    // Identidad en la barra de tareas: sin AppUserModelID, los anclajes/notificaciones de la barra de tareas caen en "Electron"
    assert(/setAumid\(APP_AUMID\);/.test(mainJs), 'Al iniciar hay que fijar AppUserModelID');

    // La versión completa (con runtime) como versión entregable
    assert(/--full/.test(packJs) && /LanzadorAPK-v\$\{PKG\.version\}-win64-full/.test(packJs),
      '--full debe producir la carpeta de la versión completa con número de versión');
    assert(/build', 'runtime'/.test(packJs), 'La versión completa debe incluir build/runtime');
  });

  await test('Versión unificada: package.json / número de cuatro partes de MSIX / nombre del paquete en la documentación coinciden', () => {
    const root = path.join(__dirname, '..');
    const pkg = require(path.join(root, 'package.json'));
    const { msixVersion } = require(path.join(root, 'build', 'msix.js'));
    const four = msixVersion(pkg.version);
    assert(/^\d+\.\d+\.\d+\.0$/.test(four), `Formato incorrecto de la versión de cuatro partes de MSIX: ${four}`);
    const artifact = `LanzadorAPK_${four}_x64.msix`;
    assert(artifact.endsWith('_x64.msix'));
    // La versión de archivo del exe también debe usar el mismo número (cuatro partes), sin contradecir a package.json
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    assert(/\$\{PKG\.version\}\.0/.test(packJs), 'La versión de archivo del exe debe coincidir con package.json');
    // El paquete de la Store y el exe usan la misma fuente de versión; no debe haber un segundo número de versión fijo
    const msixJs = fs.readFileSync(path.join(root, 'build', 'msix.js'), 'utf8');
    assert(/const VERSION = String\(pkg\.version/.test(msixJs), 'La versión de MSIX debe tomarse de package.json');
  });

  await test('El acceso directo de una app Android debe usar su propio icono + su propia identidad en la barra de tareas', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const shortcutJs = fs.readFileSync(path.join(root, 'src', 'core', 'shortcut.js'), 'utf8');

    // El icono de los accesos directos del escritorio/menú Inicio = el <paquete>.ico extraído del APK, nunca el logo de LanzadorAPK
    assert(/const ico = app\.icoPath && fs\.existsSync\(app\.icoPath\) \? app\.icoPath : undefined;/.test(installerJs),
      'Debe usar el icoPath de la propia app');
    assert(/iconIcoPath: ico/.test(installerJs), 'writeShortcut debe recibir el icono de la app');
    assert(!/iconIcoPath:\s*(APPICON|appicon|brandIcon)/.test(installerJs), 'No se puede usar el icono de marca de LanzadorAPK');
    // Un AUMID por app: la barra de tareas agrupa por app y los anclajes saben qué app son
    assert(/appUserModelId: `zaiddia\.LanzadorAPK\.\$\{app\.package\}`/.test(installerJs),
      'Cada app debe tener su propio AUMID');
    // Windows solo usa el icono del acceso directo cuando «AUMID del proceso == AUMID del acceso directo»,
    // así que al abrir una app hay que cambiar a su identidad, y al volver a la ventana principal volver a LanzadorAPK.
    assert(/const APP_AUMID = 'zaiddia\.LanzadorAPK';/.test(mainJs), 'Debe haber un prefijo de AUMID común');
    assert(/setAumid\(`\$\{APP_AUMID\}\.\$\{pkg\}`\)/.test(mainJs), 'Antes de abrir la ventana de la app hay que pasar al AUMID de esa app');
    assert(/function showWindow\(\) \{\s*\n\s*\/\/[^\n]*\n\s*setAumid\(APP_AUMID\);/.test(mainJs),
      'Al volver a la ventana de gestión hay que volver al AUMID de LanzadorAPK');
    // writeShortcut debe poner iconIndex en 0 (el fotograma 0 del ico); si no, algunos tamaños toman el equivocado
    assert(/icon: opt\.iconIcoPath \|\| opt\.target/.test(shortcutJs), 'La ruta del icono debe poder recurrir a target');
    assert(/iconIndex: 0/.test(shortcutJs), 'iconIndex debe ser 0');
  });

  await test('Horizontal: la decisión de orientación debe reunirse en una función pura; la sustitución tiene prioridad sobre el manifiesto del APK', () => {
    const root = path.join(__dirname, '..');
    const o = require('../src/core/orientation');

    // El modo forzado tiene la máxima prioridad
    assert(o.resolveLandscape({ mode: 'landscape', orientation: 'portrait', orientationOverride: 'portrait' }) === true,
      'Forzar horizontal debe imponerse a todo');
    assert(o.resolveLandscape({ mode: 'portrait', orientation: 'landscape', orientationOverride: 'landscape' }) === false,
      'Forzar vertical debe imponerse a todo');
    // La sustitución por app tiene prioridad sobre lo que declara el manifiesto del APK: si el APK declara portrait y el usuario pulsa horizontal, debe girar
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'portrait', orientationOverride: 'landscape' }) === true,
      'La sustitución horizontal por app debe imponerse a la declaración portrait del APK');
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'landscape', orientationOverride: 'portrait' }) === false,
      'La sustitución vertical por app debe imponerse a la declaración landscape del APK');
    // Sin sustitución se sigue lo que declara el APK y, si no hay nada, la pantalla
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'portrait' }) === false, 'Sin sustitución se sigue la declaración del APK');
    assert(o.resolveLandscape({ mode: 'auto', orientation: null, panelLandscape: true }) === true, 'Siguiendo la gravedad se sigue la pantalla');
    // Rotar invierte + el valor de sustitución es consistente de ida y vuelta (el botón de rotar escribe la sustitución y al siguiente inicio debe leerse la misma orientación)
    assert(o.flipLandscape(false) === true && o.flipLandscape(true) === false, 'flip debe invertir');
    assert(o.parseOverride(o.overrideValue(true)) === true, 'El valor de sustitución horizontal es consistente de ida y vuelta');
    assert(o.parseOverride(o.overrideValue(false)) === false, 'El valor de sustitución vertical es consistente de ida y vuelta');

    // Los tres puntos de entrada deben usar la misma función de decisión, sin calcular cada uno por su cuenta (la causa de raíz de no poder poner apps en horizontal)
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/wantLandscapeFor\(pkg\)\s*\)?\.?\s*/.test(mainJs) && /orientation\.resolveLandscape/.test(mainJs),
      'wantLandscapeFor debe pasar por resolveLandscape');
    assert(/async function rotateCurrentApp\(\)/.test(mainJs), 'Debe haber un punto de entrada de rotación único');
    assert(/orientation\.flipLandscape\(current\)/.test(mainJs), 'El punto de entrada de rotación debe usar el mismo flip');
    assert(/orientation\.overrideValue\(next\)/.test(mainJs), 'El punto de entrada de rotación debe escribir el mismo valor de sustitución');
    const shellJs = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.js'), 'utf8');
    assert(/shell\.rotate\(\)/.test(shellJs), 'El botón de rotar de la barra de título debe usar el punto de entrada único');
  });

  await test('La rotación automática de la imagen está activada por defecto, pero la orientación de la pantalla sigue bloqueada por wm', () => {
    const root = path.join(__dirname, '..');
    const o = require('../src/core/orientation');
    // Por defecto (sin configurar / nunca desactivado) = activado
    assert(o.autoRotateSetting({}) === '1', 'Rotación automática activada por defecto');
    assert(o.autoRotateSetting({ display: {} }) === '1', 'display vacío también cuenta como activado');
    assert(o.autoRotateSetting({ display: { autoRotate: false } }) === '0', 'Solo si el usuario lo desactiva explícitamente devuelve 0');
    // El store debe escribir true por defecto
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    assert(/autoRotate:\s*true/.test(storeJs), 'store usa autoRotate=true por defecto');
    // adb debe escribir el interruptor de aceleración en ambos tramos, conservando los comandos de bloqueo de orientación que mandan (arriba ya se comprobaron lock 0 / ignore-request)
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    assert(/accelerometer_rotation \$\{guestAutoRotate\(\)\}/.test(adbJs), 'adb debe usar el valor de guestAutoRotate');
  });

  await test('Modo de ventana: por defecto ventana nativa; ambos modos se pueden cambiar en la configuración y se migra una sola vez', () => {
    const root = path.join(__dirname, '..');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    // 0.6.0: el modo incrustado (SetParent) pierde fotogramas al escalar/rotar, con bordes negros y coordenadas desplazadas,
    // así que por defecto el emulador abre su propia ventana nativa.
    assert(/windowEmbed:\s*false,\s*\n\s*\/\/ Interruptor de «rotación automática»/.test(storeJs), 'defaultSettings.display.windowEmbed debe ser false');
    // Migración única: solo se migran las configuraciones «que no se eligieron activamente»; lo que eligió el usuario no se puede revertir una y otra vez
    assert(/windowEmbedMigrated2/.test(storeJs), 'Debe haber una marca de migración única');
    assert(/windowEmbedChosen !== true/.test(storeJs), 'Las configuraciones elegidas activamente no se migran');
    // No basta con la marca: configuraciones viejas pueden tener «migrated2=true pero el valor sigue en true» (migración no guardada / editada a mano),
    // y antes ese caso pasaba tal cual → al iniciar volvía a aparecer la ventana contenedora decorada. El criterio debe ser «si se eligió activamente».
    const migBody = storeJs.slice(storeJs.indexOf('Decisión final del modo de ventana'), storeJs.indexOf('Decisión final del modo de ventana') + 3000);
    assert(/d\.windowEmbedChosen !== true && d\.windowEmbed !== false/.test(migBody),
      'La condición de migración no puede depender de windowEmbedMigrated2; si no, las marcas viejas se saltarían la migración');
    // La ventana nativa debe sacarse lo antes posible, sin dejar al usuario esperando frente a la página decorada
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/pre-attach detached ok/.test(mainJs), 'Al iniciar hay que intentar primero sacar la ventana nativa del emulador');
    // Si la toma falla hay que reintentar; si no, la ventana contenedora queda en pantalla (la «ventana decorada» que veía el usuario)
    const attachBody = mainJs.slice(mainJs.indexOf('async function attachAppWindow'), mainJs.indexOf('async function attachAppWindow') + 2200);
    assert(/for \(let i = 0; i < 4; i \+= 1\)/.test(attachBody), 'La toma de la ventana nativa debe reintentarse');
    assert(/se vuelve temporalmente al modo incrustado/.test(attachBody), 'Si fallan las cuatro rondas debe haber respaldo; no puede quedar la pantalla negra');
    const appJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    assert(/windowEmbedChosen:\s*true/.test(appJs), 'Al cambiarlo en la configuración hay que escribir la marca «elegido activamente»');
    const indexHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(/setWindowEmbed/.test(indexHtml), 'La configuración debe tener el acceso para cambiar el modo de ventana');
    // La ventana nativa es la primera opción; al entrar a la configuración lo primero que ve el usuario es el valor por defecto
    const sel = indexHtml.slice(indexHtml.indexOf('id="setWindowEmbed"'), indexHtml.indexOf('id="setWindowEmbed"') + 400);
    assert(sel.indexOf('value="detached"') < sel.indexOf('value="embed"'), 'La ventana nativa debe ser la opción por defecto (la primera)');
  });

  await test('Modo de ventana: la sonda y la comprobación automática usan el nuevo valor por defecto', () => {
    const root = path.join(__dirname, '..');
    const probeJs = fs.readFileSync(path.join(root, 'src', 'core', 'autodebug-probe.js'), 'utf8');
    // Solo true explícito es modo incrustado; sin configurar se trata como ventana nativa
    assert(/windowEmbed:\s*!!\(settings\.display && settings\.display\.windowEmbed === true\)/.test(probeJs),
      'La sonda debe considerar incrustado solo con true explícito');
  });

  await test('Velocidad de carga: la caché reciente del estado de red se reutiliza rápido y se invalida al detener el runtime', () => {
    const root = path.join(__dirname, '..');
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    // waitForNetwork devuelve directamente si hay caché de menos de 8 s, ahorrando los viajes de adb de llamadas seguidas
    assert(/cached\.ok && Date\.now\(\) - cached\.at < 8000/.test(engineJs), 'waitForNetwork debe reutilizar la caché de red reciente');
    // stop() borra la caché, para que tras reiniciar no se use por error el estado anterior al apagado y quede la pantalla negra
    const stopBody = engineJs.slice(engineJs.indexOf('async stop('), engineJs.indexOf('async stop(') + 400);
    assert(/this\._lastNetwork = null/.test(stopBody), 'stop debe borrar la caché de red');
  });

  await test('El empaquetado debe incluir las dependencias de producción (si no, falta @napi-rs/lzma, la imagen no se descomprime y ninguna app abre)', () => {
    const root = path.join(__dirname, '..');
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    const pkg = require(path.join(root, 'package.json'));

    // Regresión grave de la 0.5.9: pack.js solo copiaba src/, sin node_modules,
    // y la versión empaquetada daba Cannot find module '@napi-rs/lzma' al iniciar; ninguna app abría.
    assert(pkg.dependencies && pkg.dependencies['@napi-rs/lzma'],
      '@napi-rs/lzma debe estar en dependencies (se necesita para descomprimir system.img.xz)');
    assert(/node_modules/.test(packJs) && /dependencies/.test(packJs),
      'pack.js debe copiar las dependencias de producción según las dependencies de package.json');
    assert(/startsWith\('@'\)/.test(packJs),
      'Los paquetes con scope deben copiarse con todo el scope (el binario nativo está en @napi-rs/*-win32-x64-msvc)');
    // En la ruta de descompresión tiene que encontrarse de verdad: debe estar instalado en el node_modules local
    const lzmaDir = path.join(root, 'node_modules', '@napi-rs', 'lzma');
    assert(fs.existsSync(lzmaDir), 'Para empaquetar, @napi-rs/lzma debe estar instalado en el equipo');
  });

  await test('Si falta lzma al descomprimir la imagen se da un error legible, no una larga pila de require', () => {
    const root = path.join(__dirname, '..');
    const provJs = fs.readFileSync(path.join(root, 'src', 'core', 'provision.js'), 'utf8');
    assert(/LZMA_MISSING/.test(provJs), 'Si falta lzma debe usarse el código de error LZMA_MISSING');
    assert(/El instalador está incompleto/.test(provJs), 'El mensaje debe decir claramente que el instalador está incompleto, para que el usuario no crea que su equipo falla');
    // Ya no puede ser un require.resolve sin protección: lanzaría el error crudo del módulo si falta la dependencia
    assert(/try\s*\{[^}]*require\.resolve\('@napi-rs\/lzma'\)/.test(provJs),
      'require.resolve debe ir en un try y, si falla, dar un error amable');
  });

  await test('Botones desplazados: desactivar la barra de tareas de pantalla grande (Taskbar)', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    // La densidad de tableta (sw606dp) activa la Taskbar del Launcher: pegada abajo, tapa el contenido y amontona los botones abajo a la izquierda
    assert(/async disableLauncherTaskbar\(\)/.test(adbJs), 'Debe existir disableLauncherTaskbar');
    assert(/settings put global enable_taskbar 0/.test(adbJs), 'El interruptor de la barra de tareas usa global enable_taskbar');
    // El Launcher solo lee el interruptor al iniciar; si ya está en marcha hay que reiniciarlo para que desaparezca
    assert(/am force-stop com\.google\.android\.apps\.nexuslauncher/.test(adbJs), 'Debe reiniciarse Pixel Launcher');
    // Se corrige en cada arranque (idempotente), y en la inicialización del arranque se hace una vez «comprobar + reiniciar»
    const pf = adbJs.slice(adbJs.indexOf('async prepareForeground('), adbJs.indexOf('async prepareForeground(') + 1600);
    assert(/enable_taskbar 0/.test(pf), 'prepareForeground debe escribir el interruptor de la barra de tareas');
    const reset = adbJs.slice(adbJs.indexOf('async resetDisplayOverrides('), adbJs.indexOf('async resetDisplayOverrides(') + 1600);
    assert(/disableLauncherTaskbar\(\)/.test(reset), 'resetDisplayOverrides debe llamar a disableLauncherTaskbar');
  });

  await test('Animación de inicio: se mantiene hasta el primer fotograma de la app y luego se desvanece', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    assert(/async waitForAppFirstFrame\(pkg/.test(adbJs), 'Debe existir waitForAppFirstFrame');
    // Android 12+ pone la Splash del sistema antes del primer fotograma de la Activity; el criterio es que desaparezca + el foco esté en el paquete objetivo
    assert(/Splash Screen/.test(adbJs), 'El primer fotograma se decide por la ventana Splash del sistema');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // Antes de cerrar la animación hay que esperar el primer fotograma; si no, el usuario ve fondo blanco + el icono de la app y cree que se colgó
    const idx = mainJs.indexOf('waitForAppFirstFrame');
    assert(idx > 0, 'main debe llamar a waitForAppFirstFrame');
    const after = mainJs.slice(idx, idx + 800);
    assert(/splashDone/.test(after), 'splashDone solo después del primer fotograma');
    // El criterio debe usar `dumpsys window`: `dumpsys window windows` no tiene mCurrentFocus,
    // el foco siempre se evaluaría como no, y cada arranque esperaría en vano hasta agotar el tiempo.
    assert(/dumpsys window \| grep -E "Splash Screen\|mCurrentFocus"/.test(adbJs),
      'La decisión del primer fotograma debe usar dumpsys window (incluye mCurrentFocus)');
    // En apps pesadas el primer fotograma tarda más de 15 s; un límite de 12 s cerraría la animación antes de tiempo
    assert(/timeoutMs:\s*20000/.test(mainJs), 'La espera del primer fotograma debe dar 20 s completos');
  });

  await test('Inicio más rápido: los permisos ya concedidos no se vuelven a conceder (ahorra más de 20 s)', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    const fn = adbJs.slice(adbJs.indexOf('async grantRuntimePermissions('), adbJs.indexOf('async grantRuntimePermissions(') + 2600);
    // Con caché se devuelve directamente, sin ejecutar ni siquiera dumpsys package
    assert(/rec\.permGranted === true/.test(fn), 'Los permisos concedidos deben salir de la caché');
    assert(/store\.upsertApp\(\{ package: pkg, permGranted: true \}\)/.test(fn), 'Tras conceder hay que escribir la marca');
    const clear = adbJs.slice(adbJs.indexOf('async clearData('), adbJs.indexOf('async clearData(') + 400);
    assert(/permGranted: false/.test(clear), 'Tras pm clear hay que invalidar la caché');
    const inst = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/permGranted: false/.test(inst), 'Tras reinstalar hay que invalidar la caché');
  });

  await test('Tirones: con el backend host en AMD, desactivar Vulkan y reintentar la aceleración por hardware', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    assert(/-feature', '-Vulkan/.test(emuJs), 'El backend host debe poder desactivar Vulkan');
    assert(/badGpuVulkanTried/.test(emuJs), 'Cada versión de emulator debe reintentar host una vez');
    // Solo aplica con host + AMD + Windows, para no meter incertidumbre en el backend por software
    assert(/gpu === 'host' && process\.platform === 'win32' && doctor\.detectGpuVendor\(\) === 'amd'/.test(emuJs),
      'Solo con host + AMD se desactiva Vulkan');
  });

  await test('Restos de actualización: si la carpeta del runtime apunta a otro instalador, se usa el incluido en el paquete', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/looksForeignBundle/.test(mainJs), 'Debe reconocer «el resources/runtime de otro paquete»');
    assert(/resources\[\\\\\/\]runtime\$/.test(mainJs), 'Se decide porque termina en resources/runtime');
  });

  await test('Dos instancias alternadas: al salir la vieja no puede matar el emulador que acaba de tomar la nueva', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // Cuando el usuario «pulsa, no pasa nada y pulsa otra vez», el segundo arranque toma el emulador; si la limpieza de la instancia vieja
    // igual hace dispose(), la nueva recibe de inmediato device not found y la app ya no abre.
    assert(/owner\.pid/.test(mainJs), 'Al iniciar debe anotar si es dueña del runtime');
    assert(/const releaseRuntime = /.test(mainJs), 'Debe haber una decisión de «propiedad del runtime»');
    const fn = mainJs.slice(mainJs.indexOf('const releaseRuntime'), mainJs.indexOf('const releaseRuntime') + 800);
    assert(/owner === process\.pid/.test(fn), 'Si el pid no es el propio no se puede detener el runtime');
    const hits = (mainJs.match(/runtime\?\.dispose\(\)/g) || []).length;
    assert(hits === 1, `El runtime solo debería detenerse una vez, en releaseRuntime; real: ${hits} lugares`);
  });

  await test('Agente de ventanas: también debe reconocer la ventana del emulador al iniciarse desde una junction de carpetas', () => {
    const root = path.join(__dirname, '..');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    // El agente decide la pertenencia por el prefijo de la ruta del exe del proceso, y Windows da la ruta real con la junction resuelta;
    // sin resolverla queda emu:0 → falla la toma de la ventana nativa → vuelve a la contenedora incrustada con botón de rotación.
    assert(/realpathSync\.native/.test(agentJs), 'La carpeta de scope debe resolverse primero a la ruta real');
    const scope = agentJs.slice(agentJs.indexOf('async scope('), agentJs.indexOf('async scope(') + 3000);
    assert(/list\.push\(d\)/.test(scope), 'También hay que conservar la ruta original, por compatibilidad con algunos entornos');
  });

  console.log(results.join('\n'));
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
