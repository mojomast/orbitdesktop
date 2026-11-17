// "Connect GitHub" and "Repos to watch": wizard steps and Settings sections.
// The token is typed into a password field, sent once to the owner-only local
// API and cleared; it is never rendered, stored in the browser or logged.
import './onboarding-github.css';

import { MAX_WATCHED_REPOS, parseRepoInput, repoInputError } from './onboarding-repos-input';
export { MAX_WATCHED_REPOS, parseRepoInput, repoInputError };

export interface GithubStatus { connected: boolean; deviceFlow: boolean; revokeUrl?: string }
export interface DeviceStart { flowId: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
export interface GithubApi {
  githubStatus(): Promise<GithubStatus>;
  githubConnectToken(token: string): Promise<GithubStatus>;
  githubDeviceStart(): Promise<DeviceStart>;
  githubDevicePoll(flowId: string): Promise<GithubStatus & { pending?: boolean; interval?: number }>;
  githubDisconnect(): Promise<GithubStatus>;
  githubRepos(): Promise<{ repos: Array<{ fullName: string }> }>;
  getRepos(): Promise<{ repos: string[]; githubConnected: boolean }>;
  saveRepos(repos: string[]): Promise<{ repos: string[]; githubConnected: boolean }>;
}

export function createGithubApi(options: { basePath?: string; getToken?: () => string | null | undefined; fetchImpl?: typeof fetch } = {}): GithubApi {
  const basePath = (options.basePath ?? '/api/onboarding').replace(/\/+$/, '');
  if (!['/api/onboarding', '/api/settings'].includes(basePath)) throw new Error('Invalid setup route.');
  const request = async <T>(method: string, pathname: string, body?: unknown): Promise<T> => {
    const token = options.getToken?.();
    if (!token) throw new Error('Unlock Orbit to edit repository preferences.');
    const response = await (options.fetchImpl ?? fetch)(`${basePath}${pathname}`, {
      method,
      credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: any = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data?.ok === false) throw new Error(typeof data?.error === 'string' ? data.error : 'The GitHub request failed.');
    return data as T;
  };
  return {
    githubStatus: () => request('GET', '/github'),
    githubConnectToken: token => request('POST', '/github/token', { token }),
    githubDeviceStart: () => request('POST', '/github/device/start', {}),
    githubDevicePoll: flowId => request('POST', '/github/device/poll', { flowId }),
    githubDisconnect: () => request('POST', '/github/disconnect', {}),
    githubRepos: () => request('GET', '/github/repos'),
    getRepos: () => request('GET', '/repos'),
    saveRepos: repos => request('PUT', '/repos', { repos }),
  };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

function action(label: string, className: string, run: () => void | Promise<void>, aria?: string): HTMLButtonElement {
  const item = node('button', className, label) as HTMLButtonElement;
  item.type = 'button';
  if (aria) item.setAttribute('aria-label', aria);
  item.addEventListener('click', () => { void run(); });
  return item;
}

export interface GithubSectionOptions { api: GithubApi; notify(message: string, error?: boolean): void; heading?: 'h2' | 'h3'; onChange?(status: GithubStatus): void }

/** Connect GitHub: status, paste a token, device sign-in, disconnect. */
export function renderGithubSection(options: GithubSectionOptions): HTMLElement {
  const { api, notify } = options;
  const section = node('section', 'orbit-github-step');
  section.append(node(options.heading ?? 'h2', '', 'Connect GitHub (optional)'));
  section.append(node('p', 'orbit-github-lede', 'Optional: list repository names for local review. Orbit does not fetch contents, start monitoring, or send this selection to agents. You can skip this and enter names manually.'));
  const body = node('div', 'orbit-github-body');
  section.append(body);

  async function load() {
    try { draw(await api.githubStatus()); } catch (error) { notify(error instanceof Error ? error.message : 'GitHub status is unavailable.', true); }
  }

  function draw(status: GithubStatus) {
    body.replaceChildren();
    options.onChange?.(status);
    if (status.connected) {
      const card = node('div', 'orbit-github-card');
      card.append(node('strong', '', 'GitHub connected'));
      card.append(node('p', 'orbit-github-hint', 'The token is stored only on this machine, readable by Orbit alone (0600). It is never shown again.'));
      card.append(action('Disconnect GitHub', 'orbit-github-danger', async () => {
        try {
          const result = await api.githubDisconnect();
          notify('GitHub disconnected. To revoke the token itself, remove it in your GitHub token settings.');
          draw(result);
          if (result.revokeUrl) {
            const link = node('a', 'orbit-github-link', 'Open GitHub token settings ↗') as HTMLAnchorElement;
            link.href = result.revokeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
            body.append(link);
          }
        } catch (error) { notify(error instanceof Error ? error.message : 'GitHub could not be disconnected.', true); }
      }));
      body.append(card);
      return;
    }
    const tokenBox = node('div', 'orbit-github-card');
    tokenBox.append(node('strong', '', 'Paste a token'));
    tokenBox.append(node('p', 'orbit-github-hint', 'Use a fine-grained token limited to selected repositories and read-only metadata. Contents, pull request, Actions and write permissions are unnecessary.'));
    const label = node('label', 'orbit-github-field');
    label.append(node('span', '', 'GitHub token'));
    const input = node('input', 'orbit-github-input') as HTMLInputElement;
    input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'github_pat_… or ghp_…';
    input.setAttribute('aria-label', 'GitHub token');
    label.append(input);
    tokenBox.append(label);
    tokenBox.append(action('Connect with token', 'orbit-github-primary', async () => {
      const value = input.value.trim();
      input.value = '';
      if (!value) { notify('Paste a token first, or skip this step.', true); return; }
      try { notify('Checking the token with GitHub…'); const result = await api.githubConnectToken(value); notify('GitHub connected.'); draw(result); }
      catch (error) { notify(error instanceof Error ? error.message : 'GitHub did not accept that token.', true); }
    }));
    body.append(tokenBox);

    const device = node('div', 'orbit-github-card');
    device.append(node('strong', '', 'Or sign in with a code'));
    if (!status.deviceFlow) {
      device.append(node('p', 'orbit-github-hint', 'Device sign-in needs a GitHub OAuth app. Set ORBIT_GITHUB_CLIENT_ID on the Orbit host to enable it, or paste a token above.'));
    } else {
      const code = node('div', 'orbit-github-code');
      device.append(node('p', 'orbit-github-hint', 'Orbit shows a one-time code; you enter it on github.com. Orbit never sees your GitHub password.'));
      device.append(action('Get a sign-in code', 'orbit-github-secondary', async () => {
        try {
          const started = await api.githubDeviceStart();
          code.replaceChildren(node('span', 'orbit-github-meta', 'Enter this code on GitHub:'), node('strong', 'orbit-github-user-code', started.userCode));
          const link = node('a', 'orbit-github-link', `Open ${started.verificationUri} ↗`) as HTMLAnchorElement;
          link.href = started.verificationUri; link.target = '_blank'; link.rel = 'noopener noreferrer';
          code.append(link);
          code.append(action('Check sign-in', 'orbit-github-secondary', async () => {
            try {
              const result = await api.githubDevicePoll(started.flowId);
              if (result.pending) { notify('Waiting for authorization. Finish sign-in on GitHub, then check again.'); return; }
              notify('GitHub connected.'); draw(result);
            } catch (error) { notify(error instanceof Error ? error.message : 'GitHub sign-in did not finish.', true); }
          }));
        } catch (error) { notify(error instanceof Error ? error.message : 'GitHub sign-in could not start.', true); }
      }));
      device.append(code);
    }
    body.append(device);
  }

  void load();
  return section;
}

export interface ReposSectionOptions { api: GithubApi; notify(message: string, error?: boolean): void; heading?: 'h2' | 'h3' }
export interface ReposSectionHandle { element: HTMLElement; save(): Promise<string[]>; setConnected(value: boolean): void }

/** Repos to watch: free-text list plus picks from GitHub when connected. Empty by default. */
export function renderReposSection(options: ReposSectionOptions): ReposSectionHandle {
  const { api, notify } = options;
  const section = node('section', 'orbit-repos-step');
  section.append(node(options.heading ?? 'h2', '', 'Repos to watch'));
  section.append(node('p', 'orbit-github-lede', 'Save a local review list. Saving names does not read repository contents, enable CI or start tracking activity. Remove a name from the field to stop listing it.'));
  const label = node('label', 'orbit-github-field');
  label.append(node('span', '', 'Repositories (owner/name, one per line or comma-separated)'));
  const area = node('textarea', 'orbit-github-input orbit-repos-input') as HTMLTextAreaElement;
  area.rows = 5; area.spellcheck = false; area.placeholder = 'octo/hello-world'; area.disabled = true;
  area.setAttribute('aria-label', 'Repositories to watch');
  label.append(area);
  const error = node('p', 'orbit-github-error');
  error.setAttribute('role', 'alert');
  const picks = node('div', 'orbit-repos-picks');
  section.append(label, error, picks);
  area.addEventListener('input', () => { error.textContent = repoInputError(parseRepoInput(area.value)); });

  function addRepo(name: string) {
    const current = parseRepoInput(area.value);
    if (!current.some(item => item.toLowerCase() === name.toLowerCase())) current.push(name);
    area.value = current.join('\n');
    error.textContent = repoInputError(current);
  }

  let pickerGeneration = 0;
  function setConnected(connected: boolean) {
      const generation = ++pickerGeneration;
      picks.replaceChildren();
      if (connected) {
        picks.append(action('Choose from my GitHub repositories', 'orbit-github-secondary', async () => {
          try {
            const listed = await api.githubRepos();
            if (generation !== pickerGeneration) return;
            picks.replaceChildren(node('span', 'orbit-github-meta', listed.repos.length ? 'Select to add:' : 'GitHub returned no repositories.'));
            const list = node('div', 'orbit-repos-list');
            for (const repo of listed.repos) list.append(action(repo.fullName, 'orbit-repos-chip', () => addRepo(repo.fullName), `Watch ${repo.fullName}`));
            picks.append(list);
          } catch (failure) { notify(failure instanceof Error ? failure.message : 'GitHub repositories could not be listed.', true); }
        }));
      } else {
        picks.append(node('p', 'orbit-github-hint', 'Type repository names without connecting, or connect GitHub to list names.'));
      }
  }
  void (async () => {
    try {
      const saved = await api.getRepos();
      area.value = saved.repos.join('\n');
      area.disabled = false;
      if (!pickerGeneration) setConnected(saved.githubConnected);
    } catch (failure) { notify(failure instanceof Error ? failure.message : 'The watch list could not be loaded.', true); }
  })();

  async function save(): Promise<string[]> {
    if (area.disabled) throw new Error('Load the saved list before editing.');
    const repos = parseRepoInput(area.value);
    const problem = repoInputError(repos);
    error.textContent = problem;
    if (problem) throw new Error(problem);
    const result = await api.saveRepos(repos);
    area.value = result.repos.join('\n');
    return result.repos;
  }

  return { element: section, save, setConnected };
}
