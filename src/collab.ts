import { el, button, select } from './dom';

const labels: Record<string, string> = { hermes: 'Hermes', grok: 'Grok Bot', pi: 'Pi', kyle: 'Kyle', orbit: 'Orbit' };
const skillNames = ['terminal', 'tools', 'code', 'research', 'reasoning', 'writing'];
const columns: [string, string][] = [
  ['planned', 'Awaiting approval'],
  ['submitted', 'Ready'],
  ['working', 'Working'],
  ['input-required', 'Needs input'],
  ['review', 'Review'],
  ['completed', 'Done'],
  ['failed', 'Failed'],
];

interface CollabTask {
  id: string;
  title: string;
  spec: string;
  acceptance: string[];
  dependsOn: string[];
  owner: string;
  reviewer: string;
  role: string;
  status: string;
  attempts: number;
  reviewAttempts: number;
  maxAttempts: number;
  summary: string;
  reviewNotes: string;
  lastError: string;
  artifacts?: string[];
}

interface CollabArtifact {
  id: string;
  name: string;
  kind: string;
  versions: { v: number; by: string; at?: number; note?: string }[];
}

interface CollabEvent {
  id: string;
  at: number;
  actor: string;
  type: string;
  taskId?: string;
  data: Record<string, unknown>;
}

interface CollabPresence {
  agent: string;
  taskId: string;
  kind: string;
  taskTitle: string;
}

interface CollabSubagent {
  id: string;
  name: string;
  parent: string;
  parentSubagentId: string;
  depth: number;
  taskId: string;
  status: string;
  mode: string;
  provider: string;
  files: string[];
  branch: string;
  strategy: string;
  spentTurns: number;
  spentTokens: number;
  budgetTurns: number;
  budgetMinutes: number;
  lastError: string;
  result: { summary?: string; paths?: string[] } | null;
}

interface CollabProject {
  id: string;
  title: string;
  goal: string;
  status: string;
  activity: string;
  workspace?: string;
  capabilities: { hermes: { skills: string[] }; grok: { skills: string[] } };
  budget: { maxTurns: number; maxWallMin: number; maxTokens: number | null; spentTurns: number; spentTokens: number; warned: boolean };
  summary: string;
  orchestrator?: string;
  orchestratorSource?: string;
  subagentLimits?: { maxConcurrent: number; maxDepth: number };
  gate: { id: string; type: string; summary: string; taskId?: string } | null;
}

interface CollabState {
  project: CollabProject;
  tasks: CollabTask[];
  artifacts: CollabArtifact[];
  events: CollabEvent[];
  running: string;
  presence?: CollabPresence[];
  workspace?: string;
  subagents?: CollabSubagent[];
  transcript?: { id: string; name: string; status: string; messages: { role?: string; text?: string }[] };
}

interface ProjectSummary {
  id: string;
  title: string;
  goal: string;
  status: string;
  gate?: string;
}

type CollabResponse = CollabState & { projects?: ProjectSummary[]; content?: string; version?: number; error?: string };

function lineDiff(before: string, after: string) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > 120 || b.length > 120) return after.split('\n').slice(0, 200).map(text => ({ kind: 'add' as const, text }));
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const rows: { kind: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length && rows.length < 200) {
    if (a[i] === b[j]) { rows.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ kind: 'del', text: a[i] }); i += 1; }
    else { rows.push({ kind: 'add', text: b[j] }); j += 1; }
  }
  while (i < a.length && rows.length < 200) rows.push({ kind: 'del', text: a[i++] });
  while (j < b.length && rows.length < 200) rows.push({ kind: 'add', text: b[j++] });
  return rows;
}

export function mountCollab(options: {
  request: (body: Record<string, unknown>) => Promise<CollabResponse>;
  onClose: () => void;
  standalone?: boolean;
}) {
  const element = el('section', 'collab');
  element.setAttribute('aria-label', 'Collab');
  const status = el('p', 'collab-status', 'Loading Collab…');
  status.setAttribute('role', 'status');
  const body = el('div', 'collab-body');
  const goal = el('textarea');
  goal.maxLength = 4000;
  goal.placeholder = 'What should Hermes and Grok Bot accomplish together?';
  goal.setAttribute('aria-label', 'Collab project goal');
  const createForm = el('form', 'collab-create');
  const createButton = button('Create project', 'Create a Collab project from this goal', () => {});
  createButton.type = 'submit';
  const orchestratorPick = select([['auto', 'Orchestrator: auto'], ['hermes', 'Orchestrator: Hermes'], ['grok', 'Orchestrator: Grok Bot']], 'auto', () => {});
  orchestratorPick.setAttribute('aria-label', 'Orchestrator');
  createForm.append(goal, orchestratorPick, createButton);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let open = false;
  let projectId = '';
  let projects: ProjectSummary[] = [];
  let drawerId = '';
  let transcriptId = '';
  let transcriptText = '';
  let artifactId = '';
  let artifactVersion = 0;
  let artifactText = '';
  let artifactPrior = '';
  try {
    const focus = sessionStorage.getItem('orbit.collab.focus') || '';
    if (/^p_[a-f0-9]{16}$/.test(focus)) projectId = focus;
  } catch { /* session storage is optional */ }

  function fail(error: unknown, fallback: string) {
    status.textContent = error instanceof Error ? error.message : fallback;
  }

  function typing() {
    const node = document.activeElement;
    return node instanceof HTMLElement && element.contains(node) && node.matches('input, textarea, select');
  }

  async function refresh() {
    if (disposed || !open) return;
    clearTimeout(timer);
    try {
      if (!projectId) {
        const data = await options.request({ operation: 'list' });
        if (disposed || !open || projectId) return;
        projects = data.projects || [];
        drawHome();
      } else {
        const [data, listed] = await Promise.all([
          options.request({ operation: 'state', project_id: projectId }),
          options.request({ operation: 'list' }).catch(() => ({ projects })),
        ]);
        if (disposed || !open) return;
        projects = listed.projects || projects;
        if (!typing()) drawProject(data);
        else status.textContent = data.project.activity || status.textContent;
      }
    } catch (error) {
      if (!disposed && open) fail(error, 'Collab could not refresh.');
    } finally {
      if (!disposed && open) timer = setTimeout(() => { void refresh(); }, 1500);
    }
  }

  function sidebar(activeId = '') {
    const side = el('aside', 'collab-side');
    side.setAttribute('aria-label', 'Collab projects');
    side.append(el('h2', '', 'Collab'));
    side.append(createForm);
    const list = el('div', 'collab-projects');
    if (!projects.length) list.append(el('p', 'collab-empty', 'No projects yet.'));
    for (const project of projects) {
      const row = button(project.title, project.goal, () => {
        projectId = project.id;
        drawerId = '';
        artifactId = '';
        artifactText = '';
        artifactPrior = '';
        void refresh();
      });
      row.classList.add('collab-project');
      if (project.id === activeId) row.setAttribute('aria-current', 'true');
      if (project.gate) {
        const badge = el('span', 'collab-badge', '1');
        badge.setAttribute('aria-label', 'Waiting for approval');
        row.append(badge);
      }
      const meta = el('span', 'collab-project-meta', project.status);
      row.append(meta);
      list.append(row);
    }
    side.append(list);
    return side;
  }

  function drawHome() {
    body.replaceChildren();
    const main = el('div', 'collab-main');
    main.append(
      el('h2', '', 'Projects'),
      el('p', '', 'Collab is the shared project board for Hermes and Grok Bot. Orbit keeps the tasks, the files, and the budget. You approve the plan, risky steps, and the final result. Open it from Start, or type /collab and a goal in the shared room.'),
    );
    if (!projects.length) main.append(el('p', 'collab-empty', 'Create a project from the sidebar.'));
    const app = el('div', 'collab-app');
    app.append(sidebar(), main);
    body.append(app);
    status.textContent = projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'}.` : 'Create a project to start.';
  }

  function presenceRow(data: CollabState) {
    const row = el('div', 'collab-presence');
    row.setAttribute('aria-label', 'Who is working');
    const active = new Map((data.presence || []).map(item => [item.agent, item]));
    for (const agent of ['hermes', 'grok']) {
      const item = active.get(agent);
      const chip = el('div', 'collab-presence-chip');
      chip.dataset.agent = agent;
      chip.dataset.live = item ? 'true' : 'false';
      const title = item?.taskTitle ? ` on ${item.taskTitle}` : '';
      const verb = !item ? 'idle' : item.kind === 'review' ? 'reviewing' : item.kind === 'plan' ? 'planning' : 'working';
      chip.append(el('strong', '', labels[agent]), el('span', '', `${verb}${title}`));
      row.append(chip);
    }
    return row;
  }

  function assignZones(data: CollabState) {
    const zones = el('div', 'collab-assign');
    zones.setAttribute('aria-label', 'Drag a task here to reassign it');
    for (const agent of ['hermes', 'grok'] as const) {
      const zone = el('div', 'collab-drop');
      zone.tabIndex = 0;
      zone.dataset.agent = agent;
      zone.textContent = `Assign to ${labels[agent]}`;
      zone.setAttribute('aria-label', `Assign a dragged task to ${labels[agent]}`);
      const take = (id: string) => {
        const task = data.tasks.find(item => item.id === id);
        if (!task) return;
        const owner = agent;
        const reviewer = task.reviewer === owner ? (owner === 'hermes' ? 'grok' : 'hermes') : task.reviewer;
        void options.request({
          operation: 'reassign', project_id: data.project.id, task_id: task.id, owner, reviewer, role: task.role,
        }).then(drawProject).catch(error => fail(error, 'That reassignment was not applied.'));
      };
      zone.addEventListener('dragover', event => { event.preventDefault(); zone.dataset.over = 'true'; });
      zone.addEventListener('dragleave', () => { delete zone.dataset.over; });
      zone.addEventListener('drop', event => {
        event.preventDefault();
        delete zone.dataset.over;
        take(event.dataTransfer?.getData('text/plain') || '');
      });
      zones.append(zone);
    }
    return zones;
  }

  function taskCard(task: CollabTask) {
    const card = el('article', 'collab-card');
    card.dataset.status = task.status;
    card.dataset.taskId = task.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${task.title}, ${labels[task.owner] || task.owner}`);
    const openDrawer = () => { drawerId = task.id; void refresh(); };
    card.addEventListener('click', openDrawer);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(); }
    });
    const handle = el('span', 'collab-drag', 'Move');
    handle.draggable = true;
    handle.setAttribute('aria-label', `Drag ${task.title} onto an agent to reassign it`);
    handle.addEventListener('dragstart', event => {
      event.dataTransfer?.setData('text/plain', task.id);
      event.stopPropagation();
    });
    handle.addEventListener('click', event => event.stopPropagation());
    card.append(handle, el('strong', '', task.title), el('p', '', `${labels[task.owner] || task.owner} · reviewer ${labels[task.reviewer] || task.reviewer}`));
    if (task.lastError) card.append(el('p', 'collab-error', task.lastError));
    return card;
  }

  function agentTree(data: CollabState) {
    const section = el('section', 'collab-tree');
    section.setAttribute('aria-label', 'Agent tree');
    const orchestrator = data.project.orchestrator || '';
    section.append(el('h3', '', 'Agents'));
    const pick = select([['auto', 'Auto'], ['hermes', 'Hermes'], ['grok', 'Grok Bot']], data.project.orchestratorSource || 'auto', () => {});
    pick.setAttribute('aria-label', 'Project orchestrator');
    const limits = data.project.subagentLimits || { maxConcurrent: 3, maxDepth: 1 };
    const concurrent = select([['1', '1 at once'], ['2', '2 at once'], ['3', '3 at once'], ['4', '4 at once']], String(limits.maxConcurrent), () => {});
    concurrent.setAttribute('aria-label', 'Subagent concurrency');
    const depth = select([['1', 'Depth 1'], ['2', 'Depth 2']], String(limits.maxDepth), () => {});
    depth.setAttribute('aria-label', 'Subagent depth');
    const controls = el('div', 'collab-tree-controls');
    controls.append(el('span', '', `Orchestrator ${labels[orchestrator] || 'not set'}`), pick, concurrent, depth, button('Save orchestration', 'Save the orchestrator and subagent limits', () => {
      void options.request({ operation: 'set_orchestrator', project_id: data.project.id, orchestrator: pick.value }).then(() => options.request({
        operation: 'subagent_limits', project_id: data.project.id, max_concurrent: Number(concurrent.value), max_depth: Number(depth.value),
      })).then(drawProject).catch(error => fail(error, 'Orchestration settings were not saved.'));
    }, 'small-button'));
    section.append(controls);
    const subs = data.subagents || [];
    for (const agent of ['hermes', 'grok']) {
      const node = el('div', 'collab-tree-node');
      node.dataset.agent = agent;
      const mine = subs.filter(item => item.parent === agent && !item.parentSubagentId);
      node.append(el('strong', '', `${labels[agent]}${agent === orchestrator ? ' · orchestrator' : ''}`));
      if (!mine.length) node.append(el('p', 'collab-empty', 'No subagents'));
      for (const sub of mine) node.append(subagentRow(data, sub, subs));
      section.append(node);
    }
    if (transcriptId && transcriptText) {
      const drawer = el('aside', 'collab-transcript');
      drawer.setAttribute('aria-label', 'Subagent transcript');
      drawer.append(el('h4', '', 'Subagent transcript'), el('pre', 'collab-transcript-body', transcriptText));
      section.append(drawer);
    }
    return section;
  }

  function subagentRow(data: CollabState, sub: CollabSubagent, all: CollabSubagent[]): HTMLElement {
    const row = el('div', 'collab-subagent');
    row.dataset.status = sub.status;
    row.dataset.subagentId = sub.id;
    const budget = `${sub.spentTurns}/${sub.budgetTurns || '?'} turns`;
    const result = sub.result?.summary ? ` · ${sub.result.summary.slice(0, 120)}` : '';
    row.append(el('p', '', `${sub.name} · ${sub.status} · ${sub.mode} · ${budget}${sub.lastError ? ` · ${sub.lastError}` : ''}${result}`));
    const actions = el('div', 'collab-tree-controls');
    if (!['completed', 'merged', 'failed', 'canceled'].includes(sub.status)) {
      actions.append(button('Cancel', `Cancel ${sub.name}`, () => {
        void options.request({ operation: 'cancel_subagent', project_id: data.project.id, subagent_id: sub.id }).then(next => {
          if (transcriptId === sub.id) { transcriptId = ''; transcriptText = ''; }
          drawProject(next);
        }).catch(error => fail(error, 'That subagent was not canceled.'));
      }, 'small-button'));
    }
    actions.append(button('Transcript', `Read the transcript for ${sub.name}`, () => {
      void options.request({ operation: 'subagent_transcript', project_id: data.project.id, subagent_id: sub.id }).then(payload => {
        const messages = payload.transcript?.messages || [];
        transcriptId = sub.id;
        transcriptText = messages.length ? messages.map(item => `${item.role || 'note'}: ${item.text || ''}`).join('\n\n') : 'No transcript yet.';
        drawProject(data);
      }).catch(error => fail(error, 'That transcript could not be read.'));
    }, 'small-button'));
    row.append(actions);
    for (const child of all.filter(item => item.parentSubagentId === sub.id)) row.append(subagentRow(data, child, all));
    return row;
  }

  function drawProject(data: CollabState) {
    const project = data.project;
    body.replaceChildren();
    const main = el('div', 'collab-main');
    const head = el('div', 'collab-head');
    head.append(el('h2', '', project.title));
    const actions = el('div', 'collab-controls');
    actions.append(
      button('Pause', 'Pause scheduling after the current turns', () => {
        void options.request({ operation: 'pause', project_id: project.id }).then(drawProject).catch(error => fail(error, 'Pause did not apply.'));
      }, 'small-button'),
      button('Continue', 'Resume a paused project', () => {
        void options.request({ operation: 'resume', project_id: project.id }).then(drawProject).catch(error => fail(error, 'Continue did not apply.'));
      }, 'small-button'),
      button('Stop', 'Stop both agents and pause the project', () => {
        void options.request({ operation: 'stop', project_id: project.id }).then(drawProject).catch(error => fail(error, 'Stop did not apply.'));
      }, 'small-button'),
      button('Archive', 'Archive this project and stop scheduling it', () => {
        if (!window.confirm(`Archive “${project.title}”?`)) return;
        void options.request({ operation: 'archive', project_id: project.id }).then(() => { projectId = ''; drawerId = ''; void refresh(); }).catch(error => fail(error, 'That project was not archived.'));
      }, 'small-button'),
      button('Delete', 'Delete this project and its files', () => {
        if (!window.confirm(`Delete “${project.title}”? This cannot be undone.`)) return;
        void options.request({ operation: 'delete', project_id: project.id }).then(() => { projectId = ''; drawerId = ''; void refresh(); }).catch(error => fail(error, 'That project was not deleted.'));
      }, 'small-button'),
    );
    if (!options.standalone) actions.append(button('Back to this chat', 'Return to the single-agent conversation', () => options.onClose(), 'small-button'));
    head.append(actions);
    const budget = project.budget;
    const meter = el('meter', 'collab-meter');
    meter.min = 0;
    meter.max = Math.max(1, budget.maxTurns);
    meter.value = Math.min(budget.maxTurns, budget.spentTurns);
    meter.setAttribute('aria-label', 'Turn budget');
    if (budget.warned) meter.dataset.warn = 'true';
    const budgetText = el('p', 'collab-budget', `${budget.spentTurns} of ${budget.maxTurns} turns · ${budget.maxWallMin} minute budget${budget.maxTokens ? ` · ${budget.spentTokens} of ${budget.maxTokens} tokens` : ''}${budget.warned ? ' · nearing the budget' : ''}`);
    const workspace = data.workspace || project.workspace || '';
    const inbox = el('section', 'collab-inbox');
    inbox.setAttribute('aria-label', 'Approval inbox');
    const waiting = project.gate ? 1 : 0;
    inbox.append(el('h3', '', waiting ? `Approvals (${waiting})` : 'Approvals'));
    if (!project.gate) inbox.append(el('p', '', 'Nothing is waiting on you.'));
    else {
      inbox.dataset.pending = 'true';
      inbox.append(el('p', '', `${project.gate.type}: ${project.gate.summary}`));
      const note = el('input');
      note.type = 'text';
      note.placeholder = 'Optional note';
      note.setAttribute('aria-label', 'Note for this approval');
      inbox.append(note, button('Approve', 'Approve this gate', () => {
        void options.request({ operation: 'resolve', project_id: project.id, choice: 'approve', note: note.value }).then(drawProject).catch(error => fail(error, 'Approval did not apply.'));
      }, 'small-button'), button('Reject', 'Reject this gate', () => {
        void options.request({ operation: 'resolve', project_id: project.id, choice: 'reject', note: note.value }).then(drawProject).catch(error => fail(error, 'Rejection did not apply.'));
      }, 'small-button'));
    }
    const board = el('div', 'collab-board');
    board.setAttribute('aria-label', 'Task board');
    for (const [statusName, label] of columns) {
      const tasks = data.tasks.filter(task => task.status === statusName || (statusName === 'failed' && task.status === 'canceled'));
      if (!tasks.length && !['submitted', 'working', 'review', 'completed'].includes(statusName)) continue;
      const column = el('section', 'collab-column');
      column.append(el('h3', '', `${label} (${tasks.length})`));
      if (!tasks.length) column.append(el('p', 'collab-empty', 'None'));
      for (const task of tasks) column.append(taskCard(task));
      board.append(column);
    }
    const selected = data.tasks.find(task => task.id === drawerId);
    const lower = el('div', 'collab-lower');
    lower.append(artifactPanel(data), timeline(data, selected?.id || ''));
    main.append(head, el('p', 'collab-goal', project.goal), presenceRow(data), agentTree(data), budgetText, meter, inbox, assignZones(data), board, lower);
    if (workspace) main.append(el('p', 'collab-workspace', `Workspace ${workspace}`));
    main.append(capabilitiesEditor(data));
    if (selected) main.append(drawer(data, selected));
    const app = el('div', 'collab-app');
    app.append(sidebar(project.id), main);
    body.append(app);
    const names = (data.presence || []).map(item => `${labels[item.agent]} is ${item.kind === 'review' ? 'reviewing' : 'working'}${item.taskTitle ? ` on ${item.taskTitle}` : ''}`);
    status.textContent = [project.activity, ...names, project.status === 'paused' ? 'Paused.' : ''].filter(Boolean).join(' ');
  }

  function drawer(data: CollabState, task: CollabTask) {
    const panel = el('aside', 'collab-drawer');
    panel.setAttribute('aria-label', task.title);
    const deps = task.dependsOn.map(id => data.tasks.find(item => item.id === id)?.title || id).join(', ');
    panel.append(
      el('h3', '', task.title),
      button('Close details', 'Close the task details', () => { drawerId = ''; void refresh(); }, 'small-button'),
      el('p', '', task.spec || 'No spec yet.'),
      el('h4', '', 'Acceptance'),
      el('ul', 'collab-accept', ''),
    );
    const list = panel.querySelector('ul')!;
    for (const item of task.acceptance || []) list.append(el('li', '', item));
    if (!task.acceptance?.length) list.append(el('li', '', 'None listed.'));
    panel.append(el('p', '', `Owner ${labels[task.owner] || task.owner}. Reviewer ${labels[task.reviewer] || task.reviewer}. Role ${task.role}.`));
    if (deps) panel.append(el('p', '', `Depends on ${deps}.`));
    if (task.summary) panel.append(el('p', '', task.summary));
    if (task.reviewNotes) panel.append(el('p', '', task.reviewNotes));
    if (task.lastError) panel.append(el('p', 'collab-error', task.lastError));
    const ownerPick = select([['hermes', 'Hermes'], ['grok', 'Grok Bot']], task.owner, () => {});
    ownerPick.setAttribute('aria-label', `Owner of ${task.title}`);
    const reviewerPick = select([['hermes', 'Hermes'], ['grok', 'Grok Bot']], task.reviewer, () => {});
    reviewerPick.setAttribute('aria-label', `Reviewer of ${task.title}`);
    const rolePick = select([['planner', 'Planner'], ['executor', 'Executor'], ['reviewer', 'Reviewer'], ['researcher', 'Researcher']], task.role, () => {});
    rolePick.setAttribute('aria-label', `Role of ${task.title}`);
    const controls = el('div', 'collab-reassign');
    controls.append(ownerPick, reviewerPick, rolePick, button('Reassign', `Reassign ${task.title}`, () => {
      void options.request({
        operation: 'reassign', project_id: data.project.id, task_id: task.id,
        owner: ownerPick.value, reviewer: reviewerPick.value, role: rolePick.value,
      }).then(next => { drawerId = task.id; drawProject(next); }).catch(error => fail(error, 'That reassignment was not applied.'));
    }, 'small-button'));
    panel.append(el('h4', '', 'Reassign'), controls, el('h4', '', 'History'));
    panel.append(timeline(data, task.id));
    return panel;
  }

  function artifactPanel(data: CollabState) {
    const section = el('section', 'collab-artifacts');
    section.setAttribute('aria-label', 'Artifacts');
    section.append(el('h3', '', 'Artifacts'));
    if (!data.artifacts.length) section.append(el('p', 'collab-empty', 'No shared files yet.'));
    for (const artifact of data.artifacts) {
      const latest = artifact.versions.at(-1);
      const openFile = button(`${artifact.name}${latest ? ` · v${latest.v}` : ''}`, `Read ${artifact.name}`, () => {
        artifactId = artifact.id;
        artifactVersion = latest?.v || 0;
        void loadArtifact(data.project.id, artifact, artifactVersion);
      }, 'small-button');
      if (artifact.id === artifactId) openFile.setAttribute('aria-current', 'true');
      section.append(openFile);
    }
    const current = data.artifacts.find(item => item.id === artifactId);
    if (current && current.versions.length > 1) {
      const versionPick = select(current.versions.map(item => [String(item.v), `v${item.v} · ${labels[item.by] || item.by}`]), String(artifactVersion || current.versions.at(-1)?.v || ''), value => {
        artifactVersion = Number(value);
        void loadArtifact(data.project.id, current, artifactVersion);
      });
      versionPick.setAttribute('aria-label', `Version of ${current.name}`);
      section.append(versionPick);
    }
    const viewer = el('pre', 'collab-artifact');
    viewer.tabIndex = 0;
    viewer.setAttribute('aria-label', 'Artifact contents');
    if (artifactPrior && artifactText && artifactPrior !== artifactText) {
      viewer.replaceChildren();
      for (const row of lineDiff(artifactPrior, artifactText)) {
        const line = el('div', `collab-diff collab-diff-${row.kind}`, `${row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}${row.text}`);
        viewer.append(line);
      }
    } else viewer.textContent = artifactText;
    section.append(viewer);
    return section;
  }

  async function loadArtifact(project: string, artifact: CollabArtifact, version: number) {
    try {
      const priorVersion = artifact.versions.filter(item => item.v < version).at(-1)?.v || 0;
      const current = await options.request({ operation: 'artifact', project_id: project, artifact_id: artifact.id, version });
      artifactText = current.content || '';
      artifactVersion = current.version || version;
      if (priorVersion) {
        const prior = await options.request({ operation: 'artifact', project_id: project, artifact_id: artifact.id, version: priorVersion });
        artifactPrior = prior.content || '';
      } else artifactPrior = '';
      void refresh();
    } catch (error) {
      fail(error, 'That artifact could not be read.');
    }
  }

  function timeline(data: CollabState, taskId = '') {
    const list = el('ol', 'collab-timeline');
    list.setAttribute('aria-label', taskId ? 'Task history' : 'Project timeline');
    const events = data.events.filter(item => !taskId || item.taskId === taskId || !item.taskId);
    if (!events.length) list.append(el('li', 'collab-empty', 'No events yet.'));
    for (const item of events.slice(-30)) {
      const line = el('li', 'collab-event');
      const detail = item.data?.summary || item.data?.reason || item.data?.text || item.data?.title || item.data?.message || item.data?.level || '';
      const when = item.at ? new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      line.textContent = `${when} · ${labels[item.actor] || 'Orbit'} · ${item.type}${detail ? ` · ${String(detail).slice(0, 180)}` : ''}`;
      list.append(line);
    }
    const wrap = el('section', 'collab-activity-panel');
    wrap.append(el('h3', '', taskId ? 'Task history' : 'Activity'), list);
    return wrap;
  }

  function capabilitiesEditor(data: CollabState) {
    const section = el('details', 'collab-capabilities');
    section.append(el('summary', '', 'What each agent can do'));
    const boxes: { agent: 'hermes' | 'grok'; skill: string; input: HTMLInputElement }[] = [];
    for (const agent of ['hermes', 'grok'] as const) {
      const row = el('div', 'collab-skill-row');
      row.append(el('span', '', labels[agent]));
      for (const skill of skillNames) {
        const label = el('label', 'collab-skill');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = data.project.capabilities[agent].skills.includes(skill);
        label.append(input, el('span', '', skill));
        row.append(label);
        boxes.push({ agent, skill, input });
      }
      section.append(row);
    }
    section.append(button('Save capabilities', 'Update who should be offered each kind of task', () => {
      const capabilities = {
        hermes: { skills: boxes.filter(box => box.agent === 'hermes' && box.input.checked).map(box => box.skill) },
        grok: { skills: boxes.filter(box => box.agent === 'grok' && box.input.checked).map(box => box.skill) },
      };
      void options.request({ operation: 'capabilities', project_id: data.project.id, capabilities }).then(drawProject).catch(error => fail(error, 'Capabilities were not saved.'));
    }, 'small-button'));
    return section;
  }

  createForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = goal.value.trim();
    if (!text) return;
    goal.value = '';
    void options.request({ operation: 'create', goal: text, orchestrator: orchestratorPick.value }).then(data => {
      projectId = data.project.id;
      projects = [{ id: data.project.id, title: data.project.title, goal: data.project.goal, status: data.project.status, gate: data.project.gate?.type || '' }, ...projects.filter(item => item.id !== data.project.id)];
      drawProject(data);
    }).catch(error => fail(error, 'That project was not created.'));
  });

  const onFocus = (event: Event) => {
    const id = (event as CustomEvent<{ projectId?: string }>).detail?.projectId || '';
    if (!/^p_[a-f0-9]{16}$/.test(id)) return;
    projectId = id;
    open = true;
    element.hidden = false;
    void refresh();
  };
  window.addEventListener('orbit-collab-focus', onFocus);
  element.append(body, status);
  if (options.standalone) {
    open = true;
    void refresh();
  }
  return {
    element,
    setVisible(value: boolean) {
      open = value;
      element.hidden = !value;
      clearTimeout(timer);
      if (value) void refresh();
    },
    focusProject(id: string) {
      if (!/^p_[a-f0-9]{16}$/.test(id)) return;
      projectId = id;
      open = true;
      element.hidden = false;
      void refresh();
    },
    dispose() {
      disposed = true;
      open = false;
      clearTimeout(timer);
      window.removeEventListener('orbit-collab-focus', onFocus);
    },
  };
}
