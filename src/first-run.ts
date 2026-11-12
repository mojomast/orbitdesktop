/**
 * First-run setup and the Settings surfaces for orbit-config.json.
 *
 * When the host reports a first run (no agents configured or discovered and
 * nothing applied yet), the setup wizard opens full-screen over the desktop as
 * soon as this browser is connected. Settings and SSH hosts open the same way
 * from the command palette. Dark theme only; every request carries the owner
 * token and nothing here stores or logs key material.
 */
import './first-run.css';

type TokenSource = () => string;

const SKIP_KEY = 'orbit.firstRun.skipped';
let open: HTMLElement | null = null;

function shell(title: string, onClose: () => void): { overlay: HTMLElement; body: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.className = 'orbit-first-run';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  const bar = document.createElement('div');
  bar.className = 'orbit-first-run-bar';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'orbit-first-run-close';
  close.textContent = 'Continue to desktop';
  close.setAttribute('aria-label', `Close ${title}`);
  close.addEventListener('click', onClose);
  bar.append(close);
  const body = document.createElement('div');
  body.className = 'orbit-first-run-body';
  overlay.append(bar, body);
  return { overlay, body };
}

function dismiss(): void {
  open?.remove();
  open = null;
}

async function onboardingApi(token: TokenSource, basePath = '/api/onboarding') {
  const { createOnboardingApi } = await import('./onboarding');
  return createOnboardingApi({ basePath, getToken: token });
}

/** Open the setup wizard full-screen. */
export async function openSetupWizard(token: TokenSource): Promise<void> {
  dismiss();
  const { mountOnboarding } = await import('./onboarding');
  let handle: { close(): void } | null = null;
  const { overlay, body } = shell('Orbit setup', () => { try { sessionStorage.setItem(SKIP_KEY, '1'); } catch { /* storage optional */ } handle?.close(); dismiss(); });
  document.body.append(overlay);
  open = overlay;
  const { createGithubApi } = await import('./onboarding-github');
  handle = mountOnboarding(body, await onboardingApi(token), createGithubApi({ basePath: '/api/onboarding', getToken: token }));
}

/** Open Settings (components, providers and keys, models per role, router). */
export async function openSetupSettings(token: TokenSource): Promise<void> {
  dismiss();
  const { mountSettings } = await import('./settings');
  let handle: { close(): void } | null = null;
  const { overlay, body } = shell('Orbit settings', () => { handle?.close(); dismiss(); });
  document.body.append(overlay);
  open = overlay;
  const { createGithubApi } = await import('./onboarding-github');
  handle = mountSettings(body, await onboardingApi(token), createGithubApi({ basePath: '/api/settings', getToken: token }));
}

/** Open the SSH hosts manager. */
export async function openSshHosts(token: TokenSource): Promise<void> {
  dismiss();
  const { mountHosts } = await import('./hosts');
  let handle: { dispose(): void } | null = null;
  const { overlay, body } = shell('SSH hosts', () => { handle?.dispose(); dismiss(); });
  document.body.append(overlay);
  open = overlay;
  handle = mountHosts(body, { token });
}

/** True when the host says this is a first run. Never throws. */
export async function isFirstRun(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const response = await fetch('/api/onboarding/state', { headers: { Authorization: `Bearer ${token}` }, credentials: 'same-origin' });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.firstRun === true;
  } catch {
    return false;
  }
}

/** Show the wizard on connect while the host reports a first run. */
export function initFirstRun(token: TokenSource): void {
  const check = async () => {
    let skipped = false;
    try { skipped = sessionStorage.getItem(SKIP_KEY) === '1'; } catch { skipped = false; }
    if (skipped || open) return;
    // Browser automation (navigator.webdriver) drives the desktop directly, so the
    // wizard only opens on its own for people; `?setup=1` forces it for tests.
    const forced = new URLSearchParams(location.search).get('setup') === '1';
    if (navigator.webdriver && !forced) return;
    if (await isFirstRun(token())) await openSetupWizard(token);
  };
  window.addEventListener('orbit-host-connected', () => { void check(); });
  void check();
}
