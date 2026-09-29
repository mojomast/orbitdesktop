import './agent-controls.css';
import './agent-inspector.css';

let inspectorSequence = 0;

/** Presentation only: registered live nodes retain their identity until disposal. */
export function createAgentInspector({ title = 'Agent inspector' }: { title?: string } = {}): {
  element: HTMLElement;
  register(id: string, label: string, content: HTMLElement): void;
  open(id: string, trigger?: HTMLElement): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
} {
  const prefix = `agent-inspector-${++inspectorSequence}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'agent-inspector';
  dialog.setAttribute('aria-labelledby', `${prefix}-title`);
  const header = document.createElement('header');
  header.className = 'agent-inspector-header';
  const heading = document.createElement('h2');
  heading.id = `${prefix}-title`;
  heading.textContent = title;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'agent-ui-icon agent-inspector-close';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Close agent inspector');
  header.append(heading, dismiss);
  const tabs = document.createElement('div');
  tabs.className = 'agent-inspector-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Inspector sections');
  const panels = document.createElement('div');
  panels.className = 'agent-inspector-panels';
  dialog.append(header, tabs, panels);
  document.body.append(dialog);
  const entries = new Map<string, { tab: HTMLButtonElement; panel: HTMLElement; content: HTMLElement }>();
  let active = '', disposed = false;
  let returnFocus: HTMLElement | undefined;

  function select(id: string, focus = false) {
    const selected = entries.get(id);
    if (!selected) return;
    active = id;
    for (const [key, { tab, panel }] of entries) {
      tab.setAttribute('aria-selected', String(key === id));
      tab.tabIndex = key === id ? 0 : -1;
      panel.hidden = key !== id;
    }
    if (focus) selected.tab.focus();
  }
  function restoreFocus() {
    const target = returnFocus;
    returnFocus = undefined;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }
  function close() {
    if (dialog.open) dialog.close();
    restoreFocus();
  }
  dismiss.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) restoreFocus(); });

  return {
    element: dialog,
    register(id, label, content) {
      if (disposed) return;
      const existing = entries.get(id);
      if (existing) {
        if (existing.content !== content) throw new Error(`Inspector section already registered: ${id}`);
        existing.tab.textContent = label;
        return;
      }
      if ([...entries.values()].some(entry => entry.content === content)) {
        throw new Error('Inspector content is already registered in another section');
      }
      const index = entries.size;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'agent-ui-ghost agent-inspector-tab';
      tab.id = `${prefix}-tab-${index}`;
      tab.textContent = label;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `${prefix}-panel-${index}`);
      const panel = document.createElement('section');
      panel.className = 'agent-inspector-panel';
      panel.id = `${prefix}-panel-${index}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = 0;
      panel.append(content);
      tab.addEventListener('click', () => select(id));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const ids = [...entries.keys()];
        const current = ids.indexOf(id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
        select(ids[next], true);
      });
      entries.set(id, { tab, panel, content });
      tabs.append(tab);
      panels.append(panel);
      select(active || id);
    },
    open(id, trigger) {
      if (disposed || !entries.has(id)) return;
      if (!dialog.open) {
        returnFocus = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
        select(id);
        dialog.showModal();
      }
      select(id, true);
    },
    close,
    isOpen: () => dialog.open,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      dialog.remove();
      entries.clear();
    },
  };
}
