'use strict';
/**
 * Autocomprobación del runtime (sin abrir la interfaz)
 *
 *   npm run selftest                 # solo revisa el runtime existente
 *   npm run selftest -- --apk a.apk  # además prueba instalar → iniciar → captura → carpeta compartida
 *
 * Uso: con Android instalado, confirma con un comando que la cadena «doble clic para instalar, ventana independiente, archivos compartidos»
 * funciona de verdad en este equipo, y si falla permite ubicar el paso exacto.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
// Vacío = ruta del producto, arranca el runtime integrado y usa un serial dinámico; solo si se indica se conecta a un dispositivo externo
const SERIAL = argOf('--serial') || '';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\nAutocomprobación del runtime de LanzadorAPK');
  console.log(`Dispositivo: ${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[Componentes]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb disponible', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('adb no está instalado; ejecuta primero «Implementación en un clic»');
    return `v${env.adb.version}`;
  });
  await step('Android Emulator listo', async () => {
    if (!env.emulator.ok) throw new Error('El motor del runtime no está instalado; ejecuta primero «Implementación en un clic»');
    return `v${env.emulator.version}`;
  });
  await step('Imagen del sistema completa', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || 'Falta la imagen');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)}GB`;
  });
  record('Aceleración por hardware', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : 'Se recurre a emulación por software (funciona, pero bastante más lento)');

  console.log('\n[Dispositivo]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('Runtime listo', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`El dispositivo externo no está en línea: ${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || 'Runtime no disponible');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\nEl dispositivo no está listo; se omiten los demás puntos.');
  } else {
    await step('Versión de Android', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('No se puede leer la versión del sistema');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('Resolución de pantalla', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size no devolvió nada');
      return `${s.width}×${s.height}`;
    });
    await step('Ventana independiente freeform', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('No se puede activar freeform (puede que el sistema no admita varias ventanas)');
      return 'Activado';
    });

    console.log('\n[Carpeta compartida]');
    await step('Sincronización en ambos sentidos', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `lanzadorapk selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('lanzadorapk selftest')) throw new Error('Equipo → dispositivo sin sincronizar');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('Dispositivo → equipo sin sincronizar');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return 'Subida + bajada correctas';
    });

    if (APK) {
      console.log('\n[Cadena de la app]');
      let meta = null;
      await step('Analizar APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('Instalar en el dispositivo', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path no encontró el paquete');
          return 'pm path verificado';
        });
        await step('Inicio en ventana independiente', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('La app no está en primer plano');
          return meta.package;
        });
        await step('Captura de pantalla', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('Contenido de la captura anómalo');
          return file;
        });
      }
    } else {
      console.log('\n[Cadena de la app] no se indicó --apk; se omite');
    }
  }

  // El runtime que arranca la autocomprobación hay que detenerlo: si no, los pipes stdio del subproceso emulator
  // mantienen vivo el bucle de eventos de Node y el comando parece «colgado»
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`Resultado: ${results.filter((r) => r.ok === true).length} correctas, ${failed.length} fallidas, `
    + `${results.filter((r) => r.ok === null).length} omitidas`);
  if (failed.length) {
    console.log('Puntos fallidos:');
    failed.forEach((f) => console.log(`  · ${f.name}: ${f.detail}`));
    process.exit(1);
  }
  console.log('Todas las comprobaciones pasaron ✅\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nLa autocomprobación terminó con error:', e.message);
  process.exit(1);
});
