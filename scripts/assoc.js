#!/usr/bin/env node
'use strict';
/**
 * Interruptor de línea de comandos para la asociación de .apk (sin abrir la interfaz)
 *   node scripts/assoc.js on   → registra la instalación con doble clic en un APK
 *   node scripts/assoc.js off  → quita la asociación
 */
const path = require('path');
const fs = require('fs');
const { registerAssociation, unregisterAssociation } = require('../src/core/assoc');

const action = process.argv[2] || 'on';
const isDev = !process.env.LANZADORAPK_PACKAGED;
const exe = isDev
  ? path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.execPath;
const appDir = path.join(__dirname, '..');

if (action === 'on') {
  const iconPath = path.join(__dirname, '..', 'build', 'lanzadorapk.ico');
  const r = registerAssociation(exe, fs.existsSync(iconPath) ? iconPath : undefined,
    isDev ? `"${appDir}"` : undefined);
  console.log('已注册 .apk 关联：', r.progId);
  console.log('现在在资源管理器中双击 .apk 即可安装到 LanzadorAPK。');
} else if (action === 'off') {
  unregisterAssociation();
  console.log('已取消 .apk 关联。');
} else {
  console.log('用法：node scripts/assoc.js [on|off]');
  process.exit(1);
}
