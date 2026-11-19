'use strict';
/**
 * Descargador: admite redirecciones, reanudación, callbacks de progreso y verificación SHA-256
 * Solo depende de http/https; sirve en el proceso principal y en pruebas con Node puro.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const UA = 'LanzadorAPK/0.2 (Windows; +https://github.com/zaiddia/Lanzador-APK)';

/**
 * Verifica que el Content-Range devuelto por el servidor coincida con esta petición.
 * Lo que más daña la reanudación/descarga por bloques es que «el servidor ignore Range y mande el paquete entero desde el principio» o «devuelva bloques de otro archivo»;
 * escribirlo directo en el destino arma un paquete que parece completo pero está dañado. Aquí se comparan inicio, fin, tamaño total y
 * Content-Length; si algo no coincide se rechaza y la capa superior cambia de fuente/reintenta.
 */
function validRange(res, start, end, total) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
  if (!m) return false;
  const [a, b, size] = m.slice(1).map(Number);
  const length = res.headers['content-length'];
  return Number.isSafeInteger(size) && a === start && b === end && size === total &&
    (length == null || Number(length) === end - start + 1);
}

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Demasiadas redirecciones'));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method,
      timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(openStream(next, { method, headers, redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Tiempo de conexión agotado')); });
    req.end();
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Descarta todos los restos de una descarga fallida.
 *
 * Esta era la causa de «descarga lo mismo una y otra vez»: antes todos los caminos de error solo lanzaban la excepción sin borrar el archivo,
 * así que en tmp siempre quedaba un zip a medias + un .chunks.json auxiliar. La próxima vez,
 * downloadParallel/download veía el archivo y reanudaba con Range, pero si el tamaño total/forma de bloques del servidor
 * no era igual que antes, volvía a fallar → otro archivo a medias →
 * bucle infinito. El usuario veía «cada vez que abro vuelve a descargar el mismo paquete».
 *
 * Mantener la reanudación tiene valor, pero solo cuando «se confirma que se puede reanudar»; si esta
 * descarga falla, el paquete entero se descarta y la próxima vez empieza limpio.
 */
function discardPartial(dest) {
  for (const p of [dest, `${dest}.chunks.json`, `${dest}.part`]) {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* Si está en uso, se deja */ }
  }
}

/**
 * Descarga a un archivo local (con reanudación automática).
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, timeoutMs }
 */
async function download(url, dest, opt = {}) {
  const { onProgress = () => {}, signal, expectSha256, retries = 2 } = opt;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let attempt = 0;
  try {
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // 416 tiene dos causas posibles: el archivo ya estaba completo, o el fragmento local no coincide con el destino (el servidor considera
      // inválido ese Range). Antes siempre se tomaba como éxito y el fragmento dañado quedaba como «descargado». Ahora, si se envió
      // Range y quedan reintentos, se borra el fragmento y se descarga completo de nuevo; si se agotan los reintentos sin éxito, se reporta el error.
      if (existing > 0 && attempt <= retries + 1) {
        discardPartial(dest);
        continue;
      }
      throw new Error('No se pudo verificar el archivo a reanudar; el servidor respondió HTTP 416');
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      discardPartial(dest);   // Reintentos agotados: no dejar el archivo dañado para la próxima reanudación
      throw new Error(`Error de descarga HTTP ${res.statusCode}: ${url}`);
    }

    if (res.statusCode === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
      if (!m || !validRange(res, existing, Number(m[2]), Number(m[3])) || Number(m[2]) !== Number(m[3]) - 1) {
        res.resume();
        discardPartial(dest);
        throw new Error('El servidor devolvió un rango de reanudación que no coincide');
      }
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // El servidor no admite reanudar; se escribe desde el principio
      fs.rmSync(dest, { force: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const startSize = res.statusCode === 206 ? existing : 0;
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

        // Igual que en la descarga por bloques: hay que garantizar que la promesa siempre se resuelva.
        // Si la conexión queda en silencio (bloqueada/limitada), res no termina ni da error, pipe nunca termina
        // y toda la descarga se queda aquí: el usuario ve la barra de progreso quieta y ningún error.
        const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
        let settled = false;
        let idle = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (idle) clearTimeout(idle);
          try { ws.destroy(); } catch (_) { /* ignore */ }
          if (err) reject(err); else resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            res.destroy();
            finish(new Error('Conexión estancada (mucho tiempo sin datos)'));
          }, idleMs);
        };
        kick();

        const onAbort = () => { res.destroy(new Error('Cancelado')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        res.on('data', (c) => {
          got += c.length;
          kick();
          const now = Date.now();
          if (now - lastTick > 400) {
            const speed = (got - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = got;
            onProgress({
              got, total,
              percent: total ? Math.min(100, (got / total) * 100) : 0,
              speed,
              eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
            });
          }
        });
        res.pipe(ws);
        ws.on('finish', () => finish());
        ws.on('error', (e) => finish(e));
        res.on('error', (e) => finish(e));
        res.on('close', () => { if (!res.complete) finish(new Error('Conexión interrumpida')); });
      });
    } catch (e) {
      // Interrupción / tiempo agotado / fallo de escritura: un archivo a medias solo hace fallar la próxima reanudación
      discardPartial(dest);
      throw e;
    }

    break;
  }

  // Final: asegura que la barra de progreso llegue al 100 %
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      discardPartial(dest);
      throw new Error(`Verificación fallida: se esperaba ${expectSha256.slice(0, 12)}… se obtuvo ${actual.slice(0, 12)}…`);
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
  } catch (e) {
    // Si openStream rechaza directamente (conexión rechazada / fallo de DNS / tiempo agotado) no se entra en el
    // try/catch de escritura; antes aquí no se limpiaba nada y el archivo a medias hacía fallar la siguiente reanudación.
    // Se captura todo en el nivel exterior: ante cualquier excepción primero se descartan los restos.
    discardPartial(dest);
    throw e;
  }
}

/**
 * Descarga en bloques en paralelo (para archivos grandes).
 * En algunos espejos una sola conexión TCP se limita a decenas de KB/s; los bloques en paralelo mejoran mucho el rendimiento real.
 * Solo en paralelo si «el archivo de destino no existe»; si ya hay un archivo parcial se usa la reanudación de un solo flujo, para no perder el estado de los bloques.
 */
async function downloadParallel(url, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
  } = opt;

  // Ya hay un archivo parcial → reanudación de un solo flujo
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // Detecta si admite Range
  let total = 0;
  let supportsRange = false;
  try {
    const probe = await openStream(url, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers['content-range'];
    if (probe.statusCode === 206 && cr) {
      supportsRange = true;
      total = Number(/\/(\d+)$/.exec(cr)[1]) || 0;
    } else {
      total = Number(probe.headers['content-length']) || 0;
    }
    probe.destroy();
  } catch (_) { /* Si falla la detección se usa un solo flujo */ }

  if (!supportsRange || !total || total < minChunk * 2) {
    return download(url, dest, opt);
  }

  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // Primero se crea el archivo vacío y se posiciona en el último byte, para que las escrituras posteriores no se salgan
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c) => {
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Solicitud de bloque rechazada HTTP ${res.statusCode}`);
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error('El servidor devolvió un rango de bloque que no coincide');
    }
    await new Promise((resolve, reject) => {
      // Hay que protegerse de que «la promesa nunca se resuelva»: res.destroy(err) a veces solo emite
      // close y no error; sin este guard un bloque se quedaría colgado y toda la descarga se detendría.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (mucho tiempo sin datos)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (mucho tiempo sin datos)')); }, idleMs);
      };
      res.on('data', (buf) => {
        // El servidor podría devolver datos fuera del rango del bloque pedido; los bytes extra se escribirían sobre otro bloque
        // y armarían un paquete dañado en silencio. Mejor fallar y cambiar de fuente que escribirlo en disco.
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error('La respuesta del bloque excede el rango pedido'));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick();
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Conexión interrumpida')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c);
          if (ok) return;
          throw new Error('El bloque no llegó completo');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(`Error al descargar el bloque (${c.start}-${c.end}): ${e.message}`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);   // Se descarta el paquete entero; no dejar un archivo a medias para la próxima reanudación
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Descarga incompleta: ${size}/${total} bytes`);
  }
  return { file: dest, size, parallel: n };
}

/** Prueba varias fuentes en orden; devuelve en cuanto una funciona */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // Antes de cambiar de fuente se borra el archivo a medias de la anterior
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`Fallaron todas las fuentes de descarga:\n${errors.join('\n')}`);
}

/**
 * Descarga simultánea de varias fuentes: el archivo se divide en bloques y **cada bloque se baja a la vez de una fuente distinta**, sumando ancho de banda.
 *
 * Por qué: GitHub suele limitar cada conexión, y los espejos también tienen sus propios límites;
 * si las 8 conexiones apuntan a la misma dirección, el techo es el de esa dirección. Repartiendo 4 a GitHub
 * y 4 al espejo, se suman sus límites; en pruebas fue más del doble de rápido.
 *
 * Condición de seguridad: solo se mezclan fuentes que «declaran el mismo tamaño total»; si no, el archivo podría quedar dañado;
 * si una fuente falla a mitad, sus bloques se reintentan automáticamente con la siguiente dirección disponible (sin reiniciar el paquete entero).
 */
async function downloadMulti(urls, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    // Reintentos por bloque. 3 no bastan en enlaces donde «dos de tres fuentes a veces se detienen»:
    // si un bloque del runtime de 1,4 GB agota sus reintentos, se descarta el paquete entero. Se dan 6 (dos rondas por fuente).
    // Los reintentos continúan desde el punto de corte (se conserva c.pos); no se vuelven a bajar bytes ya recibidos.
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error('No hay ninguna dirección de descarga disponible');
  if (list.length === 1) return downloadParallel(list[0], dest, opt);

  // 1) Detección en paralelo: tamaño total + si admite Range
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, { headers: { Range: 'bytes=0-0' } });
      const cr = res.headers['content-range'];
      const total = res.statusCode === 206 && cr ? Number(/\/(\d+)$/.exec(cr)[1]) || 0 : 0;
      res.destroy();
      return { url: u, total, ranged: !!total };
    } catch (_) {
      return { url: u, total: 0, ranged: false };
    }
  }));

  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // Solo se mezclan fuentes que «declaran el mismo tamaño total»; si no, el archivo quedaría dañado.
  // La referencia es **el tamaño total de la fuente más rápida medida** (el orden de usable es el orden de velocidad de rank();
  // la detección usa Promise.all pero los resultados vuelven en el orden de entrada):
  // los paquetes comprimidos en distintas fuentes pueden tener tamaños diferentes (unos MB de diferencia es normal),
  // y antes se usaba siempre Math.max, es decir, siempre la fuente con el archivo más grande; según la red
  // eso podía excluir el paquete más rápido y obligar a usar el lento.
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) Divide en bloques y asigna fuentes por turnos
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Reanudación por bloques: en enlaces donde «el espejo a veces se detiene», un paquete de 1,4 GB agota fácilmente los reintentos de algún bloque,
  // y si se descarta entero el usuario espera otros diez minutos o más. Aquí se anota «qué bloques ya terminaron» en
  // un archivo auxiliar, y la próxima vez (misma ruta, misma forma de bloques) solo se bajan los que faltan.
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m && m.total === total && m.n === n && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(m.done || []);
      resume = true;
    }
  } catch (_) { /* Sin archivo auxiliar se descarga desde cero */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // Hay que inicializarlo explícitamente: undefined < 2 es false y nunca se cambiaría de fuente
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ total, n, done: [...doneSet] }));
    } catch (_) { /* Si no se puede escribir el archivo auxiliar, la descarga no se ve afectada */ }
  };

  // Al reanudar se cuentan en el progreso los bloques ya completos, así el porcentaje no vuelve a 0
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // Cambio de fuente por lentitud: si un bloque solo avanza a decenas de KB/s desde una fuente, esperar a que termine
  // deja la descarga «atascada en 95 %». Tras slowAfterMs con velocidad media menor que slowBps se corta y se pasa a la siguiente fuente
  // (desde el punto de corte, sin perder datos). Cada bloque cambia como máximo 2 veces, para no saltar entre fuentes lentas.
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c) => {
    const url = same[c.src % same.length].url;
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Bloque rechazado HTTP ${res.statusCode}`);
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error('El servidor devolvió un rango de bloque que no coincide');
    }
    const startPos = c.pos;
    const startedAt = Date.now();
    // Tras destruir una conexión todavía pueden llegar paquetes en búfer, que dispararían otro cambio y saltarían fuentes de más,
    // así que cada petición solo puede cambiar una vez.
    let rotated = false;
    await new Promise((resolve, reject) => {
      // Vigilante de inactividad + «garantizar resolución»: la conexión se estableció pero no llega ni un byte (el típico
      // «TCP conecta pero está bloqueado/limitado»); esperar el tiempo de espera del socket lleva 30 s, y res.destroy(err)
      // puede emitir solo close sin error, y la promesa nunca rechazaría: un bloque se colgaría
      // y toda la descarga se detendría (pasó en pruebas). Por eso el vigilante llama a finish él mismo.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (mucho tiempo sin datos)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Conexión estancada (tiempo sin datos agotado)')); }, idleMs);
      };
      res.on('data', (buf) => {
        // Igual que arriba: se rechazan bytes fuera del rango pedido para no dañar un bloque en silencio
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error('La respuesta del bloque excede el rango pedido'));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick(false);
        // Va inaceptablemente lento antes de terminar → cambio de fuente (c.pos ya avanzó; la próxima vez sigue desde el corte)
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // Aquí no se avanza c.src: el cambio de fuente lo hace el catch de abajo; si no, un solo fallo saltaría dos fuentes
            res.destroy();
            finish(new Error(`Esta fuente es demasiado lenta (${(bps / 1024).toFixed(0)} KB/s); se prueba otra`));
          }
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Conexión interrumpida')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error('El bloque no llegó completo');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) {
            // Reintentos agotados: este archivo ya mezcla «bloques de distintas fuentes» y reanudarlo
            // nunca daría los bytes correctos. Se descartan el paquete + el archivo auxiliar y la próxima vez empieza limpio.
            // Antes aquí solo se hacía saveMeta() y cada vez se seguía desde bloques dañados → descargas infinitas.
            discardPartial(dest);
            throw new Error(`Error en el bloque (${c.start}-${c.end}): ${e.message}`);
          }
          // Probar con otra fuente: un espejo que falla no debe arruinar toda la descarga
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  const size = fs.statSync(dest).size;
  tick(true);
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Descarga incompleta: ${size}/${total} bytes`);
  }
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** Prueba varias fuentes en orden (versión por bloques en paralelo); devuelve en cuanto una funciona */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    // Antes de cambiar de fuente hay que borrar el archivo a medias de la anterior: los paquetes de distintas fuentes pueden diferir en bytes,
    // y reanudar con el resultado parcial de la fuente A desde la fuente B siempre da un archivo dañado (falla la verificación → otra descarga).
    discardPartial(dest);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`Fallaron todas las fuentes de descarga:\n${errors.join('\n')}`);
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti,
  head, sha256File, openStream, discardPartial, validRange,
};
