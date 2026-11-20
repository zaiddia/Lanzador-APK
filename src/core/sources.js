'use strict';
/**
 * Gestión unificada de fuentes de descarga: GitHub + prefijo de espejo opcional del usuario.
 *
 * Problemas habituales al descargar de GitHub:
 *   1. api.github.com a veces tarda decenas de segundos en responder o se agota: el síntoma es «buscar actualizaciones se queda girando»;
 *   2. la descarga de archivos (objects.githubusercontent.com) se limita por conexión, a veces a unos 100 KB/s:
 *      el paquete del runtime de 1,5 GB tardaría 4 horas.
 *
 * Por eso no se supone de antemano «cuál es la fuente principal»; cada vez se mide la velocidad con bytes reales:
 *   - información de versión: se consulta la API de GitHub (con respaldos si se agota el límite de la API);
 *   - direcciones de descarga: se listan «GitHub directo / con el prefijo de espejo del usuario»,
 *     se baja una muestra de cada dirección, se ordenan por velocidad medida y se toma la más rápida.
 *
 * El resultado de la medición se guarda 30 minutos en memoria (en el mismo proceso no hace falta volver a medir al buscar actualizaciones/descargar varios componentes).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer, isReleaseTag } = require('./version');
const { PRODUCT } = require('./brand');
const { parseDigest, parseSums } = require('./integrity');

const { OWNER: OWNER_GH, REPO } = require('./brand');

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
};

/** Prefijos de espejo de GitHub predefinidos. Ahora vacío: solo se usa un espejo si el usuario lo configura. */
// Third-party GitHub proxies were removed on purpose: downloads only go to GitHub itself
// (or to a mirror prefix the user configures explicitly in Settings).
const KNOWN_MIRRORS = [];

/**
 * Bytes de muestra por medición.
 * 128 KB es muy poco: el handshake + TLS ya son cientos de ms y la «velocidad» medida sería sobre todo la latencia,
 * tomando por lenta una fuente de «alta latencia pero mucho ancho de banda». 256 KB separa ambas cosas con un tráfico aceptable.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Demasiadas redirecciones'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Dirección no válida')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'LanzadorAPK/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de conexión agotado')));
    req.on('error', reject);
    req.end();
  });
}

/** Obtiene un JSON pequeño (con redirecciones, tiempo límite y límite de tamaño) */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Descarga de verdad unos bytes para medir la velocidad.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // El rendimiento solo cuenta el tiempo «desde que empiezan a llegar bytes»: los cientos de ms del handshake TLS + DNS son un costo fijo,
      // casi no influyen en el total de un paquete de 1,4 GB, y mezclarlos en la velocidad sesgaría la decisión.
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // El archivo es más pequeño que la muestra: llegar a EOF también cuenta como éxito
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Antepone el prefijo de espejo a la dirección de un archivo de GitHub */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * Formato heredado de paquetes en partes: algunas fuentes limitaban los adjuntos a 100 MB, y un instalador de 105–110 MB se publicaba partido en
 * xxx.zip.part1 / xxx.zip.part2. Aquí las partes se reconstruyen como un solo archivo lógico:
 *   { name: 'xxx.zip', size: suma, parts: [{index, size, urls:[...]}] }
 * Las partes deben ser consecutivas desde part1; si no, se consideran incompletas y se descartan (mejor el paquete entero que bajar uno dañado).
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // Ojo: algunas fuentes solo dan name/url en sus archivos, **sin size**.
    // Exigir «size>0» como condición de integridad descartaría todo el grupo como incompleto (pasó en pruebas),
    // así que aquí solo se exige «partes consecutivas + dirección en cada parte»; con tamaño desconocido el progreso se muestra por bytes recibidos.
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** Lista de espejos: primero el personalizado del usuario, luego los predefinidos (con autoMirror apagado solo el personalizado) */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.LANZADORAPK_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Caché del resultado de la búsqueda de versiones: las llamadas anónimas a las API tienen límites estrictos,
    // y «si hay versión nueva» no necesita frescura al segundo.
    this._relCache = { at: 0, key: '', value: null };
    this._relTtl = 10 * 60 * 1000;
    // Cortacircuitos: si una fuente queda limitada/da error, se omite durante un tiempo, en vez de chocar con ella en cada inicio
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** Si la fuente está en periodo de corte; null significa disponible, si no, devuelve el motivo para el usuario */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Omitido temporalmente (no se volverá a intentar en ${Math.ceil((until - Date.now()) / 60000)} min)`;
  }

  /** El release más reciente de cada fuente (en paralelo; si una falla no afecta a otra) */
  /**
   * Respaldo sin depender de la API: sigue directamente el 302 de `/releases/latest` para obtener la etiqueta.
   *
   * Por qué hace falta: la API anónima de GitHub solo permite 60 llamadas por hora por IP,
   * y algunas redes comparten la misma IP (empresas, universidades, NAT del proveedor),
   * donde el usuario fácilmente vería «error al buscar actualizaciones»;
   * en cambio la redirección web de `releases/latest` pasa por la CDN y no consume cuota de la API.
   *
   * Con la etiqueta, los nombres de los archivos se arman según la convención de publicación:
   *   LanzadorAPK-<tag>-win64-portable.zip / LanzadorAPK-<version>-Setup.exe / LanzadorAPK-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Arma con la etiqueta un release «mínimo utilizable» (cuando no hay API) */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `LanzadorAPK-${tag}-win64-portable.zip`,
      `LanzadorAPK-${ver}-Setup.exe`,
      `LanzadorAPK-runtime-${tag}.zip`,
    ];
    // GitHub admite direcciones estándar /releases/download/<tag>/<archivo>
    // (que redirigen con 302 al archivo real y se descargan completas),
    // así que sin API también se pueden armar direcciones de descarga válidas. Si un archivo no existe da 404,
    // y la medición de velocidad posterior lo omite automáticamente.
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const ids = ['github'];
    // La interfaz releases de un repositorio público se lee de forma anónima; si el repositorio fuera privado
    // devolvería 404 (no 401), y solo en ese caso haría falta un token de solo lectura.
    // Además las llamadas anónimas tienen límite de frecuencia.
    const withToken = (_id, url) => url;

    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      const skip = this.blockedReason(id);
      if (skip) return { source: id, name: s.name, web: s.web, error: skip };
      try {
        const rel = await getJson(withToken(id, `${s.api}/releases/latest`), 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // Si no hay release oficial o la API no responde, se usa la lista y se toma el primero
        try {
          const list = await getJson(withToken(id, `${s.api}/releases?per_page=10`), 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* Se sigue con el respaldo que no depende de la API */ }
        // Respaldo cuando la API está limitada/no responde: etiqueta por la redirección web y nombres de archivo según la convención
        try {
          const tag = await this._releaseTagViaRedirect(id);
          if (tag) {
            return { source: id, name: s.name, web: s.web, rel: this._syntheticRelease(id, tag), degraded: true };
          }
        } catch (_) { /* El respaldo tampoco funcionó */ }
        const limited = /\b(403|429)\b/.test(e.message);
        if (limited) this._blocked.set(id, Date.now() + this._blockMs);
        const hint = limited
          ? ' (límite de solicitudes alcanzado; esta fuente se pausa un tiempo)'
          : '';
        return { source: id, name: s.name, web: s.web, error: `${e.message}${hint}` };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * Combina las versiones más recientes: gana la de número mayor, pero **la lista de archivos es la unión**,
   * por si distintas fuentes tienen distintos archivos.
   */
  async latest({ force = false } = {}) {
    const pref = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const cached = this._relCache;
    if (!force && cached.value && cached.key === pref && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // Las fuentes limitadas se registran en el cortacircuitos (va aquí y no dentro de fetchReleases para que «quién da
    // el resultado» se pueda sustituir/probar, y para que cualquier 403 que llegue por cualquier vía active el corte)
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    // Releases con etiqueta mal escrita (p. ej. «v0.71» en vez de «v0.7.1») se ignoran: compararían como versión más alta
    const ok = all.filter((x) => x && x.rel && isReleaseTag(x.rel.tag_name || x.rel.name));
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'sin datos'}`).join(';');
      // Todo falló pero hay un resultado anterior: mejor dar información de versión «quizá vieja»
      // que mostrar directamente un error en la interfaz; el usuario al menos ve la versión actual y el enlace a la página de versiones.
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`No se puede conectar con el servidor de actualizaciones (${why})`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // Solo cuentan los archivos de la misma versión (no se pueden instalar archivos de versiones viejas de otra fuente).
    // Si coexisten el paquete entero y un grupo de partes con el mismo nombre, se prefiere el entero: las partes hay que unirlas, un punto de fallo más.
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // Algunas plataformas cuelgan automáticamente el «código fuente» como archivo (v0.3.2.zip / v0.3.2.tar.gz);
        // no son instaladores, y la regla `\.zip$` los tomaría como paquete de actualización; hay que excluirlos.
        // Nuestros archivos publicados siempre empiezan con LanzadorAPK; usar ese prefijo como lista permitida es más seguro.
        if (!new RegExp(`^${PRODUCT}`, 'i').test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
          sha256: parseDigest(a.digest),
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // El mismo archivo en varias fuentes: se guardan todas las direcciones como candidatas.
    // Antes se «quitaban duplicados por nombre y ganaba el primero», y las demás direcciones se perdían,
    // así que «elegir automáticamente la mejor red» se reducía a una sola. Ahora se elige por velocidad medida (ver rank()).
    // El tamaño de cada dirección se guarda aparte: los paquetes de distintas fuentes pueden no ser los mismos bytes (otro compresor/máquina, unos MB de diferencia),
    // y downloadMulti solo mezcla direcciones que «declaran el mismo tamaño total», así que nunca se promedian los tamaños.
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
      if (!hit.sha256 && a.sha256) hit.sha256 = a.sha256;
    }

    // Fill in missing SHA-256 values from the release's SHA256SUMS.txt (always github.com).
    if (assets.some((a) => !a.sha256)) {
      const sums = await this.fetchSums(tag).catch(() => new Map());
      for (const a of assets) if (!a.sha256 && sums.has(a.name)) a.sha256 = sums.get(a.name);
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), key: pref, value: result };
    return result;
  }

  /**
   * Downloads SHA256SUMS.txt for a tag straight from github.com (never via a mirror).
   * @returns {Promise<Map<string,string>>} asset name → sha256 hex
   */
  async fetchSums(tag) {
    if (!tag) return new Map();
    const url = `${SOURCES.github.web}/releases/download/${encodeURIComponent(tag)}/SHA256SUMS.txt`;
    const res = await openUrl(url, { timeout: 10000 });
    if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return new Map(); }
    const chunks = [];
    let len = 0;
    await new Promise((resolve, reject) => {
      res.on('data', (c) => { len += c.length; if (len > 256 * 1024) { res.destroy(); resolve(); return; } chunks.push(c); });
      res.on('end', resolve);
      res.on('error', reject);
    });
    return parseSums(Buffer.concat(chunks).toString('utf8'));
  }

  /**
   * Direcciones candidatas de un archivo en todas las fuentes + espejos (sin duplicados, en orden: primero la fuente original, luego los espejos)
   * El espejo solo se aplica a direcciones de GitHub: los prefijos de espejo solo sirven de proxy para GitHub,
   * y aplicarlo a otros enlaces solo daría un 403 y una medición de velocidad inútil.
   */
  candidates(assetOrUrl) {
    // Admite tres entradas: una dirección, un objeto de archivo (url) o un objeto combinado (arreglo urls, con varias fuentes)
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * Ordena las direcciones candidatas por velocidad medida. La medición se guarda 30 minutos;
   * si todas fallan se vuelve al orden original (para que «en el peor caso igual se pueda descargar»).
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `Midiendo la velocidad de ${need.length} fuentes de descarga…` });
      // Se mide en orden y no en paralelo: en paralelo compiten por el ancho de banda y la clasificación sería «quién pelea más»,
      // no «quién es más rápido». 256 KB por fuente, normalmente un segundo.
      // Cada fuente espera como máximo 6 s (la versión anterior: 9 s × 4 fuentes = hasta 36 s sin ningún progreso de bytes,
      // y el usuario veía «atascado preparando el runtime»); una medición fallida solo va al final, no impide descargar.
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* Si la dirección no es válida se muestra tal cual */ }
        onProgress?.({ stage: 'probe', message: `Midiendo la velocidad de la fuente ${i}/${need.length}: ${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `Fuente más rápida elegida: ${new URL(best).host} (hace unos ${(s / 1048576).toFixed(2)} MB/s)`,
      });
    }
    return sorted;
  }

  /** Vacía la caché de velocidad (se llama cuando el usuario cambia el prefijo de espejo / de red) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, key: '', value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
