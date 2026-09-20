// Swap built styles without replacing the document, terminals, or chat state.
export function watchStyles() {
  let busy = false;
  const timer = window.setInterval(async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await fetch('/?orbit_styles', { cache: 'no-store' });
      if (!response.ok) return;
      const html = new DOMParser().parseFromString(await response.text(), 'text/html');
      const incoming = Array.from(html.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
      const current = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]:not([data-loading])'));
      for (let i = 0; i < incoming.length; i++) {
        const url = new URL(incoming[i].getAttribute('href')!, location.origin);
        const old = current[i];
        if (url.origin !== location.origin || old?.href === url.href) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = url.href; link.dataset.loading = 'true';
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => { link.remove(); resolve(); }, 10000);
          link.onload = () => { clearTimeout(timeout); old?.remove(); delete link.dataset.loading; resolve(); };
          link.onerror = () => { clearTimeout(timeout); link.remove(); resolve(); };
          document.head.append(link);
        });
      }
    } catch { /* Retry on the next tick, including during a build. */ }
    finally { busy = false; }
  }, 1500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
