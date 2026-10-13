import { el, button } from './dom';
import { requestOpenHostSurface } from './host-surfaces';

const labels: Record<string, string> = { owner: 'Kyle', hermes: 'Hermes', grok: 'Grok Bot', note: 'Orbit' };

export function mountSharedAgents(options: { request: (body: Record<string, unknown>) => Promise<any>; onClose: () => void }) {
  const element = el('section', 'shared-agents');
  element.setAttribute('aria-label', 'Shared Hermes and Grok Bot conversation');
  const status = el('p', 'shared-agents-status', 'Loading the shared conversation…');
  status.setAttribute('role', 'status');
  const log = el('div', 'shared-agents-log');
  log.setAttribute('aria-label', 'Shared transcript');
  const tasks = el('div', 'shared-agents-tasks');
  tasks.hidden = true;
  tasks.setAttribute('aria-label', 'Delegated tasks');
  const composer = el('textarea');
  composer.maxLength = 16000;
  composer.placeholder = 'Message the group. Use @hermes, @grok, @all, or /collab <goal>';
  composer.setAttribute('aria-label', 'Message to the shared conversation');
  const form = el('form', 'shared-agents-form');
  const send = button('Send', 'Post to the shared conversation', () => {});
  send.type = 'submit';
  form.append(composer, send);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let open = false;
  const continueButton = button('Continue', 'Let the agents continue', () => {
    void options.request({ operation: 'continue' }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'Continue did not apply.'; });
  }, 'small-button');
  continueButton.hidden = true;

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
    const rows = Array.isArray(data.delegations) ? data.delegations : [];
    tasks.replaceChildren();
    tasks.hidden = rows.length === 0;
    for (const task of rows) {
      const from = labels[task.from] || 'Agent';
      const to = labels[task.to] || 'Agent';
      const row = el('div', 'shared-agents-task');
      row.dataset.status = String(task.status || '');
      row.append(el('span', '', `${from} → ${to}: ${task.task}`), el('span', 'shared-agents-task-status', String(task.status || '')));
      if (task.status === 'pending' || task.status === 'running') {
        row.append(button('Cancel', `Cancel the delegated task from ${from} to ${to}`, () => {
          void options.request({ operation: 'cancel_delegation', task_id: task.id }).then(draw).catch(error => {
            status.textContent = error instanceof Error ? error.message : 'That delegated task was not cancelled.';
          });
        }, 'small-button'));
      }
      tasks.append(row);
    }
    continueButton.hidden = !(data.paused || data.hold);
    const running = data.running ? `${labels[data.running] || 'An agent'} is replying.` : '';
    const floor = data.hold ? 'Continue when you want the agents to keep going.' : data.paused ? 'Paused.' : '';
    status.textContent = [data.activity === floor ? '' : data.activity, running, floor].filter(Boolean).join(' ');
    log.scrollTop = log.scrollHeight;
    const projectId = data.collabProject?.id;
    if (typeof projectId === 'string' && /^p_[a-f0-9]{16}$/.test(projectId)) {
      try { sessionStorage.setItem('orbit.collab.focus', projectId); } catch { /* the Collab window still opens */ }
      requestOpenHostSurface('collab');
      window.dispatchEvent(new CustomEvent('orbit-collab-focus', { detail: { projectId } }));
    }
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

  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = composer.value.trim();
    if (!text) return;
    composer.value = '';
    void options.request({ operation: 'post', text }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'That message was not posted.'; });
  });
  const controls = el('div', 'shared-agents-controls');
  controls.append(
    button('Pause', 'Finish the current reply and hold the floor', () => {
      void options.request({ operation: 'pause' }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'Pause did not apply.'; });
    }, 'small-button'),
    continueButton,
    button('Stop', 'Stop the current reply and hold the floor', () => {
      void options.request({ operation: 'stop' }).then(draw).catch(error => { status.textContent = error instanceof Error ? error.message : 'Stop did not apply.'; });
    }, 'small-button'),
  );
  const head = el('div', 'shared-agents-head');
  head.append(el('h2', '', 'Shared agents'), button('Back to this chat', 'Return to the single-agent conversation', () => options.onClose(), 'small-button'));
  element.append(
    head,
    el('p', '', 'Kyle, Hermes, and Grok Bot share this transcript. Address someone with @hermes, @grok, or @all. Agents reply to each other only when they hand off the floor. You can post at any time. /collab and a goal opens the Collab app.'),
    status,
    log,
    tasks,
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
