'use strict';
/**
 * Registro de backends
 *
 * **Solo hay un backend: el runtime integrado (builtin). **
 *
 * Desde 0.5.6, LanzadorAPK en cualquier equipo y situación solo ejecuta su propio runtime de Android
 * (adb / emulator / imagen del sistema propios); ya no detecta, toma ni controla ningún emulador de terceros
 * (MuMu / LDPlayer / BlueStacks / WSA / FydeOS), ni ofrece el modo «conectar un runtime existente».
 *
 * Por qué se borró toda la cadena de backends opcionales en vez de dejar un interruptor apagado:
 *   - mientras quede código de detección, si el usuario tiene MuMu instalado podría «tomarse de paso» en cualquier momento,
 *     y parecería «abro LanzadorAPK y corre el emulador de otro», con datos, partidas e imágenes donde el usuario no espera;
 *   - las actualizaciones, cambios de puerto o de configuración de emuladores de terceros romperían LanzadorAPK, y no podríamos arreglarlo;
 *   - el paquete de la Store / la versión portátil solo traen su propio runtime y de todos modos no pueden incluir ni depender de emuladores de terceros.
 * Por eso aquí se mantiene la forma de registro (la interfaz superior no cambia), con el contenido fijo en builtin:
 * leer la configuración, configuraciones antiguas o importar un settings.json viejo nunca cambia a otro backend.
 */

const { Backend, CAPS } = require('./base');
const { BuiltinBackend } = require('./builtin');

const REGISTRY = [
  BuiltinBackend,
];

/** El único backend. La constante se conserva como lugar claro «por si algún día se agrega otro backend». */
const ONLY = 'builtin';

function byId(id) {
  return REGISTRY.find((B) => B.id === id) || null;
}

/** Lista descriptiva para la interfaz (solo información estática, serializable sin riesgo) */
function describe() {
  return REGISTRY.map((B) => ({
    id: B.id,
    label: B.label,
    summary: B.summary,
    embedCapable: B.embedCapable,
  }));
}

/**
 * Crea una instancia de backend según la configuración.
 *
 * Atención: **se ignora a propósito settings.engine.mode**. Versiones antiguas pueden dejar mode=mumu / fydeos / attach,
 * y editar settings.json a mano también podría poner otro valor; todo eso debe tratarse como builtin,
 * si no, «funcionar siempre de forma independiente» sería solo una frase. El id devuelto siempre es 'builtin'.
 *
 * @param {object} o { appRoot, settings, runtime, store, log, id }
 * @returns {{ backend: Backend, Cls: Function, id: string }}
 */
function create({ appRoot, runtime, store, log, id: forced } = {}) {
  // Si se pasa explícitamente otro id (ruta de respaldo de código antiguo), también termina en builtin
  const id = forced && byId(forced) ? forced : ONLY;
  const Cls = byId(id) || BuiltinBackend;
  const backend = new Cls(appRoot, { runtime, store, log });
  return { backend, Cls, id: Cls.id };
}

/**
 * Elige backend automáticamente. Ahora solo hay uno; siempre devuelve builtin, sin detectar nada:
 * la detección misma tocaría carpetas / registro de emuladores de terceros, justo lo que se quiere eliminar.
 */
async function autoPick() {
  return { id: ONLY, reason: 'builtin-only' };
}

module.exports = {
  REGISTRY, ONLY, CAPS, byId, describe, create, autoPick, Backend,
};
