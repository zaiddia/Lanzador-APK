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
  console.log('\nLanzadorAPK 运行时自检');
  console.log(`设备：${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[组件]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb 可用', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('未安装 adb，请先运行「一键部署」');
    return `v${env.adb.version}`;
  });
  await step('Android Emulator 就绪', async () => {
    if (!env.emulator.ok) throw new Error('未安装运行时引擎，请先运行「一键部署」');
    return `v${env.emulator.version}`;
  });
  await step('系统镜像完整', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || '镜像缺失');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)}GB`;
  });
  record('硬件加速', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : '自动回退软件模拟（能跑，但明显慢）');

  console.log('\n[设备]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('运行时已就绪', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`外部设备不在线：${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || '运行时不可用');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\n设备未就绪，后续项目跳过。');
  } else {
    await step('Android 版本', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('读不到系统版本');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('屏幕分辨率', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size 无返回');
      return `${s.width}×${s.height}`;
    });
    await step('freeform 独立窗口', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('无法开启 freeform（系统可能不支持多窗口）');
      return '已开启';
    });

    console.log('\n[共享目录]');
    await step('双向同步', async () => {
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
      if (!String(back).includes('lanzadorapk selftest')) throw new Error('本机 → 设备 未同步');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('设备 → 本机 未同步');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return '上行 + 下行均正常';
    });

    if (APK) {
      console.log('\n[应用链路]');
      let meta = null;
      await step('解析 APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('安装到设备', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path 未找到包');
          return 'pm path 校验通过';
        });
        await step('独立窗口启动', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('应用未在前台');
          return meta.package;
        });
        await step('截图', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('截图内容异常');
          return file;
        });
      }
    } else {
      console.log('\n[应用链路] 未指定 --apk，跳过');
    }
  }

  // El runtime que arranca la autocomprobación hay que detenerlo: si no, los pipes stdio del subproceso emulator
  // mantienen vivo el bucle de eventos de Node y el comando parece «colgado»
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`结果：${results.filter((r) => r.ok === true).length} 通过，${failed.length} 失败，`
    + `${results.filter((r) => r.ok === null).length} 跳过`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  · ${f.name}：${f.detail}`));
    process.exit(1);
  }
  console.log('全部检查通过 ✅\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n自检异常终止：', e.message);
  process.exit(1);
});
