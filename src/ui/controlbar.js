'use strict';
/* Botones de la barra de controles flotante: usan los mismos canales que la barra de título del modo incrustado */
(() => {
  const api = window.lanzadorapk && window.lanzadorapk.shell;
  if (!api) return;
  const acts = {
    back: () => api.back(),
    home: () => api.nav('home'),
    recents: () => api.nav('recents'),
    screenshot: () => api.screenshot(),
    rotate: () => api.rotate(),
    maximize: () => api.maximize(),
    minimize: () => api.minimize(),
    close: () => api.close(),
  };
  document.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const fn = acts[btn.dataset.act];
      if (!fn || btn.classList.contains('busy')) return;
      btn.classList.add('busy');
      try { await fn(); } catch (_) { /* el proceso principal ya registra el error */ }
      btn.classList.remove('busy');
    });
  });
})();
