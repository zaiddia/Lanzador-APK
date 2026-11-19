'use strict';
/**
 * Prueba de arranque real (se puede omitir por defecto; `npm run test:boot` para ejecutarla a mano)
 *
 * Usa una ISO Alpine virt de 61 MB con los parámetros de arranque reales del producto:
 *   crea un disco virtual qcow2 → arranca desde la unidad óptica → confirma por el puerto serie que llegó al espacio de usuario → apagado ordenado
 *
 * Objetivo: lo que más falla en la capa del motor es «los parámetros parecen correctos pero en un equipo real no arranca» (tipo de machine, accel,
 * orden de arranque, disco virtio, apagado ACPI). Aquí se fija con un QEMU real + un invitado real.
 * No necesita imagen de Android ni aceleración por hardware.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Carpeta de datos aislada: nunca escribir rutas de imágenes/discos de prueba en la configuración real del usuario
process.env.APPDATA = path.join(os.tmpdir(), `lanzadorapk-boot-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'lanzadorapk'), { recursive: true });

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { downloadParallel } = require('../src/core/download');

const ISO_URL = 'https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso';
const WORK = path.join(os.tmpdir(), 'lanzadorapk-boot');
const ISO = path.join(WORK, 'alpine-virt.iso');
const DISK = path.join(WORK, 'boot-test.qcow2');
const SERIAL = path.join(WORK, 'serial.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  ${m}`);

async function ensureIso() {
  if (fs.existsSync(ISO) && fs.statSync(ISO).size > 50 * 1024 * 1024) return;
  fs.mkdirSync(WORK, { recursive: true });
  log('Descargando la ISO Alpine virt (unos 61 MB)…');
  await downloadParallel(ISO_URL, ISO, { connections: 8, minChunk: 4 * 1024 * 1024 });
}

(async () => {
  console.log('\n[Prueba de arranque real]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const env = await runtime.provisioner.checkEnv();
  if (!env.qemu.ok) {
    console.error('  Omitida: QEMU no está instalado');
    process.exit(0);
  }
  log(`QEMU ${env.qemu.version} · ${env.qemu.path}`);

  await ensureIso();
  log(`ISO ${(fs.statSync(ISO).size / 1048576).toFixed(0)}MB`);

  // 1) crear el disco con qemu-img (verifica a la vez la cadena de herramientas createDisk del producto)
  const img = path.join(path.dirname(env.qemu.path), 'qemu-img.exe');
  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  const { execFileSync } = require('child_process');
  execFileSync(img, ['create', '-f', 'qcow2', DISK, '2G'], { windowsHide: true });
  log(`Disco virtual ${(fs.statSync(DISK).size / 1024).toFixed(0)} KB (disperso)`);

  // 2) usar los parámetros de arranque reales del producto
  runtime._hv = env.hypervisor;
  store.saveSettings({
    runtime: { isoPath: ISO, diskPath: DISK },
    engine: { memoryMB: 1024, cores: 2 },
  });
  const args = runtime.buildArgs({ install: true, headless: true });
  args.push('-serial', `file:${SERIAL}`, '-no-reboot');
  try { fs.rmSync(SERIAL, { force: true }); } catch (_) { /* ignore */ }

  log(`Arranque: ${args.filter((a) => !a.includes('=')).slice(0, 8).join(' ')} …`);
  const proc = spawn(env.qemu.path, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // 3) esperar a que el invitado llegue al espacio de usuario (el aviso de inicio de sesión en el puerto serie indica que arrancó)
  const start = Date.now();
  let booted = false;
  while (Date.now() - start < 180000) {
    if (exited) break;
    if (fs.existsSync(SERIAL)) {
      const txt = fs.readFileSync(SERIAL, 'latin1');
      if (/login:/i.test(txt)) { booted = true; break; }
    }
    await sleep(2000);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  if (!booted) {
    const tail = fs.existsSync(SERIAL) ? fs.readFileSync(SERIAL, 'latin1').slice(-600) : '(无串口输出)';
    console.error(`  ✗ Falló el arranque (${elapsed} s):\n${tail}`);
    try { proc.kill(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
  log(`✓ El invitado llegó al espacio de usuario (${elapsed} s)`);

  // 4) apagado ordenado: primero system_powerdown y, si se agota el tiempo, quit (justo lo que hace stop() en el producto)
  let graceful = false;
  try {
    await runtime.monitorCmd('system_powerdown');
    for (let i = 0; i < 20; i++) {
      if (exited) { graceful = true; break; }
      await sleep(500);
    }
    if (!exited) {
      log('El invitado no respondió al apagado ACPI; se usa quit (el producto hace el mismo respaldo)…');
      await runtime.monitorCmd('quit');
      for (let i = 0; i < 10; i++) {
        if (exited) break;
        await sleep(300);
      }
    }
  } catch (e) {
    log(`Error del monitor: ${e.message}`);
  }
  if (!exited) { try { proc.kill(); } catch (_) { /* ignore */ } }
  log(exited ? `✓ Máquina virtual apagada (${graceful ? 'apagado ACPI ordenado' : 'respaldo con quit'})` : '✗ No se pudo apagar la máquina virtual');

  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  console.log(`\nResultado: ${exited ? 'correctas' : 'fallidas'}\n`);
  process.exit(exited ? 0 : 1);
})().catch((e) => {
  console.error('  Error:', e.message);
  process.exit(1);
});
