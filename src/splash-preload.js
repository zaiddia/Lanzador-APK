'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanzadorapkSplash', {
  version: () => ipcRenderer.invoke('splash:version'),
  isFirstRun: () => ipcRenderer.invoke('splash:isFirstRun'),
  // Si los componentes vienen en el paquete (versión completa / MSIX de la Store) o hay que descargarlos (versión ligera).
  // La animación de arranque cambia según esto el texto de «descargando xx MB»: si ya vienen incluidos y dice «descargando»,
  // el usuario creería que tras instalar todavía hay que bajar todo otra vez.
  bundled: () => ipcRenderer.invoke('splash:bundled'),
  onProgress: (cb) => { ipcRenderer.on('splash:progress', (_e, p) => cb(p)); },
  onDone: (cb) => { ipcRenderer.on('splash:done', () => cb()); },
  close: () => ipcRenderer.send('splash:close'),
});
