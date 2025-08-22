// src/registerServiceWorker.js
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((reg) => {
        // Ako NOVI SW već čeka (npr. došli smo iz keša) — odmah ga aktiviraj
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        // Kad se pojavi update
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            // Kada je novi SW instaliran a postojeći tab je pod starim kontrolerom
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // odmah preskoči čekanje
              reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(() => { /* opciono logovanje */ });

    // Jednokratni auto-reload kada novi SW postane controller
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      // izbegni reload na prvom mountu (kad SW prvi put postaje controller):
      // ako nema prethodnog controller-a, to je “prvo preuzimanje”, preskoči reload
      if (!navigator.serviceWorker.controller) return;
      window.location.reload();
    });
  });
}
