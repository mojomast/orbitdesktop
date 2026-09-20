import type { Monitor } from './model';

export function placeWindow(element: HTMLElement, m: Monitor, host: HTMLElement, index: number) {
  if (!m.frame) m.frame = { x: 24 + index * 64, y: 18 + index * 42, width: Math.max(320, Math.min(740, host.clientWidth - 60)), height: Math.max(220, Math.min(510, host.clientHeight - 90)), z: index + 1 };
  const f = m.frame;
  // Keep the title bar reachable after viewport/sidebar changes.
  f.x = Math.max(0, Math.min(f.x, Math.max(0, host.clientWidth - 120)));
  f.y = Math.max(0, Math.min(f.y, Math.max(0, host.clientHeight - 48)));
  Object.assign(element.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.width}px`, height: `${f.height}px`, zIndex: String(f.z), transform: 'none' });
}

export function wireWindow(element: HTMLElement, bar: HTMLElement, handle: HTMLElement, m: Monitor, host: HTMLElement, enabled: () => boolean, changed: () => void) {
  const bind = (target: HTMLElement, resize: boolean) => {
    let start: { x: number; y: number; frame: NonNullable<Monitor['frame']> } | null = null;
    target.addEventListener('pointerdown', e => {
      if (!enabled() || e.button !== 0 || (!resize && (e.target as HTMLElement).closest('button,select,input'))) return;
      if (!m.frame) return;
      start = { x: e.clientX, y: e.clientY, frame: { ...m.frame } };
      target.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
      document.body.classList.add('window-dragging');
    });
    target.addEventListener('pointermove', e => {
      if (!start || !m.frame) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (resize) {
        m.frame.width = Math.max(320, Math.min(4000, start.frame.width + dx));
        m.frame.height = Math.max(220, Math.min(4000, start.frame.height + dy));
      } else {
        m.frame.x = Math.max(0, Math.min(host.clientWidth - 120, start.frame.x + dx));
        m.frame.y = Math.max(0, Math.min(host.clientHeight - 48, start.frame.y + dy));
      }
      placeWindow(element, m, host, 0);
    });
    const finish = () => { if (!start) return; start = null; document.body.classList.remove('window-dragging'); changed(); };
    target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', finish);
    target.addEventListener('lostpointercapture', finish);
    target.addEventListener('keydown', e => {
      if (!enabled() || !m.frame || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
      e.preventDefault(); const d = e.shiftKey ? 40 : 10;
      if (resize) { m.frame.width = Math.max(320, Math.min(4000, m.frame.width + (e.key === 'ArrowRight' ? d : e.key === 'ArrowLeft' ? -d : 0))); m.frame.height = Math.max(220, Math.min(4000, m.frame.height + (e.key === 'ArrowDown' ? d : e.key === 'ArrowUp' ? -d : 0))); }
      else { m.frame.x = Math.max(0, m.frame.x + (e.key === 'ArrowRight' ? d : e.key === 'ArrowLeft' ? -d : 0)); m.frame.y = Math.max(0, m.frame.y + (e.key === 'ArrowDown' ? d : e.key === 'ArrowUp' ? -d : 0)); }
      placeWindow(element, m, host, 0); changed();
    });
  };
  bar.tabIndex = 0; bar.setAttribute('aria-label', `Move ${m.name}`);
  handle.tabIndex = 0; handle.setAttribute('role', 'button'); handle.setAttribute('aria-label', `Resize ${m.name}`);
  bind(bar, false); bind(handle, true);
}
