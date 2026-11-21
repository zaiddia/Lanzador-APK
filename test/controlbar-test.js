'use strict';
/* Barra de controles flotante y botones de navegación de Android (Node puro: electron y adb simulados). */
const fs = require('fs');
const path = require('path');
const { ControlBar, placeBar, barHeight, BAR_W } = require('../src/core/controlbar');
const { AdbClient } = require('../src/core/adb');

let passed = 0;
let failed = 0;
const out = [];
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
async function test(name, fn) {
  try { await fn(); passed += 1; out.push(`  ✓ ${name}`); } catch (e) { failed += 1; out.push(`  ✗ ${name}\n    ${e.message}`); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** electron falso: una BrowserWindow que solo anota lo que se le pide */
function fakeElectron(work = { x: 0, y: 0, width: 1920, height: 1040 }) {
  const wins = [];
  class BrowserWindow {
    constructor(o) { this.o = o; this.visible = false; this.bounds = null; this.destroyed = false; this.sent = []; wins.push(this); this.webContents = { send: (ch, v) => this.sent.push([ch, v]) }; }
    setAlwaysOnTop() {}
    loadFile(f) { this.file = f; }
    on() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeUInt32LE(4242, 0); return b; }
    setBounds(b) { this.bounds = b; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
  }
  return {
    wins,
    BrowserWindow,
    screen: {
      screenToDipRect: (_w, r) => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 }),
      getDisplayMatching: () => ({ workArea: work }),
    },
  };
}

function bar(agentTrack, opts = {}) {
  const el = fakeElectron(opts.work);
  const calls = [];
  const agent = { track: async (h) => { calls.push(h); return agentTrack(); } };
  const cb = new ControlBar({ agent, enabled: opts.enabled || (() => true), preload: 'p.js', page: 'c.html', electron: el, platform: 'win32' });
  return { cb, el, calls };
}

(async () => {
  await test('placeBar: a la derecha de la ventana si cabe; si no, a la izquierda; si tampoco, encima del borde derecho', async () => {
    const work = { x: 0, y: 0, width: 1920, height: 1040 };
    const r = placeBar({ x: 600, y: 100, width: 500, height: 880 }, work);
    assert(r.side === 'right' && r.x === 1106 && r.width === BAR_W, JSON.stringify(r));
    const l = placeBar({ x: 1400, y: 100, width: 510, height: 880 }, work);
    assert(l.side === 'left' && l.x === 1400 - 6 - BAR_W, JSON.stringify(l));
    const i = placeBar({ x: 0, y: 0, width: 1920, height: 1040 }, work);
    assert(i.side === 'inside' && i.x + i.width <= 1920 && i.x >= 0, JSON.stringify(i));
  });

  await test('placeBar: nunca se sale por abajo de la pantalla', async () => {
    const work = { x: 0, y: 0, width: 1920, height: 600 };
    const r = placeBar({ x: 100, y: 500, width: 300, height: 400 }, work);
    assert(r.y + r.height <= 600 - 4 + 0.001, JSON.stringify(r));
    assert(barHeight() > 300 && barHeight() < 460, String(barHeight()));
  });

  await test('Sigue a la ventana del emulador (convierte píxeles físicos a lógicos) y se muestra sin robar el foco', async () => {
    const { cb, el, calls } = bar(() => ({ ok: true, emu: 1, x: 900, y: 150, w: 750, h: 1320, visible: true, iconic: false, fg: true }));
    assert(cb.attach('App') === true, 'attach');
    const w = el.wins[0];
    assert(w.o.focusable === false && w.o.skipTaskbar === true && w.o.alwaysOnTop === true, 'debe ser una barra que no toma el foco');
    await cb._tick();
    assert(calls[0] === 4242, `debe pasar su HWND al agente; real: ${calls[0]}`);
    assert(w.visible, 'debería mostrarse');
    assert(w.bounds && w.bounds.x === 600 + 500 + 6 && Object.keys(w.bounds).length === 4, JSON.stringify(w.bounds));
    assert(w.sent.some(([ch, v]) => ch === 'controlbar:side' && v === 'right'), 'debe avisar el lado');
    cb.detach();
    assert(w.destroyed, 'detach debe destruir la barra');
  });

  await test('Se oculta si el usuario pasa a otro programa, si se minimiza o si no hay ventana del emulador', async () => {
    let st = { ok: true, emu: 1, x: 0, y: 0, w: 600, h: 1000, visible: true, iconic: false, fg: true };
    const { cb, el } = bar(() => st);
    cb.attach('App');
    await cb._tick();
    const w = el.wins[0];
    assert(w.visible, 'visible al principio');
    st = { ...st, fg: false };
    await cb._tick();
    assert(!w.visible, 'con otro programa en primer plano se oculta');
    st = { ...st, fg: true, iconic: true };
    await cb._tick();
    assert(!w.visible, 'minimizada se oculta');
    st = { ok: true, emu: 0 };
    await cb._tick();
    assert(!w.visible, 'sin emulador se oculta');
    cb.detach();
  });

  await test('Desactivada en Configuración / fuera de Windows: no se crea ninguna ventana', async () => {
    const off = bar(() => ({}), { enabled: () => false });
    assert(off.cb.attach('App') === false && off.el.wins.length === 0, 'desactivada');
    const el = fakeElectron();
    const linux = new ControlBar({ agent: { track: async () => ({}) }, enabled: () => true, preload: 'p', page: 'c', electron: el, platform: 'linux' });
    assert(linux.attach('App') === false && el.wins.length === 0, 'fuera de Windows');
  });

  await test('Navegación de Android: tres botones con el overlay oficial; si la imagen no lo trae, no se toca nada', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'emulator-5554' });
    const sent = [];
    c.shell = async (cmd) => {
      sent.push(cmd);
      if (cmd.startsWith('cmd overlay list')) return '[ ] com.android.internal.systemui.navbar.threebutton\n[x] com.android.internal.systemui.navbar.gestural';
      return '';
    };
    const r = await c.setNavButtons(true);
    assert(r.ok, JSON.stringify(r));
    assert(sent.some((x) => x === 'cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton'), sent.join(' | '));
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'emulator-5554' });
    const sent2 = [];
    c2.shell = async (cmd) => { sent2.push(cmd); return ''; };
    const r2 = await c2.setNavButtons(true);
    assert(!r2.ok && !sent2.some((x) => /enable-exclusive/.test(x)), 'sin el overlay no debe intentar cambiarlo');
  });

  await test('Teclas de Inicio y Apps abiertas usan los códigos de Android correctos', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'emulator-5554' });
    const keys = [];
    c._key = async (k) => { keys.push(k); };
    await c.keyHome();
    await c.keyRecents();
    assert(keys.join(',') === '3,187', keys.join(','));
  });

  await test('Conexiones: preload, proceso principal, ventana de la app y valores por defecto', async () => {
    const preload = read('src/preload.js');
    assert(/nav: \(key\) => invoke\('shell:nav'/.test(preload) && /screenshot: \(\) => invoke\('shell:screenshot'\)/.test(preload), 'preload debe exponer nav y screenshot');
    assert(/navButtons: \(on\) => invoke\('android:navButtons'/.test(preload), 'preload debe exponer navButtons');
    const main = read('src/main.js');
    assert(/ipcMain\.handle\('shell:nav'/.test(main) && /ipcMain\.handle\('shell:screenshot'/.test(main), 'faltan los IPC de la barra');
    assert(/controlBar: \(\) => store\.getSettings\(\)\.display\.controlBar !== false/.test(main), 'appWin debe recibir el interruptor');
    const appwin = read('src/core/appwin.js');
    assert(/this\.controlBar\.attach\(title\)/.test(appwin), 'openDetached debe mostrar la barra');
    assert(/close\(\{ keepApp = false \} = \{\}\) \{\n\s+if \(this\.controlBar\) this\.controlBar\.detach\(\);/.test(appwin), 'close debe quitar la barra');
    assert(/this\.agent\.minimize\(\)/.test(appwin), 'minimizar en modo independiente debe ir a la barra de tareas');
    const agent = read('src/core/win/agent.ps1');
    assert(/cmd == "track"/.test(agent) && /cmd == "minimize"/.test(agent) && /IsIconic\(_emu\) \? 9 : 5/.test(agent), 'faltan comandos del agente');
    const store = require('../src/core/store');
    assert(store.DEFAULT_SETTINGS.display.controlBar === true && store.DEFAULT_SETTINGS.display.navButtons === false, 'valores por defecto');
    const html = read('src/ui/controlbar.html');
    for (const act of ['back', 'home', 'recents', 'screenshot', 'rotate', 'maximize', 'minimize', 'close']) {
      assert(html.includes(`data-act="${act}"`), `falta el botón ${act}`);
    }
    const idx = read('src/ui/index.html');
    assert(idx.includes('id="setControlBar"') && idx.includes('id="setNavButtons"'), 'faltan las opciones en Configuración');
  });

  console.log('\n[barra de controles / navegación]');
  console.log(out.join('\n'));
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
