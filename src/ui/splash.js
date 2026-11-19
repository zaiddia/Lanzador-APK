'use strict';
/* Script de la animación de arranque de LanzadorAPK: recibe las actualizaciones de progreso del proceso principal y controla el desvanecido */

const api = window.lanzadorapkSplash;
if (!api) { /* Si preload no se inyectó, sale en silencio */ }

const $ = (id) => document.getElementById(id);

// Número de versión
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// Marca de primera instalación + si los componentes vienen en el paquete
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  // Runtime incluido (instalador completo / MSIX de Microsoft Store): no debe mencionar «descargar» en absoluto.
  // La queja de los usuarios era justamente «instalé 850 MB y sigue descargando la imagen», cuando en realidad solo se descomprime la imagen del paquete
  // en la carpeta del usuario, sin internet.
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = 'Primer arranque · preparando localmente (no necesita internet)';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>Los componentes del runtime vienen incluidos en el instalador; no se descarga nada</li>',
        '<li>Descomprimiendo la imagen del sistema en tu carpeta de usuario (cerca de 1 minuto, solo una vez)</li>',
        '<li>Preparando la aceleración por hardware y el idioma</li>',
        '<li>Al terminar, haz doble clic en un APK o en un icono del escritorio para abrir la app al instante</li>',
      ].join('');
    }
  }
}).catch(() => {});

// Actualización de progreso
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

// Completado → desvanecer
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
