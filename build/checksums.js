#!/usr/bin/env node
'use strict';
/**
 * Publishes SHA256SUMS.txt for a GitHub release (used by the in-app updater).
 *
 *   node build/checksums.js v1.2.3
 *
 * Uses the `digest` field GitHub computes for every release asset; when it is missing,
 * downloads that asset and hashes it locally. Requires the `gh` CLI with GH_TOKEN set.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tag = process.argv[2];
if (!tag) { console.error('Uso: node build/checksums.js <tag>'); process.exit(2); }

const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

const rel = JSON.parse(gh(['api', `repos/{owner}/{repo}/releases/tags/${tag}`]));
const lines = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sums-'));
for (const a of rel.assets || []) {
  if (a.name === 'SHA256SUMS.txt') continue;
  let hex = (/^sha256:([a-f0-9]{64})$/i.exec(a.digest || '') || [])[1];
  if (!hex) {
    console.log(`Sin digest en la API para ${a.name}; descargando para calcularlo…`);
    gh(['release', 'download', tag, '-p', a.name, '-D', tmp, '--clobber'], { stdio: 'inherit' });
    hex = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, a.name))).digest('hex');
  }
  lines.push(`${hex.toLowerCase()}  ${a.name}`);
}
lines.sort((x, y) => x.slice(66).localeCompare(y.slice(66)));
const out = path.join(tmp, 'SHA256SUMS.txt');
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(fs.readFileSync(out, 'utf8'));
gh(['release', 'upload', tag, out, '--clobber'], { stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true, force: true });
