// Browser-local navigation into existing shell controls.

import { el, button } from './dom';
import './hermes-tools.css';
import './orbit-settings.css';

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
  dialog.append(button('Done', 'Done', () => dialog.close(), 'small-button'));
  dialog.addEventListener('close', () => {
    if (openDialog === dialog) openDialog = null;
    dialog.remove();
  }, { once: true });
  openDialog = dialog;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('.orbit-settings-link')?.focus();
}
