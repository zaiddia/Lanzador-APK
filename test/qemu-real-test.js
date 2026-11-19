'use strict';
/**
 * Prueba de integración con QEMU real (necesita qemu-system-x86_64.exe en el equipo)
 *
 * Verifica:
 *  1. los parámetros de arranque de QEMU que genera LanzadorAPK los acepta un QEMU real y corre estable
 *  2. qemu-img puede crear discos virtuales
 *  3. saludo del monitor de QEMU (TCP) + sendkey + salida ordenada
 *
 * Ejecutar: node test/qemu-real-test.js   (sin QEMU se omite automáticamente)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

process.env.APPDATA = path.join(os.tmpdir(), `lanzadorapk-qemu-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'lanzadorapk'), { recursive: true });

const CANDIDATES = [
  'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',
  path.join(__dirname, '..', 'engine', 'qemu', 'qemu-system-x86_64.exe'),
];
const QEMU = CANDIDATES.find((c) => fs.existsSync(c));
const QEMU_IMG = QEMU && path.join(path.dirname(QEMU), 'qemu-img.exe');

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; out.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; out.push(`  ✗ ${name}\n    ${e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

(async () => {
  if (!QEMU) {
    console.log('（跳过：本机未找到 QEMU，可安装后重试：winget install SoftwareFreedomConservancy.QEMU）');
    process.exit(0);
  }
  const ver = execFileSync(QEMU, ['--version'], { encoding: 'utf8' });
  console.log(`QEMU: ${ver.split('\n')[0].trim()}\n`);

  const store = require('../src/core/store');
  const { Runtime } = require('../src/core/engine');

  const work = path.join(process.env.APPDATA, 'lanzadorapk', 'runtime', 'images');
  fs.mkdirSync(work, { recursive: true });
  const disk = path.join(work, 'test.qcow2');

  await test('qemu-img 创建虚拟磁盘', () => {
    execFileSync(QEMU_IMG, ['create', '-f', 'qcow2', disk, '2G'], { timeout: 30000 });
    assert(fs.existsSync(disk) && fs.statSync(disk).size > 0, '磁盘未创建');
  });

  await test('LanzadorAPK 启动参数被真实 QEMU 接受并稳定运行', async () => {
    store.saveSettings({
      engine: { memoryMB: 1024, cores: 2 },
      runtime: { diskPath: disk, headless: true },
    });
    const rt = new Runtime(path.join(__dirname, '..'));
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false, headless: true });

    const proc = spawn(QEMU, args, { windowsHide: true, stdio: 'ignore' });
    let exited = null;
    proc.on('exit', (c) => { exited = c; });

    await new Promise((r) => setTimeout(r, 4000));
    assert(exited === null, `QEMU 在 4s 内退出（code=${exited}），参数可能不被接受`);
    assert(!proc.killed, '进程应存活');

    await test('monitor 协议（真实 QEMU）', async () => {
      const buf = await rt.monitorCmd('info status', { timeout: 5000 });
      assert(/running|paused/i.test(buf), `monitor 响应异常: ${buf.slice(-80)}`);
      await rt.monitorCmd('sendkey ctrl-alt-delete');
    });

    await test('monitor 优雅退出', async () => {
      await rt.monitorCmd('quit');
      await new Promise((r) => setTimeout(r, 1500));
      assert(exited !== null || proc.killed, 'QEMU 应已退出');
    });
    try { proc.kill(); } catch (_) { /* ignore */ }
  });

  console.log(out.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  try { fs.rmSync(process.env.APPDATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
