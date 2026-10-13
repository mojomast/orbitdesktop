import { el, button } from './dom';

const labels: Record<string, string> = { owner: 'Owner', hermes: 'Hermes', grok: 'Grok Bot', note: 'Orbit' };

export function mountSharedAgents(options: { request: (body: Record<string, unknown>) => Promise<any>; onClose: () => void }) {
  const element = el('section', 'shared-agents');
  element.setAttribute('aria-label', 'Shared Hermes and Grok Bot conversation');
  const status = el('p', 'shared-agents-status', 'Loading the shared conversation…');
  status.setAttribute('role', 'status');
  const log = el('div', 'shared-agents-log');
  log.setAttribute('aria-label', 'Shared transcript');
  const next = el('select');
  next.setAttribute('aria-label', 'Who speaks next');
  for (const [value, label] of [['hermes', 'Hermes'], ['grok', 'Grok Bot']]) {
    const option = el('option', '', label);
    option.value = value;
    next.append(option);
  }
  const limit = el('input');
  limit.type = 'number';
  limit.min = '1';
  limit.max = '8';
  limit.value = '4';
  limit.setAttribute('aria-label', 'Maximum agent replies per exchange');
  const auto = el('input');
  auto.type = 'checkbox';
  auto.setAttribute('aria-label', 'Auto-alternate speakers');
  const autoLabel = el('label', 'shared-agents-auto', 'Auto-alternate');
  autoLabel.append(auto);
  const composer = el('textarea');
  composer.maxLength = 16000;
  composer.placeholder = 'Write to both agents';
  composer.setAttribute('aria-label', 'Message to the shared conversation');
  const form = el('form', 'shared-agents-form');
  const send = button('Send', 'Post to the shared conversation', () => {});
  send.type = 'submit';
  form.append(composer, send);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let open = false;
  let drawing = false;

  function draw(data: any) {
    log.replaceChildren();
    for (const message of data.messages || []) {
      const line = el('article', 'shared-agents-line');
      line.dataset.speaker = String(message.speaker || 'note');
      if (message.error) line.dataset.error = 'true';
      line.append(el('strong', '', labels[message.speaker] || 'Orbit'), el('p', '', String(message.text || '')));
      log.append(line);
    }
    if (!log.childElementCount) log.append(el('p', '', 'No messages yet. Post, or choose who speaks first.'));
    if (!drawing) {
      drawing = true;
      next.value = data.next === 'grok' ? 'grok' : 'hermes';
      limit.value = String(data.max_turns || 4);
      auto.checked = data.auto === true;
      drawing = false;
    }
    const running = data.running ? `${labels[data.running] || 'An agent'} is replying.` : '';
    status.textContent = [data.activity, running, data.paused ? 'Auto-alternate is paused.' : data.auto ? `Auto-alternate is on, up to ${data.max_turns} agent replies.` : 'Auto-alternate is off.'].filter(Boolean).join(' ');
    log.scrollTop = log.scrollHeight;
  }

  async function refresh() {
    if (disposed || !open) return;
    clearTimeout(timer);
    try {
      const data = await options.request({ operation: 'state' });
      if (disposed || !open) return;
      draw(data);
    } catch (error) {
      if (!disposed && open) status.textContent = error instanceof Error ? error.message : 'The shared conversation could not refresh.';
    } finally {
      if (!disposed && open) timer = setTimeout(() => { void refresh(); }, 1500);
    }
  }

  async function sendSettings() {
    if (drawing) return;
    try {
      const data = await options.request({ operation: 'settings', next: next.value, auto: auto.checked, max_turns: Number(limit.value) });
      draw(data);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Those turn settings were not saved.';
    }
  }

  next.addEventListener('change', () => { void sendSettings(); });
  limit.addEventListener('change', () => { void sendSettings(); });
  auto.addEventListener('change', () => { void sendSettings(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = composer.value.trim();
    if (!text) return;
    composer.value = '';
    void options.request({ operation: 'post', text }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'That message was not posted.'; });
  });
  const controls = el('div', 'shared-agents-controls');
  controls.append(
    el('span', '', 'Next'),
    next,
    el('span', '', 'Limit'),
    limit,
    autoLabel,
    button('Let them speak', 'Ask the selected agent to reply now', () => {
      void options.request({ operation: 'speak', speaker: next.value }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'That speaker did not start.'; });
    }, 'small-button'),
    button('Pause', 'Pause auto-alternate after the current reply', () => {
      void options.request({ operation: 'pause' }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'Pause did not apply.'; });
    }, 'small-button'),
    button('Resume', 'Resume auto-alternate', () => {
      void options.request({ operation: 'resume' }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'Resume did not apply.'; });
    }, 'small-button'),
    button('Stop', 'Stop the current reply and pause auto-alternate', () => {
      void options.request({ operation: 'stop' }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'Stop did not apply.'; });
    }, 'small-button'),
  );
  const head = el('div', 'shared-agents-head');
  head.append(el('h2', '', 'Shared agents'), button('Back to this chat', 'Return to the single-agent conversation', () => options.onClose(), 'small-button'));
  element.append(
    head,
    el('p', '', 'Hermes and Grok Bot share this transcript. Grok Bot uses a separate Orbit shared chat, not your main Grok Bot conversation. You can post at any time.'),
    status,
    log,
    controls,
    form,
  );

  return {
    element,
    setVisible(value: boolean) {
      open = value;
      element.hidden = !value;
      clearTimeout(timer);
      if (value) void refresh();
    },
    dispose() { disposed = true; open = false; clearTimeout(timer); },
  };
}
