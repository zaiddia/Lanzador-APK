'use strict';
/**
 * Notificaciones de Android → notificaciones nativas de Windows.
 *
 * El emulador no lleva las notificaciones a Windows; aquí se consulta `dumpsys notification` cada 2,5 s (solo lectura, bajo costo),
 * se detectan «las notificaciones nuevas» y se envían con Notification de Electron al centro de notificaciones del sistema.
 * Al pulsar la notificación se vuelve a la ventana de la app correspondiente.
 */
const { Notification, nativeImage } = require('electron');

const POLL_MS = 2500;

/**
 * Las notificaciones fijas del propio sistema no se pasan a Windows.
 * «Tarjeta SD virtual detectada», «Configurar teclado físico», «Google Play Protect activado» y similares
 * aparecen todos los días; convertirlas en notificaciones de Windows sería puro acoso.
 */
const SYSTEM_PKGS = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.shell',
  'com.android.vending',
  'com.android.providers.downloads',
  'com.android.documentsui',
  'com.google.android.apps.nexuslauncher',
  'com.google.android.gms',
  'com.google.android.gsf',
];
const isSystemPkg = (pkg) => SYSTEM_PKGS.includes(pkg)
  || /^com\.android\.providers\./.test(pkg)
  || /launcher/i.test(pkg);

function parseRecords(dump) {
  const out = [];
  const blocks = String(dump || '').split(/NotificationRecord\(/).slice(1);
  for (const b of blocks) {
    const pkg = (/pkg=([\w.]+)/.exec(b) || [])[1] || '';
    if (!pkg || isSystemPkg(pkg)) continue;
    const key = (/key=([^\s]+)/.exec(b) || [])[1] || '';
    const flags = (/flags=0x([0-9a-fA-F]+)/.exec(b) || [])[1] || '';
    const num = flags ? parseInt(flags, 16) : 0;
    // FLAG_ONGOING_EVENT(0x2) / FLAG_FOREGROUND_SERVICE(0x40) / FLAG_GROUP_SUMMARY(0x200)
    if (num & 0x2) continue;
    if (num & 0x40) continue;

    const grab = (field) => {
      const re = new RegExp(`${field}=([^\\n]*)`);
      const m = re.exec(b);
      if (!m) return '';
      const raw = m[1].trim();
      const par = /\(([\s\S]*)\)\s*$/.exec(raw);
      if (par) return par[1].trim();
      if (/^null$/.test(raw)) return '';
      return raw;
    };
    const title = grab('android\\.title');
    const text = grab('android\\.text');
    if (!title && !text) continue;
    out.push({ pkg, key, title, text });
  }
  return out;
}

class NotifyBridge {
  constructor({ getClient, getAppLabel, getAppIcon, onOpen }) {
    this.getClient = getClient;
    this.getAppLabel = getAppLabel;
    this.getAppIcon = getAppIcon;
    this.onOpen = onOpen;
    this.seen = new Set();
    this.timer = null;
    this.running = false;
    this.primed = false;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => this._tick(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (!this.running) return;
    let client = null;
    try {
      client = this.getClient();
      if (!client || !(await client.isOnline())) return;
      const dump = await client.shell('dumpsys notification --noredact', { timeout: 12000 });
      const list = parseRecords(dump);
      if (!this.primed) {
        // La primera vez solo se toma la línea base, para no mostrar todas las notificaciones viejas al iniciar
        for (const n of list) this.seen.add(`${n.pkg}|${n.key}|${n.title}`);
        this.primed = true;
        return;
      }
      const fresh = [];
      for (const n of list) {
        const id = `${n.pkg}|${n.key}|${n.title}`;
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        fresh.push(n);
      }
      // Para que la memoria no crezca: la deduplicación solo usa las últimas 500
      if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-300));
      for (const n of fresh) this._show(n);
    } catch (_) { /* Se ignora si el runtime no está listo */ }
  }

  _show(n) {
    try {
      if (!Notification.isSupported()) return;
      const label = this.getAppLabel ? this.getAppLabel(n.pkg) : n.pkg;
      const body = [n.title, n.text].filter(Boolean).join(' · ') || 'Nueva notificación';
      const iconPath = this.getAppIcon ? this.getAppIcon(n.pkg) : '';
      const note = new Notification({
        title: label || 'App Android',
        body: body.slice(0, 260),
        silent: false,
        icon: iconPath ? nativeImage.createFromPath(iconPath) : undefined,
      });
      note.on('click', () => { if (this.onOpen) this.onOpen(n.pkg); });
      note.show();
    } catch (_) { /* Un fallo de notificación no afecta la app */ }
  }
}

module.exports = { NotifyBridge, parseRecords };
