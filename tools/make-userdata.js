'use strict';
/**
 * Genera la imagen semilla de userdata (para depuración).
 * Uso: node tools/make-userdata.js <archivo de salida> [tamaño en MB]
 */
const fs = require('fs');
const { buildEmptyExt4 } = require('../src/core/userdata');

const out = process.argv[2];
if (!out) {
  console.error('Uso: node tools/make-userdata.js <archivo de salida> [tamaño en MB]');
  process.exit(2);
}
const sizeMB = Number(process.argv[3] || 64);
const img = buildEmptyExt4({ sizeMB });
fs.writeFileSync(out, img);
console.log(`Generado ${out} (${(img.length / 1024 / 1024).toFixed(0)} MB, ext4/bloque de 4 KB)`);
