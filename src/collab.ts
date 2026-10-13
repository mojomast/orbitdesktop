import { el, button, select } from './dom';

const labels: Record<string, string> = { hermes: 'Hermes', grok: 'Grok Bot', kyle: 'Kyle', orbit: 'Orbit' };
const skillNames = ['terminal', 'tools', 'code', 'research', 'reasoning', 'writing'];
const columns: [string, string][] = [
  ['planned', 'Awaiting approval'],
  ['submitted', 'Submitted'],
  ['working', 'Working'],
  ['input-required', 'Needs input'],
  ['review', 'Review'],
  ['completed', 'Completed'],
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
}

interface CollabArtifact {
  id: string;
  name: string;
  kind: string;
  versions: { v: number; by: string }[];
}

interface CollabEvent {
  id: string;
  at: number;
  actor: string;
  type: string;
  data: Record<string, unknown>;
}

interface CollabState {
  project: {
    id: string;
    title: string;
    goal: string;
    status: string;
    activity: string;
    capabilities: { hermes: { skills: string[] }; grok: { skills: string[] } };
    budget: { maxTurns: number; maxWallMin: number; maxTokens: number | null; spentTurns: number; spentTokens: number; warned: boolean };
    summary: string;
    gate: { id: string; type: string; summary: string } | null;
  };
  tasks: CollabTask[];
  artifacts: CollabArtifact[];
  events: CollabEvent[];
  running: string;
}

export function mountCollab(options: { request: (body: Record<string, unknown>) => Promise<CollabState & { projects?: { id: string; title: string; goal: string; status: string }[]; content?: string; error?: string }>; onClose: () => void }) {
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
  createForm.append(goal, createButton);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let open = false;
  let projectId = '';
  let artifactNote = '';

  function fail(error: unknown, fallback: string) {
    status.textContent = error instanceof Error ? error.message : fallback;
  }

  async function refresh() {
    if (disposed || !open) return;
    clearTimeout(timer);
    try {
      if (!projectId) {
        const data = await options.request({ operation: 'list' });
        if (disposed || !open || projectId) return;
        drawList(data.projects || []);
      } else {
        const data = await options.request({ operation: 'state', project_id: projectId });
        if (disposed || !open) return;
        drawProject(data);
      }
    } catch (error) {
      if (!disposed && open) fail(error, 'Collab could not refresh.');
    } finally {
      if (!disposed && open) timer = setTimeout(() => { void refresh(); }, 1500);
    }
  }

  function drawList(projects: { id: string; title: string; goal: string; status: string }[]) {
    body.replaceChildren();
    body.append(el('h2', '', 'Collab'), el('p', '', 'Orbit keeps the board. Hermes and Grok Bot propose work with a collab block. You approve the plan, risky steps, and the final result. Roles are chosen per task from what each agent can do.'));
    const list = el('div', 'collab-list');
    list.setAttribute('aria-label', 'Collab projects');
    if (!projects.length) list.append(el('p', '', 'No projects yet.'));
    for (const project of projects) {
      const row = button(`${project.title} · ${project.status}`, project.goal, () => {
        projectId = project.id;
        void refresh();
      });
      row.classList.add('collab-project');
      list.append(row);
    }
    body.append(list, createForm);
    status.textContent = projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'}.` : 'Create a project to start.';
  }

  function drawProject(data: CollabState) {
    body.replaceChildren();
    const project = data.project;
    const head = el('div', 'collab-head');
    head.append(
      el('h2', '', project.title),
      button('All projects', 'Return to the Collab project list', () => { projectId = ''; artifactNote = ''; void refresh(); }, 'small-button'),
      button('Archive', 'Archive this project and stop scheduling it', () => {
        if (!window.confirm(`Archive “${project.title}”?`)) return;
        void options.request({ operation: 'archive', project_id: project.id }).then(() => { projectId = ''; void refresh(); }).catch(error => fail(error, 'That project was not archived.'));
      }, 'small-button'),
      button('Delete', 'Delete this project and its files', () => {
        if (!window.confirm(`Delete “${project.title}”? This cannot be undone.`)) return;
        void options.request({ operation: 'delete', project_id: project.id }).then(() => { projectId = ''; artifactNote = ''; void refresh(); }).catch(error => fail(error, 'That project was not deleted.'));
      }, 'small-button'),
      button('Back to this chat', 'Return to the single-agent conversation', () => options.onClose(), 'small-button'),
    );
    const budget = project.budget;
    const meter = el('meter', 'collab-meter');
    meter.min = 0;
    meter.max = Math.max(1, budget.maxTurns);
    meter.value = Math.min(budget.maxTurns, budget.spentTurns);
    if (budget.warned) meter.dataset.warn = 'true';
    const budgetText = el('p', 'collab-budget', `${budget.spentTurns}/${budget.maxTurns} turns · ${budget.maxWallMin} min budget${budget.maxTokens ? ` · ${budget.spentTokens}/${budget.maxTokens} tokens` : ''}${budget.warned ? ' · nearing the budget' : ''}`);
    const goalLine = el('p', 'collab-goal', project.goal);
    const board = el('div', 'collab-board');
    board.setAttribute('aria-label', 'Task board');
    for (const [statusName, label] of columns) {
      const column = el('section', 'collab-column');
      column.append(el('h3', '', label));
      const tasks = data.tasks.filter(task => task.status === statusName || (statusName === 'failed' && task.status === 'canceled'));
      if (!tasks.length) column.append(el('p', 'collab-empty', 'None'));
      for (const task of tasks) column.append(taskCard(data, task));
      board.append(column);
    }
    const inbox = el('section', 'collab-inbox');
    inbox.setAttribute('aria-label', 'Approval inbox');
    inbox.append(el('h3', '', 'Approvals'));
    if (!project.gate) inbox.append(el('p', '', 'Nothing is waiting on you.'));
    else {
      inbox.append(el('p', '', `${project.gate.type}: ${project.gate.summary}`));
      const note = el('input');
      note.type = 'text';
      note.placeholder = 'Optional note';
      note.setAttribute('aria-label', 'Note for this approval');
      const approve = button('Approve', 'Approve this gate', () => {
        void options.request({ operation: 'resolve', project_id: project.id, choice: 'approve', note: note.value }).then(drawProject).catch(error => fail(error, 'Approval did not apply.'));
      }, 'small-button');
      const reject = button('Reject', 'Reject this gate', () => {
        void options.request({ operation: 'resolve', project_id: project.id, choice: 'reject', note: note.value }).then(drawProject).catch(error => fail(error, 'Rejection did not apply.'));
      }, 'small-button');
      inbox.append(note, approve, reject);
    }
    const artifacts = el('section', 'collab-artifacts');
    artifacts.setAttribute('aria-label', 'Artifacts');
    artifacts.append(el('h3', '', 'Artifacts'));
    if (!data.artifacts.length) artifacts.append(el('p', '', 'No shared files yet.'));
    const viewer = el('pre', 'collab-artifact');
    viewer.textContent = artifactNote;
    for (const artifact of data.artifacts) {
      const latest = artifact.versions.at(-1);
      artifacts.append(button(`${artifact.name}${latest ? ` @v${latest.v}` : ''}`, `Read ${artifact.name}`, () => {
        void options.request({ operation: 'artifact', project_id: project.id, artifact_id: artifact.id, version: latest?.v }).then(result => {
          artifactNote = result.content || '';
          viewer.textContent = artifactNote;
        }).catch(error => fail(error, 'That artifact could not be read.'));
      }, 'small-button'));
    }
    artifacts.append(viewer);
    const timeline = el('ol', 'collab-timeline');
    timeline.setAttribute('aria-label', 'Project timeline');
    for (const item of data.events) {
      const line = el('li', 'collab-event');
      const detail = item.data?.summary || item.data?.reason || item.data?.text || item.data?.title || item.data?.level || item.type;
      line.textContent = `${labels[item.actor] || 'Orbit'} · ${item.type}${detail ? ` · ${String(detail).slice(0, 180)}` : ''}`;
      timeline.append(line);
    }
    const controls = el('div', 'collab-controls');
    controls.append(
      button('Pause', 'Pause scheduling after the current turn', () => {
        void options.request({ operation: 'pause', project_id: project.id }).then(drawProject).catch(error => fail(error, 'Pause did not apply.'));
      }, 'small-button'),
      button('Continue', 'Resume a paused project', () => {
        void options.request({ operation: 'resume', project_id: project.id }).then(drawProject).catch(error => fail(error, 'Continue did not apply.'));
      }, 'small-button'),
      button('Stop', 'Stop the current turn and pause the project', () => {
        void options.request({ operation: 'stop', project_id: project.id }).then(drawProject).catch(error => fail(error, 'Stop did not apply.'));
      }, 'small-button'),
    );
    body.append(head, goalLine, budgetText, meter, el('p', 'collab-summary', project.summary || ''), statusLine(data), inbox, board, capabilitiesEditor(data), artifacts, el('h3', 'collab-timeline-title', 'Timeline'), timeline, controls);
    status.textContent = [project.activity, data.running ? `${labels[data.running] || 'An agent'} is working.` : '', project.status === 'paused' ? 'Paused.' : ''].filter(Boolean).join(' ');
  }

  function statusLine(data: CollabState) {
    return el('p', 'collab-activity', data.project.activity || '');
  }

  function taskCard(data: CollabState, task: CollabTask) {
    const card = el('article', 'collab-card');
    card.dataset.status = task.status;
    card.append(el('strong', '', task.title), el('p', '', `${labels[task.owner] || task.owner} · ${task.role} · reviewer ${labels[task.reviewer] || task.reviewer}`));
    if (task.spec) card.append(el('p', 'collab-spec', task.spec));
    if (task.acceptance?.length) card.append(el('p', 'collab-accept', task.acceptance.map(item => `☐ ${item}`).join('\n')));
    if (task.dependsOn?.length) card.append(el('p', '', `Depends on ${task.dependsOn.length} task${task.dependsOn.length === 1 ? '' : 's'}`));
    if (task.reviewNotes) card.append(el('p', '', task.reviewNotes));
    if (task.lastError) card.append(el('p', 'collab-error', task.lastError));
    const ownerPick = select([['hermes', 'Hermes'], ['grok', 'Grok Bot']], task.owner, () => {});
    ownerPick.setAttribute('aria-label', `Owner of ${task.title}`);
    const reviewerPick = select([['hermes', 'Hermes'], ['grok', 'Grok Bot']], task.reviewer, () => {});
    reviewerPick.setAttribute('aria-label', `Reviewer of ${task.title}`);
    const rolePick = select([['planner', 'Planner'], ['executor', 'Executor'], ['reviewer', 'Reviewer'], ['researcher', 'Researcher']], task.role, () => {});
    rolePick.setAttribute('aria-label', `Role of ${task.title}`);
    const apply = button('Reassign', `Reassign ${task.title}`, () => {
      void options.request({
        operation: 'reassign',
        project_id: data.project.id,
        task_id: task.id,
        owner: ownerPick.value,
        reviewer: reviewerPick.value,
        role: rolePick.value,
      }).then(drawProject).catch(error => fail(error, 'That reassignment was not applied.'));
    }, 'small-button');
    const controls = el('div', 'collab-reassign');
    controls.append(ownerPick, reviewerPick, rolePick, apply);
    card.append(controls);
    return card;
  }

  function capabilitiesEditor(data: CollabState) {
    const section = el('section', 'collab-capabilities');
    section.append(el('h3', '', 'What each agent can do'));
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
    void options.request({ operation: 'create', goal: text }).then(data => {
      projectId = data.project.id;
      drawProject(data);
    }).catch(error => fail(error, 'That project was not created.'));
  });

  element.append(body, status);
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
