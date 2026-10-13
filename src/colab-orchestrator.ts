/** Google Colab window for colab.research.google.com. This is not the project board. */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './colab-orchestrator.css';
import { el, button } from './dom';

type Runtime = { id: string; kind: string; label: string; highMem: boolean; note: string; source: string };
type Session = { name: string; orphan?: boolean; hardware: string; shape: string; variant: string; status: string };
type Rich = { id: string; kind: string; mime: string; name: string };
type Progress = { percent: number | null; stage: string; step: number | null; total: number | null; loss: number | null; eta: string; gpuMemory: string; losses: Array<{ step: number; loss: number }> };
type Job = { id: string; action: string; session: string; state: string; exitCode: number | null; startedAt?: string; endedAt?: string | null; bytes: number; error: string; rich: Rich[]; truncated?: boolean; label?: string; remote?: boolean; progress?: Progress };
type Usage = { balance: number | null; ratePerHour: number | null; assignments: number | null; raw: string };

export function mountColab(options: { token: () => string; request: (body: Record<string, unknown>) => Promise<Record<string, unknown>> }) {
  const root = el('section', 'colab-app');
  const usage = el('p', 'colab-usage', 'Compute units…');
  usage.setAttribute('role', 'status');
  const status = el('p', 'colab-status', '');
  status.setAttribute('role', 'status');
  const head = el('div', 'colab-head');
  head.append(el('h2', '', 'Google Colab'), usage);
  const grid = el('div', 'colab-grid');
  const side = el('div', 'colab-side');
  const main = el('div', 'colab-main');
  grid.append(side, main);
  root.append(head, status, grid);

  let disposed = false;
  let runtimes: Runtime[] = [];
  let sessions: Session[] = [];
  let selected = '';
  let costWarning = 'Creating a session rents a billed Colab VM until you stop it.';
  let stopWarning = 'Stopping releases the VM.';
  let suggested = 'G4';
  let usageInfo: Usage | null = null;
  let followGen = 0;
  let jobs: Job[] = [];
  let jobScope: 'session' | 'all' = 'session';
  let attachedJob = '';
  let activeJob = '';
  let userPickedSession = false;
  const knownJobIds = new Set<string>();
  const jobStates = new Map<string, string>();
  const jobsList = el('div', 'colab-jobs');
  jobsList.setAttribute('aria-label', 'Google Colab jobs');
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  const seenRich = new Set<string>();

  const nameInput = el('input');
  nameInput.value = 'trainer';
  nameInput.maxLength = 41;
  nameInput.setAttribute('aria-label', 'Session name');
  const runtimeSelect = el('select');
  runtimeSelect.setAttribute('aria-label', 'Accelerator');
  const highMem = el('input');
  highMem.type = 'checkbox';
  highMem.setAttribute('aria-label', 'Request high memory');
  const confirmCost = el('input');
  confirmCost.type = 'checkbox';
  confirmCost.setAttribute('aria-label', 'Confirm compute-unit spend');
  const warning = el('p', 'colab-warning', costWarning);
  const runtimeNote = el('p', 'colab-note', '');
  const sessionList = el('ul', 'colab-sessions');

  function currentRuntime() {
    return runtimes.find(runtime => runtime.id === runtimeSelect.value) || runtimes[0];
  }
  function syncRuntimeNote() {
    const runtime = currentRuntime();
    highMem.disabled = !runtime?.highMem;
    if (!runtime?.highMem) highMem.checked = false;
    runtimeNote.textContent = runtime ? [runtime.note, runtime.source === 'cli' ? 'Reported by the Colab CLI.' : 'Documented CLI runtime.'].filter(Boolean).join(' ') : '';
  }
  function fillRuntimes() {
    const previous = runtimeSelect.value;
    runtimeSelect.replaceChildren();
    for (const runtime of runtimes) {
      const option = el('option', '', `${runtime.label}${runtime.kind === 'cpu' ? '' : ` · ${runtime.kind.toUpperCase()}`}`);
      option.value = runtime.id;
      runtimeSelect.append(option);
    }
    runtimeSelect.value = runtimes.some(runtime => runtime.id === previous) ? previous : (runtimes[0]?.id || '');
    syncRuntimeNote();
  }
  function renderSessions() {
    sessionList.replaceChildren();
    if (!sessions.length) sessionList.append(el('li', 'colab-note', 'No active sessions.'));
    for (const session of sessions) {
      const label = session.orphan ? `Unnamed · ${session.hardware}` : `${session.name} · ${session.hardware} · ${session.shape}${session.status ? ` · ${session.status}` : ''}`;
      const item = button(label, `Select ${session.name || 'session'}`, () => {
      userPickedSession = true;
      selected = session.name;
      renderSessions();
      renderMain();
      const newest = jobs.filter(job => job.state === 'running' && job.session === selected).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
      if (newest && newest.id !== attachedJob) { attachedJob = newest.id; activeJob = newest.id; tab = 'run'; renderTabs(); void follow(newest.id); }
    });
      if (session.name && session.name === selected) item.setAttribute('aria-current', 'true');
      if (!session.name) item.disabled = true;
      sessionList.append(el('li', '', '') );
      sessionList.lastElementChild?.append(item);
    }
  }

  const create = button('Create session', 'Allocate a Colab VM', () => { void createSession(); });
  const refresh = button('Refresh', 'Refresh usage and sessions', () => { void refreshAll(); }, 'small-button');
  const discover = button('Read CLI runtimes', 'Ask colab help which accelerators this install accepts', () => { void discoverRuntimes(); }, 'small-button');
  const useG4 = button('Use suggested G4', 'Select the G4 runtime suggested for a 96GB training job', () => {
    if (runtimes.some(runtime => runtime.id === suggested)) runtimeSelect.value = suggested;
    syncRuntimeNote();
  }, 'small-button');

  const createCard = el('form', 'colab-card');
  createCard.append(
    el('h3', '', 'New session'),
    field('Name', nameInput),
    field('Runtime', runtimeSelect),
    runtimeNote,
    checkRow(highMem, 'High memory, when this runtime offers it'),
    warning,
    checkRow(confirmCost, 'I understand this spends compute units until I stop the session'),
    create,
    el('div', 'colab-row', ''),
  );
  createCard.querySelector('.colab-row')?.append(discover, useG4);
  createCard.addEventListener('submit', event => event.preventDefault());
  side.append(createCard, el('h3', '', 'Active sessions'), sessionList);

  const detail = el('div', 'colab-card');
  const tabs = el('div', 'colab-tabs');
  const panel = el('div', 'colab-main');
  let tab: 'run' | 'files' | 'gpu' | 'logs' = 'run';
  main.append(detail, tabs, panel);

  function setStatus(text: string) { if (!disposed) status.textContent = text; }
  async function call(body: Record<string, unknown>) {
    return options.request(body);
  }
  async function refreshAll() {
    const [usageBody, sessionBody, caps] = await Promise.all([
      call({ action: 'usage' }).catch((error): Record<string, unknown> => ({ error: String(error instanceof Error ? error.message : error) })),
      call({ action: 'sessions' }).catch((error): Record<string, unknown> => ({ error: String(error instanceof Error ? error.message : error) })),
      runtimes.length ? Promise.resolve(null) : call({ action: 'capabilities' }),
    ]);
    if (disposed) return;
    if (caps && Array.isArray(caps.runtimes)) applyCaps(caps);
    const parsed = usageBody.usage as Usage | undefined;
    usageInfo = parsed || null;
    usage.textContent = parsed?.balance === null || parsed?.balance === undefined
      ? `Usage unavailable${usageBody.error ? `: ${usageBody.error}` : ''}`
      : `Balance ${parsed.balance} CU · ${parsed.ratePerHour}/hr · ${parsed.assignments} active`;
    sessions = Array.isArray(sessionBody.sessions) ? sessionBody.sessions as Session[] : sessions;
    if (!selected || !sessions.some(session => session.name === selected)) selected = sessions.find(session => session.name)?.name || '';
    renderSessions();
    renderMain();
  }
  function applyCaps(caps: Record<string, unknown>) {
    runtimes = Array.isArray(caps.runtimes) ? caps.runtimes as Runtime[] : runtimes;
    if (typeof caps.costWarning === 'string') { costWarning = caps.costWarning; warning.textContent = costWarning; }
    if (typeof caps.stopWarning === 'string') stopWarning = caps.stopWarning;
    const presets = Array.isArray(caps.presets) ? caps.presets as Array<{ suggestedAccelerator?: string }> : [];
    if (presets[0]?.suggestedAccelerator) suggested = presets[0].suggestedAccelerator;
    fillRuntimes();
  }
  async function discoverRuntimes() {
    setStatus('Reading colab help…');
    try {
      const body = await call({ action: 'discover' });
      applyCaps(body);
      setStatus(body.discovered ? `CLI runtimes loaded${body.version ? ` · ${body.version}` : ''}.` : 'CLI help did not list runtimes. Showing the documented set.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not read the Colab CLI.'); }
  }
  async function createSession() {
    if (!confirmCost.checked) { setStatus('Confirm the compute-unit warning before creating a session.'); return; }
    const runtime = currentRuntime();
    if (!runtime) { setStatus('Choose a runtime.'); return; }
    setStatus(`Allocating ${runtime.label}…`);
    try {
      await call({ action: 'create', session: nameInput.value.trim(), accelerator: runtime.id, high_mem: highMem.checked, confirm_cost: true });
      confirmCost.checked = false;
      selected = nameInput.value.trim();
      setStatus(`${selected} is ready. It keeps spending compute units until you stop it.`);
      await refreshAll();
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Create failed.'); }
  }

  function renderMain() {
    const session = sessions.find(item => item.name === selected);
    detail.replaceChildren(el('h3', '', session ? session.name : 'No session selected'));
    if (!session) {
      detail.append(el('p', 'colab-note', 'Create a session or refresh the list. Jobs that are already running are listed below.'));
      renderTabs();
      return;
    }
    detail.append(el('p', 'colab-note', `${session.hardware} · ${session.shape} · ${session.variant}${session.status ? ` · ${session.status}` : ''}`));
    const row = el('div', 'colab-row');
    row.append(
      button('Open live URL', 'Print the colab url for this session', () => { void openUrl(); }),
      button('GPU stats', 'Query nvidia-smi through the session console', () => { tab = 'gpu'; renderTabs(); void loadGpu(); }),
      button('Stop session', 'Stop and release this VM', () => confirmStop()),
      button('Restart kernel', 'Restart the Jupyter kernel and keep the VM', () => { void simple('restart-kernel', 'Kernel restarted.'); }),
    );
    detail.append(row);
    renderTabs();
  }
  function renderTabs() {
    tabs.replaceChildren();
    for (const item of [['run', 'Run'], ['files', 'Files'], ['gpu', 'GPU'], ['logs', 'History']] as const) {
      const control = button(item[1], item[1], () => { tab = item[0]; renderTabs(); });
      control.setAttribute('aria-selected', String(tab === item[0]));
      tabs.append(control);
    }
    if (tab === 'run') renderRun();
    else if (tab === 'files') renderFiles();
    else if (tab === 'gpu') renderGpu();
    else renderLogs();
  }

  const jobLabelInput = el('input');
  jobLabelInput.maxLength = 80;
  jobLabelInput.placeholder = 'Optional name shown in Jobs';
  jobLabelInput.setAttribute('aria-label', 'Job label');
  const mode = el('select');
  for (const [value, label] of [['exec', 'Execute script or notebook'], ['code', 'Execute pasted code'], ['run', 'One-shot colab run'], ['repl', 'Python REPL'], ['console', 'Shell console'], ['install', 'Install packages'], ['drivemount', 'Mount Drive'], ['vm-auth', 'VM Google auth'], ['train', 'Training run']]) {
    const option = el('option', '', label);
    option.value = value;
    mode.append(option);
  }
  mode.setAttribute('aria-label', 'Run mode');
  const filePath = el('input');
  filePath.placeholder = 'Host path to .py or .ipynb';
  filePath.setAttribute('aria-label', 'Local script path');
  const code = el('textarea');
  code.rows = 6;
  code.placeholder = 'Or paste Python / notebook JSON';
  code.setAttribute('aria-label', 'Code');
  const packages = el('input');
  packages.placeholder = 'torch transformers peft';
  packages.setAttribute('aria-label', 'Packages');
  const timeout = el('input');
  timeout.type = 'number';
  timeout.value = '3600';
  timeout.min = '1';
  timeout.max = '86400';
  timeout.setAttribute('aria-label', 'Quiet timeout seconds');
  const uploads = el('textarea');
  uploads.rows = 3;
  uploads.placeholder = '/local/data.jsonl /content/data.jsonl';
  uploads.setAttribute('aria-label', 'Uploads, one local and remote path per line');
  const trainConfirm = el('input');
  trainConfirm.type = 'checkbox';
  const richHost = el('div', 'colab-rich');
  const termHost = el('div', 'colab-term');
  const progressHost = el('div', 'colab-progress');
  progressHost.hidden = true;
  let termReady = false;

  function ensureTerm() {
    if (termReady) return;
    term = new Terminal({
      fontFamily: '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 30000,
      convertEol: false,
      theme: { background: '#10191e', foreground: '#d5e2df', cursor: '#c2ed90', selectionBackground: '#41544d' },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    requestAnimationFrame(() => { try { fit?.fit(); } catch { /* hidden */ } });
    termReady = true;
  }
  function renderRun() {
    ensureTerm();
    const form = el('form', 'colab-card');
    form.addEventListener('submit', event => event.preventDefault());
    form.append(
      el('h3', '', 'Run'),
      field('Label', jobLabelInput),
      field('Mode', mode),
      field('Host file', filePath),
      field('Code', code),
      field('Packages', packages),
      field('Uploads for a training run (local remote)', uploads),
      field('Quiet timeout (seconds). Output keeps the CLI alive; a long silent stretch still needs a higher value.', timeout),
      el('p', 'colab-warning', 'One-shot run and training allocate a new billed VM. Execution on an existing session does not.'),
      checkRow(trainConfirm, 'Confirm compute-unit spend for run or training'),
      el('div', 'colab-row'),
    );
    form.querySelector('.colab-row')?.append(
      button('Start', 'Start this Colab operation', () => { void startRun(); }),
      button('Send Enter', 'Continue a Drive mount or VM auth prompt', () => { void sendEnter(); }, 'small-button'),
      button('Cancel job', 'Stop the local process and interrupt the remote kernel.', () => { void cancelJob(); }, 'small-button'),
    );
    panel.replaceChildren(jobsList, form, progressHost, termHost, richHost);
    renderProgress(jobs.find(job => job.id === activeJob));
  }
  async function startRun() {
    if (!selected && mode.value !== 'run' && mode.value !== 'train') { setStatus('Select a session first.'); return; }
    ensureTerm();
    const timeoutValue = Number(timeout.value || 3600);
    const packageList = packages.value.split(/\s+/).filter(Boolean);
    const body: Record<string, unknown> = { action: mode.value, session: selected || nameInput.value.trim(), timeout: timeoutValue };
    if (jobLabelInput.value.trim()) body.label = jobLabelInput.value.trim();
    if (filePath.value.trim()) body.file = filePath.value.trim();
    if (code.value.trim()) body.code = code.value;
    if (mode.value === 'repl') body.code = code.value;
    if (mode.value === 'console') body.command = code.value;
    if (mode.value === 'install') body.packages = packageList;
    if (mode.value === 'run' || mode.value === 'train') {
      if (!trainConfirm.checked) { setStatus('Confirm the compute-unit warning first.'); return; }
      body.confirm_cost = true;
      body.accelerator = currentRuntime()?.id || 'cpu';
      body.high_mem = highMem.checked;
      body.script = filePath.value.trim();
      body.packages = packageList;
      body.uploads = uploads.value.split(/\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const parts = line.split(/\s+/);
        return { local: parts[0], remote: parts[1] || '' };
      });
      if (mode.value === 'train') body.script = filePath.value.trim();
    }
    if (mode.value === 'drivemount') body.path = filePath.value.trim() || '/content/drive';
    setStatus('Starting…');
    try {
      const result = await call(body);
      const job = result.job as Job | undefined;
      if (job?.id) { activeJob = job.id; attachedJob = job.id; knownJobIds.add(job.id); setStatus(`Job ${job.id} is running.`); void follow(job.id); void pollJobs(); }
      else setStatus(typeof result.output === 'string' ? result.output : 'Finished.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Start failed.'); }
  }
  async function follow(jobId: string) {
    const generation = ++followGen;
    seenRich.clear();
    richHost.replaceChildren();
    term?.reset();
    let after = 0;
    while (generation === followGen && !disposed) {
      try {
        const response = await fetch(`/api/colab-runtime/stream?job=${encodeURIComponent(jobId)}&after=${after}`, {
          headers: { Authorization: `Bearer ${options.token()}`, Accept: 'text/event-stream' },
        });
        if (!response.ok || !response.body) throw Error(`Stream failed (${response.status}).`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const step = await reader.read();
          if (generation !== followGen || disposed) { await reader.cancel(); return; }
          if (step.done) break;
          buffer += decoder.decode(step.value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() || '';
          for (const block of chunks) after = applySse(block, after);
        }
        const job = (await call({ action: 'job', job_id: jobId })).job as Job;
        if (job.state !== 'running') { setStatus(job.error || `Job ${job.state}${job.exitCode !== null ? ` (${job.exitCode})` : ''}.`); break; }
      } catch (error) {
        if (generation !== followGen || disposed) return;
        setStatus(error instanceof Error ? error.message : 'Stream interrupted. Reconnecting…');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  function applySse(block: string, after: number) {
    if (!block || block.startsWith(':')) return after;
    let event = 'message';
    let next = after;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) next = Number(line.slice(3).trim()) || next;
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return next;
    const payload = JSON.parse(data.join('\n'));
    if (event === 'data' && typeof payload.text === 'string') term?.write(payload.text);
    if (event === 'rich') void showRich(String(payload.id || ''), String(payload.kind || ''), String(payload.mime || ''));
    if (event === 'status') {
      setStatus(payload.error || `Job ${payload.state}.`);
      if (payload.progress) renderProgress(payload as Job);
    }
    if (event === 'error') setStatus(payload.error || 'Stream interrupted.');
    return next || after;
  }
  async function showRich(id: string, kind: string, mime: string) {
    if (!id || seenRich.has(id) || !activeJob) return;
    seenRich.add(id);
    const response = await fetch(`/api/colab-runtime/artifact/${activeJob}/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${options.token()}` } });
    if (!response.ok) return;
    if (kind === 'image' || mime.startsWith('image/')) {
      const blob = await response.blob();
      const image = el('img');
      image.alt = 'Notebook display output';
      image.src = URL.createObjectURL(blob);
      richHost.append(image);
      return;
    }
    if (kind === 'html') {
      const html = await response.text();
      const frame = el('iframe');
      frame.setAttribute('sandbox', '');
      frame.srcdoc = html;
      frame.title = 'Notebook HTML output';
      richHost.append(frame);
    }
  }
  async function sendEnter() {
    if (!activeJob) return;
    await call({ action: 'job-input', job_id: activeJob, text: '\n' });
  }
  async function cancelJob() {
    if (!activeJob) return;
    await call({ action: 'cancel', job_id: activeJob, confirm: true });
  }

  function renderFiles() {
    const remote = el('input');
    remote.value = '/content';
    remote.setAttribute('aria-label', 'Remote path');
    const listing = el('div', 'colab-files');
    const editor = el('textarea');
    editor.rows = 8;
    editor.setAttribute('aria-label', 'Remote file text');
    const picker = el('input');
    picker.type = 'file';
    picker.setAttribute('aria-label', 'File to upload');
    const hostFile = el('input');
    hostFile.placeholder = 'Host path to upload';
    hostFile.setAttribute('aria-label', 'Host path to upload');
    const box = el('div', 'colab-card');
    const row = el('div', 'colab-row');
    row.append(
      button('List', 'List the remote path', () => { void listRemote(remote.value, listing); }),
      button('Download', 'Download the remote file through Orbit', () => { void downloadRemote(remote.value); }),
      button('Load text', 'Download the remote file into the editor', () => { void loadText(remote.value, editor); }),
      button('Save text', 'Upload the editor text', () => { void saveText(remote.value, editor.value); }),
      button('Upload host path', 'Upload a file that is already on this host', () => { void uploadHost(hostFile.value, remote.value); }),
      button('Upload chosen file', 'Upload the selected browser file', () => { void uploadBrowser(picker.files?.[0] || null, remote.value); }),
      button('Delete', 'Delete the remote path', () => { void removeRemote(remote.value); }),
    );
    box.append(el('h3', '', 'Files'), field('Remote path', remote), row, field('Host path', hostFile), field('Browser file', picker), listing, field('Editor', editor));
    panel.replaceChildren(box);
  }
  async function listRemote(target: string, listing: HTMLElement) {
    const body = await call({ action: 'ls', session: selected, path: target });
    const entries = Array.isArray(body.entries) ? body.entries as Array<{ name: string; directory: boolean }> : [];
    listing.replaceChildren(...entries.map(entry => el('div', '', entry.directory ? `${entry.name}/` : entry.name)));
    if (!entries.length) listing.append(el('p', 'colab-note', body.error ? String(body.error) : 'Empty.'));
  }
  async function downloadRemote(target: string) {
    const body = await call({ action: 'download', session: selected, remote: target });
    const response = await fetch(`/api/colab-runtime/file/${encodeURIComponent(selected)}/${encodeURIComponent(String(body.file || ''))}`, { headers: { Authorization: `Bearer ${options.token()}` } });
    if (!response.ok) throw Error('Download failed.');
    const blob = await response.blob();
    const link = el('a');
    link.href = URL.createObjectURL(blob);
    link.download = String(body.name || 'download');
    link.click();
    setStatus(`Downloaded ${body.name}.`);
  }
  async function loadText(target: string, editor: HTMLTextAreaElement) {
    const body = await call({ action: 'read', session: selected, path: target });
    editor.value = String(body.text || '');
    setStatus(body.binary ? 'File looks binary; text may be incomplete.' : 'Loaded remote text.');
  }
  async function saveText(target: string, text: string) {
    if (!window.confirm('Upload this text and replace the remote file?')) return;
    await call({ action: 'write', session: selected, path: target, text, confirm: true });
    setStatus('Uploaded editor text.');
  }
  async function uploadHost(local: string, remote: string) {
    await call({ action: 'upload', session: selected, local_path: local, remote });
    setStatus('Uploaded host file.');
  }
  async function uploadBrowser(file: File | null, remote: string) {
    if (!file) { setStatus('Choose a file first.'); return; }
    const response = await fetch('/api/colab-runtime/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token()}`,
        'Content-Type': 'application/octet-stream',
        'X-Colab-Session': selected,
        'X-Colab-Remote': remote.endsWith('/') ? `${remote}${file.name}` : remote,
        'X-Colab-Filename': file.name,
      },
      body: file,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error || 'Upload failed.');
    setStatus(`Uploaded ${file.name}.`);
  }
  async function removeRemote(target: string) {
    if (!window.confirm(`Delete ${target} on the Colab VM?`)) return;
    await call({ action: 'rm', session: selected, path: target, confirm: true });
    setStatus('Deleted remote path.');
  }

  const gpuHost = el('div', 'colab-card');
  function renderGpu() {
    gpuHost.replaceChildren(el('h3', '', 'GPU'), el('p', 'colab-note', 'Queried with nvidia-smi on the session console, so it can run beside a kernel execution. CPU and TPU sessions have no NVIDIA GPU.'));
    panel.replaceChildren(gpuHost);
    void loadGpu();
  }
  async function loadGpu() {
    if (!selected) return;
    try {
      const body = await call({ action: 'gpu', session: selected });
      const gpus = Array.isArray(body.gpus) ? body.gpus as Array<{ name: string; utilization: number; memoryUsedMiB: number; memoryTotalMiB: number; temperature: number | null }> : [];
      const rows = gpus.map(gpu => {
        const card = el('div', '');
        const meter = el('div', 'colab-meter');
        const fill = el('span');
        fill.style.width = `${Math.max(0, Math.min(100, gpu.utilization))}%`;
        meter.append(fill);
        card.append(el('strong', '', gpu.name), el('p', 'colab-note', `${gpu.utilization}% · ${gpu.memoryUsedMiB}/${gpu.memoryTotalMiB} MiB${gpu.temperature !== null ? ` · ${gpu.temperature}°C` : ''}`), meter);
        return card;
      });
      gpuHost.replaceChildren(el('h3', '', 'GPU'), ...(rows.length ? rows : [el('p', 'colab-note', 'No NVIDIA GPU reported.')]));
    } catch (error) { gpuHost.append(el('p', 'colab-note', error instanceof Error ? error.message : 'GPU stats unavailable.')); }
  }

  function renderLogs() {
    const lines = el('input');
    lines.type = 'number';
    lines.value = '40';
    lines.setAttribute('aria-label', 'History lines');
    const output = el('pre', 'colab-files');
    const box = el('div', 'colab-card');
    const row = el('div', 'colab-row');
    row.append(
      button('Show history', 'Show recent colab log events', () => { void showLog(lines.value, output); }),
      button('Export notebook', 'Export session history as an ipynb', () => { void exportLog('ipynb'); }),
      button('Export JSONL', 'Export session history as jsonl', () => { void exportLog('jsonl'); }),
    );
    box.append(el('h3', '', 'Session history'), field('Lines', lines), row, output);
    panel.replaceChildren(box);
  }
  async function showLog(count: string, output: HTMLElement) {
    const body = await call({ action: 'log', session: selected, lines: Number(count) });
    output.textContent = String(body.output || '');
  }
  async function exportLog(format: string) {
    const body = await call({ action: 'log', session: selected, format });
    const response = await fetch(`/api/colab-runtime/file/exports/${encodeURIComponent(String(body.file || ''))}`, { headers: { Authorization: `Bearer ${options.token()}` } });
    if (!response.ok) throw Error('Export failed.');
    const blob = await response.blob();
    const link = el('a');
    link.href = URL.createObjectURL(blob);
    link.download = String(body.name || `history.${format}`);
    link.click();
  }

  async function openUrl() {
    const body = await call({ action: 'url', session: selected });
    const url = String(body.url || '');
    if (url.startsWith('https://')) window.open(url, '_blank', 'noopener,noreferrer');
    setStatus(url);
  }
  async function simple(action: string, message: string) {
    await call({ action, session: selected });
    setStatus(message);
    await refreshAll();
  }
  function confirmStop() {
    const dialog = el('dialog', 'colab-dialog');
    dialog.append(el('p', '', `${stopWarning} Session: ${selected}.`));
    const row = el('div', 'colab-row');
    row.append(
      button('Stop VM', 'Release this Colab VM', () => { dialog.close(); void stopSession(); }),
      button('Keep it', 'Leave the session running', () => dialog.close(), 'small-button'),
    );
    dialog.append(row);
    root.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove());
  }
  async function stopSession() {
    await call({ action: 'stop', session: selected, confirm_stop: true });
    setStatus(`${selected} stopped.`);
    await refreshAll();
  }

  function progressSummary(progress: Progress | undefined) {
    if (!progress) return '';
    return [
      progress.stage,
      progress.percent !== null && progress.percent !== undefined ? `${progress.percent}%` : '',
      progress.step !== null && progress.step !== undefined ? `step ${progress.step}${progress.total ? `/${progress.total}` : ''}` : '',
      progress.loss !== null && progress.loss !== undefined ? `loss ${progress.loss}` : '',
      progress.eta ? `ETA ${progress.eta}` : '',
      progress.gpuMemory ? `GPU ${progress.gpuMemory}` : '',
    ].filter(Boolean).join(' · ');
  }
  function renderProgress(job: Job | undefined) {
    const progress = job?.progress;
    const summary = progressSummary(progress);
    if (!progress || !summary) {
      progressHost.replaceChildren();
      progressHost.hidden = true;
      return;
    }
    progressHost.hidden = false;
    const meter = el('div', 'colab-meter');
    const fill = el('span');
    fill.style.width = `${Math.max(0, Math.min(100, progress.percent ?? 0))}%`;
    meter.append(fill);
    progressHost.replaceChildren(el('p', 'colab-note', summary), meter);
    const losses = progress.losses || [];
    if (losses.length >= 2) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 240 64');
      svg.setAttribute('class', 'colab-loss');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Loss chart');
      const min = Math.min(...losses.map(point => point.loss));
      const max = Math.max(...losses.map(point => point.loss));
      const span = max - min || 1;
      const points = losses.map((point, index) => {
        const x = (index / (losses.length - 1)) * 240;
        const y = 60 - ((point.loss - min) / span) * 56;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('points', points);
      svg.append(line);
      progressHost.append(svg);
    }
  }
  function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  function stamp(value: string | null | undefined) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }
  function renderJobs() {
    const visible = jobs.filter(job => jobScope === 'all' || !selected || job.session === selected);
    const scope = el('div', 'colab-row');
    const sessionButton = button('This session', 'Show jobs for the selected session', () => { jobScope = 'session'; renderJobs(); });
    const allButton = button('All jobs', 'Show jobs for every session', () => { jobScope = 'all'; renderJobs(); });
    sessionButton.setAttribute('aria-pressed', String(jobScope === 'session'));
    allButton.setAttribute('aria-pressed', String(jobScope === 'all'));
    scope.append(sessionButton, allButton);
    const rows = visible.length ? visible.map(job => {
      const control = button('', `${job.action} ${job.state} ${job.id}`, () => {
        attachedJob = job.id;
        activeJob = job.id;
        tab = 'run';
        renderTabs();
        void follow(job.id);
      });
      control.classList.add('colab-job');
      if (job.id === activeJob) control.setAttribute('aria-current', 'true');
      const progressLine = progressSummary(job.progress);
      control.append(
        el('strong', '', `${job.label ? `${job.label} · ` : ''}${job.action} · ${job.state}`),
        el('span', '', job.session || 'no session'),
        el('small', '', `${job.id.slice(0, 8)} · start ${stamp(job.startedAt)} · end ${stamp(job.endedAt)} · exit ${job.exitCode === null || job.exitCode === undefined ? '—' : job.exitCode} · ${formatBytes(job.bytes)}`),
      );
      if (progressLine) control.append(el('small', '', progressLine));
      return control;
    }) : [el('p', 'colab-note', jobScope === 'session' && selected ? 'No jobs for this session yet. Agent runs show up here.' : 'No jobs yet.')];
    jobsList.replaceChildren(el('h3', '', 'Jobs'), scope, ...rows);
  }
  async function pollJobs() {
    const body = await call({ action: 'jobs' });
    if (disposed) return;
    const next = Array.isArray(body.jobs) ? body.jobs as Job[] : [];
    const running = next.filter(job => job.state === 'running').sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    if (!userPickedSession && running[0]?.session && selected !== running[0].session) {
      selected = running[0].session;
      renderSessions();
      renderMain();
    }
    const newest = running.find(job => !selected || job.session === selected);
    const unseen = Boolean(newest && !knownJobIds.has(newest.id));
    for (const job of next) {
      const previous = jobStates.get(job.id);
      if (previous && previous !== job.state) setStatus(`Job ${job.id.slice(0, 8)} ${job.action} is ${job.state}${job.exitCode === null || job.exitCode === undefined ? '' : ` (${job.exitCode})`}.`);
      jobStates.set(job.id, job.state);
      knownJobIds.add(job.id);
    }
    jobs = next;
    const shouldAttach = Boolean(newest && (!attachedJob || unseen));
    if (shouldAttach && newest) {
      attachedJob = newest.id;
      activeJob = newest.id;
    }
    renderJobs();
    if (shouldAttach && tab !== 'run') { tab = 'run'; renderTabs(); }
    else renderProgress(next.find(job => job.id === activeJob));
    if (shouldAttach && newest) void follow(newest.id);
  }

  void refreshAll().then(() => pollJobs()).catch(error => setStatus(error instanceof Error ? error.message : 'Colab is unavailable.'));
  const poll = window.setInterval(() => { if (!disposed) void refreshAll().catch(() => {}); }, 30000);
  const jobPoll = window.setInterval(() => { if (!disposed) void pollJobs().catch(() => {}); }, 3000);
  const gpuPoll = window.setInterval(() => { if (!disposed && tab === 'gpu' && selected) void loadGpu().catch(() => {}); }, 8000);
  return {
    element: root,
    dispose() {
      disposed = true;
      followGen += 1;
      window.clearInterval(poll);
      window.clearInterval(jobPoll);
      window.clearInterval(gpuPoll);
      term?.dispose();
    },
  };
}

function field(label: string, control: HTMLElement) {
  const wrap = el('label', '', label);
  wrap.append(control);
  return wrap;
}
function checkRow(control: HTMLInputElement, label: string) {
  const wrap = el('label', 'colab-row', '');
  wrap.append(control, el('span', '', label));
  return wrap;
}
