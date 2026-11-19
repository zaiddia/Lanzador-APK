'use strict';
/* Teclado latino: AdbClient.ensureLatinKeyboard() con un shell simulado (sin emulador). */
const { AdbClient } = require('../src/core/adb');

let passed = 0;
let failed = 0;
const out = [];
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
async function test(name, fn) {
  try { await fn(); passed += 1; out.push(`  ✓ ${name}`); } catch (e) { failed += 1; out.push(`  ✗ ${name}\n    ${e.message}`); }
}

function fake(imeList, current) {
  const c = new AdbClient({ adbPath: 'adb', serial: 'emulator-5554' });
  c.sent = [];
  c.shell = async (cmd) => {
    c.sent.push(cmd);
    if (cmd.startsWith('ime list')) return imeList.join('\n');
    if (cmd.startsWith('settings get secure default_input_method')) return current;
    return '';
  };
  return c;
}

(async () => {
  await test('prefiere Gboard y lo deja como predeterminado si el actual es pinyin', async () => {
    const c = fake(['com.android.inputmethod.latin/.LatinIME',
      'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
      'com.android.inputmethod.pinyin/.PinyinIME'], 'com.android.inputmethod.pinyin/.PinyinIME');
    const r = await c.ensureLatinKeyboard();
    assert(r.ok && /google/.test(r.ime), JSON.stringify(r));
    const last = c.sent[c.sent.length - 1];
    assert(/ime enable com\.google/.test(last) && /ime set com\.google/.test(last), last);
  });

  await test('usa LatinIME de AOSP si no hay Gboard', async () => {
    const c = fake(['com.android.inputmethod.latin/.LatinIME'], 'null');
    const r = await c.ensureLatinKeyboard();
    assert(r.ok && r.ime === 'com.android.inputmethod.latin/.LatinIME', JSON.stringify(r));
  });

  await test('no cambia el predeterminado si ya es un teclado latino', async () => {
    const c = fake(['com.android.inputmethod.latin/.LatinIME'], 'com.android.inputmethod.latin/.LatinIME');
    await c.ensureLatinKeyboard();
    assert(!c.sent.some((x) => /ime set/.test(x)), c.sent.join(' | '));
  });

  await test('sin teclado latino devuelve ok:false sin lanzar error', async () => {
    const c = fake(['com.example.ime/.Foo'], 'com.example.ime/.Foo');
    const r = await c.ensureLatinKeyboard();
    assert(r.ok === false && !c.sent.some((x) => /ime enable/.test(x)), JSON.stringify(r));
  });

  console.log('\n[teclado latino]');
  console.log(out.join('\n'));
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
