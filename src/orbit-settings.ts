// Browser-local experiments and navigation into existing shell controls.

import { el, button } from './dom';
import './hermes-tools.css';
import './orbit-settings.css';
import { experimentalEnabled, setExperimentalFeature } from './experimental';

let openDialog: HTMLDialogElement | null = null;
export interface OrbitSettingsLink { title: string; detail: string; run: () => void | Promise<void> }
export interface OrbitSettingsNavigation { appearance?: readonly OrbitSettingsLink[]; layout?: readonly OrbitSettingsLink[] }
let shellNavigation: OrbitSettingsNavigation = {};
export function setOrbitSettingsNavigation(navigation: OrbitSettingsNavigation) { shellNavigation = navigation; }

export function showOrbitSettings(navigation: OrbitSettingsNavigation = shellNavigation): void {
  if (openDialog?.isConnected) {
    openDialog.querySelector<HTMLInputElement>('input')?.focus();
    return;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'hermes-tools-dialog orbit-settings';
  dialog.setAttribute('aria-label', 'Orbit settings');

  const head = el('div', 'orbit-settings-head');
  head.append(el('h2', '', 'Orbit settings'), button('Close', 'Close Orbit settings', () => dialog.close(), 'small-button'));

  const experimental = el('section', 'orbit-settings-section');
  experimental.append(
    el('h3', '', 'Experimental features'),
    el('p', '', 'Experimental surfaces are off until you enable them here. Enabling one only reveals its controls: it never starts work, approves execution or sends anything. Disabling it hides the surface but keeps stored tasks, candidates, results and conversations.'),
  );

  const row = el('div', 'orbit-settings-row');
  const label = el('label', 'orbit-settings-toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = experimentalEnabled('workbench');
  input.setAttribute('aria-label', 'Project Workbench (experimental)');
  const copy = el('span', 'orbit-settings-copy');
  copy.append(
    el('strong', '', 'Project Workbench'),
    el('small', '', 'Goal-first task setup, supervised native workers, candidate checks, review and results. Native execution stays separately configured and owner-approved; this switch does not configure a worker or invoke a provider.'),
  );
  label.append(input, copy);
  const toggleState = el('span', 'orbit-settings-state');
  row.append(label, toggleState);

  const note = el('p', 'orbit-settings-note');
  const sync = () => {
    toggleState.textContent = input.checked ? 'On' : 'Off';
    toggleState.dataset.on = String(input.checked);
    note.textContent = input.checked
      ? 'Enabled in this browser. Workbench controls appear in agent panes and the orbit menu.'
      : 'Off in this browser. Workbench controls stay hidden until you enable them.';
  };
  input.addEventListener('change', () => {
    setExperimentalFeature('workbench', input.checked);
    sync();
  });
  sync();
  experimental.append(row, note);

  dialog.append(head);
  for (const [title, links] of [['Appearance', navigation.appearance], ['Layout & windows', navigation.layout]] as const) {
    if (!links?.length) continue;
    const section = el('section', 'orbit-settings-section');
    section.append(el('h3', '', title));
    for (const link of links) {
      const entry = button('', link.title, () => { dialog.close(); void link.run(); }, 'orbit-settings-link');
      entry.append(el('strong', '', link.title), el('small', '', link.detail));
      section.append(entry);
    }
    dialog.append(section);
  }
  dialog.append(experimental, button('Done', 'Done', () => dialog.close(), 'small-button'));
  dialog.addEventListener('close', () => {
    if (openDialog === dialog) openDialog = null;
    dialog.remove();
  }, { once: true });
  openDialog = dialog;
  document.body.append(dialog);
  dialog.showModal();
  (dialog.querySelector<HTMLButtonElement>('.orbit-settings-link') ?? input).focus();
}
