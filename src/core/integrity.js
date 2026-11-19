'use strict';
/**
 * Download integrity checks.
 *
 *  - Release assets (app updates, runtime pack): SHA-256, taken from the GitHub API
 *    `digest` field ("sha256:<hex>") or from the release's SHA256SUMS.txt asset.
 *    The checksum is always fetched from github.com directly, never through a mirror,
 *    so a mirror can speed up the download but cannot swap the file.
 *  - Google SDK components (emulator, system images): SHA-1 published in Google's
 *    repository XML next to each archive URL.
 */
const fs = require('fs');
const crypto = require('crypto');

const HEX = { sha256: /^[a-f0-9]{64}$/i, sha1: /^[a-f0-9]{40}$/i };

/** "sha256:abcd…" (GitHub API) → "abcd…"; anything else → '' */
function parseDigest(digest) {
  const m = /^sha256:([a-f0-9]{64})$/i.exec(String(digest || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** Parses `sha256sum` output: "<hex>  <name>" or "<hex> *<name>" per line. */
function parseSums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

function hashFile(file, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Throws (and deletes the file) when the hash does not match.
 * @param {string} file
 * @param {string} expected hex digest
 * @param {'sha256'|'sha1'} algo
 */
async function verifyFile(file, expected, algo = 'sha256', label = '') {
  const want = String(expected || '').toLowerCase();
  if (!HEX[algo] || !HEX[algo].test(want)) throw new Error(`Suma de verificación inválida para ${label || file}`);
  const got = await hashFile(file, algo);
  if (got !== want) {
    try { fs.rmSync(file, { force: true }); } catch (_) { /* ignore */ }
    const err = new Error(`El archivo descargado${label ? ` (${label})` : ''} no supera la verificación de integridad `
      + `${algo.toUpperCase()}: se esperaba ${want.slice(0, 12)}…, se obtuvo ${got.slice(0, 12)}…. Se eliminó por seguridad.`);
    err.code = 'INTEGRITY';
    throw err;
  }
  return true;
}

/**
 * Extracts url → {sha1, size} from a Google SDK repository XML block.
 * Each <complete> element holds <size>, <checksum type="sha1"> and <url>.
 */
function sdkChecksums(xml, toAbs = (u) => u) {
  const out = new Map();
  const re = /<complete>([\s\S]*?)<\/complete>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const body = m[1];
    const url = /<url>([^<]+)<\/url>/.exec(body);
    const sha1 = /<checksum(?:\s+type="sha1")?>([a-f0-9]{40})<\/checksum>/i.exec(body);
    const size = /<size>(\d+)<\/size>/.exec(body);
    if (url && sha1) out.set(toAbs(url[1].trim()), { sha1: sha1[1].toLowerCase(), size: size ? Number(size[1]) : 0 });
  }
  return out;
}

module.exports = { parseDigest, parseSums, hashFile, verifyFile, sdkChecksums };
