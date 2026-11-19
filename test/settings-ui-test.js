'use strict';
/**
 * Prueba rápida de la interfaz de configuración (necesita una ventana de Electron real)
 *
 * Ejecutar: electron test/settings-ui-test.js
 * Salida: test/out/settings-*.png
 *
 * Por qué va aparte: la estructura de la configuración se rehízo hace poco (se agregaron navegación por categorías y búsqueda),
 * y las pruebas en Node puro solo verifican la estructura del código, no que «se pueda pulsar y se vea bien».
 * Aquí se usa un proceso de renderizado real: abrir configuración → cambiar de categoría → buscar → capturar.
 */

const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const UI = path.join(__dirname, '..', 'src', 'ui');

const SETTINGS = {
  adbPath: '',
  runtime: { isoPath: '', sourcePreference: 'github', autoMirror: false, mirrorPrefix: '', downloadConnections: 8 },
  engine: {
    memoryMB: 4096, cores: 4, idleShutdownMinutes: 15, audio: true, liteMode: true,
    prewarm: true, priorityMode: 'balanced', deepTrim: false, mouseRightBack: true,
    mouseWheelMode: 'smooth', mouseSideButtons: false, keymapEnabled: true,
    resourceMode: 'balanced', renderSize: 'auto', dataPartitionGB: 6, fastDns: false,
    locale: 'es-419', chineseIme: false, keepSnapshot: true, logLimitKB: 2048,
  },
  display: {
    mode: 'window', portrait: '900x1600', autoFullscreenOnLaunch: false, landscape: false,
    orientationMode: 'auto', autoRotate: true, tabletMode: true, windowEmbed: true,
  },
  createShortcutOnInstall: true,
  createStartMenuShortcut: true,
  shortcutDir: '',
  sharedDir: path.join(process.env.USERPROFILE || '', 'LanzadorAPKShared'),
  deviceSharedDir: '/sdcard/LanzadorAPKShared',
  autoStart: true,
  notifyOnInstall: true,
  debug: { auto: true, intervalMin: 10, notify: true },
};

const DEBUG_ISSUES = [
  { code: 'device.unauthorized', category: 'device', severity: 'error', title: 'El dispositivo Android no autorizó la depuración', hint: 'Al reiniciar el runtime vuelve a aparecer el aviso.', fix: 'restartRuntime', detail: '' },
  { code: 'storage.diskLow', category: 'storage', severity: 'warn', title: 'Poco espacio en el disco del runtime', hint: 'Quedan menos de 8 GB.', fix: 'disk', detail: 'Quedan 5120 MB' },
  { code: 'settings.orientationConflict', category: 'settings', severity: 'warn', title: 'La estrategia de orientación es contraria a la pantalla actual', hint: 'Cambia la orientación para que coincida.', fix: 'orientation', detail: '' },
];

const OVERRIDES = {
  'settings:get': () => SETTINGS,
  'settings:set': () => SETTINGS,
  'app:info': () => ({ version: '0.6.0', isDev: true, dataDir: 'C:\\data', runtimeDir: 'C:\\data\\runtime' }),
  'apps:list': () => [],
  'assoc:status': () => ({ registered: false }),
  'doctor:profile': () => ({ profile: {}, text: 'Equilibrado · 4 núcleos / 4 GB / 720p' }),
  'doctor:selfCheck': () => ({ issues: [], accel: { ok: true }, free: 102400 }),
  'doctor:report': () => ({ ok: true, file: 'C:\\report.txt' }),
  'runtime:usage': () => ({ totalText: '8.2 GB', reclaimableText: '1.1 GB', count: 3 }),
  'runtime:status': () => ({ mode: 'builtin', backend: 'builtin', backendLabel: 'Integrado', installed: true, vmRunning: false, deviceOnline: false, ready: false, phase: 'idle', needsSetup: null, error: '', env: { adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } }, accel: { ok: true }, network: null }),
  'runtime:dataInfo': () => ({ avdDir: 'C:\\data\\avd', configuredGB: 6, actualGB: 6 }),
  'android:status': () => ({ running: false, wifi: true, airplane: false, anim: true, volume: 50, font: 1, density: 320 }),
  'drivers:list': () => ({ drivers: [], errors: [] }),
  'preflight:run': () => ({ items: [] }),
  'autodebug:state': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:run': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:config': () => SETTINGS.debug,
  'app:startupInfo': () => ({ firstRun: false, tips: [] }),
  'app:updateCheck': () => ({ ok: true, current: '0.6.0', hasUpdate: false, sources: [] }),
  'runtime:log': () => [],
  'leftovers:scan': () => ({ items: [] }),
  'engine:resources': () => ({ memory: {}, cores: {} }),
  'display:state': () => ({ mode: 'window' }),
  'keymap:getPresets': () => ({ presets: [] }),
  'keymap:isEnabled': () => ({ enabled: true }),
};

// Los demás canales devuelven un objeto vacío: todas las llamadas de app.js tienen .catch / respaldo para valores vacíos
const CHANNELS = [
  'apk:pick', 'apk:parse', 'apk:install', 'apk:reveal', 'dialog:openDir',
  'settings:restoreSystem', 'settings:refreshPointer', 'settings:unhook', 'settings:setSharedDir',
  'runtime:probe', 'runtime:start', 'runtime:stop', 'runtime:vcRedist', 'runtime:installVcRedist',
  'runtime:cleanup', 'runtime:resetData', 'runtime:repairNetwork', 'runtime:checkNetwork',
  'runtime:setDataSize', 'runtime:resetAndResize', 'runtime:autoDeploy', 'runtime:startInstaller',
  'runtime:markInstalled', 'runtime:resetInstall', 'app:confirm', 'display:set', 'display:toggle',
  'shortcut:rebuild', 'preflight:apply', 'drivers:import', 'drivers:openFolder',
  'drivers:exportTemplate', 'drivers:setEnabled', 'app:clearLocks', 'app:removeSelf',
  'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart', 'assoc:register', 'assoc:unregister',
  'share:sync', 'share:open', 'shell:open', 'window:minimize', 'window:maximize', 'window:close',
  'window:hide', 'app:foreground', 'app:updateApply', 'app:updateCancel', 'app:updateOpen',
  'app:restart', 'app:pin', 'app:setOrientation', 'app:launch', 'app:stop', 'app:uninstall',
  'app:createShortcut', 'app:clearData', 'app:revealApk', 'android:set', 'android:open',
  'android:tune', 'android:permissions', 'android:grantAll', 'keymap:getMap', 'keymap:setMap',
  'keymap:setEnabled', 'keymap:applyPreset', 'leftovers:clean', 'provision:check',
  'provision:probeSources', 'provision:installAdb', 'provision:installQemu', 'provision:installEmulator',
  'provision:installSysimg', 'provision:installPlayImage', 'provision:installAehd',
  'provision:enableAccel', 'provision:enableVirtualization', 'provision:openWindowsFeatures',
  'provision:downloadIso', 'provision:createDisk', 'provision:importIso', 'provision:importDisk',
];

let passed = 0;
let failed = 0;
function step(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ` ${detail}` : ''}`); } else { failed++; console.error(`  ✗ ${name}${detail ? ` ${detail}` : ''}`); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  for (const ch of CHANNELS) ipcMain.handle(ch, async () => ({}));
  for (const [ch, fn] of Object.entries(OVERRIDES)) ipcMain.handle(ch, async (_e, ...args) => fn(...args));

  const win = new BrowserWindow({
    width: 1180, height: 860, show: false,
    backgroundColor: '#f4f7f5',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);   // 2=warning, 3=error
  });
  await win.loadFile(path.join(UI, 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const evalJs = (code) => win.webContents.executeJavaScript(code, true);

  console.log('\n[Configuración · navegación por categorías]');
  // Primero se abre el diálogo de configuración (los resultados de la comprobación automática se obtienen y muestran al abrirlo)
  await evalJs(`document.getElementById('btnSettings').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const modalOpen = await evalJs(`document.getElementById('settingsMask').classList.contains('on')`);
  step('El diálogo de configuración se abre', modalOpen);

  const navInfo = await evalJs(`(() => ({
    items: document.querySelectorAll('#setNav .set-nav-item').length,
    cats: Array.from(document.querySelectorAll('#setNav .set-nav-item')).map(b => b.dataset.cat),
    groups: document.querySelectorAll('#settingsBody [data-cat]').length,
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
  }))()`);
  step('Se dibujaron los elementos de navegación', navInfo.items === 8, `${navInfo.items} elementos`);
  // Ojo: la categoría se recuerda (localStorage), así que aquí solo se afirma que «en cada momento solo se ven los grupos de una categoría»
  const oneCat = navInfo.visible.length > 0 && navInfo.visible.every((c) => c === navInfo.visible[0]);
  step('En cada momento solo se ven los grupos de una categoría', oneCat, `Visibles por defecto: ${navInfo.visible.join(',')}`);

  // Pulsar «Pantalla y ventana»
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="display"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterSwitch = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    on: document.querySelector('#setNav .set-nav-item.on') ? document.querySelector('#setNav .set-nav-item.on').dataset.cat : '',
  }))()`);
  step('Al pasar a «Pantalla y ventana» solo se ve esa categoría', afterSwitch.visible.length > 0 && afterSwitch.visible.every((c) => c === 'display'), `Visibles: ${afterSwitch.visible.join(',')}`);
  step('El resaltado de la navegación cambia también', afterSwitch.on === 'display', `Resaltado: ${afterSwitch.on}`);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-display.png'), img.toPNG()));

  // Pulsar «Diagnóstico y reparación» y mirar el panel de comprobación automática
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="diag"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const diag = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    items: document.querySelectorAll('#autodebugList .dbg-item').length,
    groups: document.querySelectorAll('#autodebugList .dbg-group').length,
    text: (document.getElementById('autodebugStateText') || {}).textContent || '',
    fixBtns: document.querySelectorAll('#autodebugList .dbg-fix').length,
  }))()`);
  step('En «Diagnóstico y reparación» se ven la revisión del equipo, los controladores y la comprobación automática', diag.visible.includes('diag') && diag.visible.length === 3, `Visibles: ${diag.visible.join(',')}`);
  step('Los resultados de la comprobación automática se agrupan por categoría', diag.groups >= 3 && diag.items === 3, `${diag.groups} grupos / ${diag.items} elementos`);
  step('Cada problema tiene un botón «Resolver»', diag.fixBtns === 3, `${diag.fixBtns} botones`);
  step('La línea de estado muestra la hora de la última comprobación', /Última comprobación/.test(diag.text), diag.text);

  // Desplazarse al panel de comprobación automática y capturar (esperando al compositor para no capturar el fotograma anterior)
  await evalJs(`document.getElementById('autodebugGroup').scrollIntoView({ block: 'start' })`);
  await new Promise((r) => setTimeout(r, 900));
  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-diag.png'), img.toPNG()));

  console.log('\n[Configuración · búsqueda]');
  await evalJs(`(() => { const s = document.getElementById('setSearch'); s.value = 'horizontal'; s.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const search = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).length,
    names: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => (g.querySelector('.group-title')||{}).textContent),
    clearVisible: !document.getElementById('btnClearSearch').hidden,
  }))()`);
  step('Buscar «horizontal» encuentra grupos', search.visible >= 1, `Coincidencias: ${search.visible} elementos: ${search.names.join(' / ')}`);
  step('Las coincidencias se ven en todas las categorías (la categoría actual no las tapa)', search.visible >= 1);
  step('Aparece el botón de borrar', search.clearVisible);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-search.png'), img.toPNG()));

  await evalJs(`document.getElementById('btnClearSearch').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const afterClear = await evalJs(`(() => Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat))()`);
  step('Al borrar la búsqueda se vuelve a la categoría actual', afterClear.length > 0 && afterClear.every((c) => c === 'diag'), `Visibles: ${afterClear.join(',')}`);

  console.log('\n[Configuración · memoria de categoría]');
  const remembered = await evalJs(`localStorage.getItem('lanzadorapk.settings.cat')`);
  step('Se recordó la última categoría visitada', remembered === 'diag', `Recordada: ${remembered}`);

  console.log('\n[Configuración · se dibuja sin errores]');
  const realErrors = errors.filter((e) => !/Autofill|devtools|Request Autofill/i.test(e));
  step('La consola no tiene errores', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas`);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
