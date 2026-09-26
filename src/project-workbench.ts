import { button, el } from "./dom";
import { ensureWorkspaceSynced, workspaceId } from "./workspace-sync";
import "./project-workbench.css";

import type {Project,Resource,FileSnapshot,WorkbenchRequest} from './workbench-contract.generated';
type Binding = { id:string;resource_id: string; pane_id: string; role: string };
type Surface = {
  pane_id: string;
  kind: string;
  window_id: string;
  name: string;
};
type Inspection = {
  project: Project;
  resources: Resource[];
  bindings: Binding[];
  repository: {
    state: string;
    head: string | null;
    status?: string;
    diff: string;
    exclusions?: string;
    reason?: string;
    snapshot_hash?: string;
  };
  snapshot: {
    id: string;
    hash: string;
    captured_at: number;
    manifest: unknown;
    exclusions: unknown;
    truncated: boolean;
    total_bytes: number;
  };
  execution: {
    tasks: unknown[];
    jobs: unknown[];
    artifacts: unknown[];
    state: string;
    message: string;
  };
};
type Approval = {
  approval_id: string;
  digest: string;
  expires_at: number;
  root: string;
  name: string;
  authority: string;
  limits: Record<string, unknown>;
  exclusions: string[];
};
type WithoutWorkspace<T> = T extends unknown ? Omit<T,'workspace_id'> : never;
type Request = WithoutWorkspace<WorkbenchRequest>;

function field(label: string, value: unknown) {
  return el("p", "", `${label}: ${String(value ?? "")}`);
}
function labelled(name: string, control: HTMLElement) {
  const label=el('label');label.append(el('span','',name+' '),control);return label;
}

function statusRows(status: string): string[] {
  const entries = status.split("\0").filter(Boolean);
  const rows: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Porcelain -z uses a second NUL-terminated path for rename/copy records.
    if (/^[RC]/.test(entry.slice(0, 2)) || /[RC]$/.test(entry.slice(0, 2))) {
      rows.push(
        `${entry.slice(0, 2)} ${entry.slice(3)} → ${entries[++i] ?? ""}`,
      );
    } else rows.push(`${entry.slice(0, 2)} ${entry.slice(3)}`);
  }
  return rows;
}

function lineRange(text: string, start: number, end: number): [number, number] {
  const lines = text.split("\n");
  const first = Math.max(1, Math.min(lines.length, Math.trunc(start) || 1));
  const last = Math.max(
    first,
    Math.min(lines.length, Math.trunc(end) || first),
  );
  let from = 0;
  for (let i = 1; i < first; i++) from += lines[i - 1].length + 1;
  let to = from;
  for (let i = first; i <= last; i++)
    to += lines[i - 1].length + (i < last ? 1 : 0);
  return [from, to];
}

export function showProjectWorkbench(getToken: () => string): void {
  const existing = document.querySelector<HTMLDialogElement>(
    "dialog.project-workbench-dialog",
  );
  if (existing?.open) {
    existing.focus();
    return;
  }
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const dialog = el("dialog", "project-workbench-dialog");
  dialog.setAttribute("aria-label", "Comet Project Workbench");
  const close = button("Close", "Close project workbench", () =>
    dialog.close(),
  );
  const textSize=el('input');textSize.type='range';textSize.min='12';textSize.max='28';textSize.value='16';
  textSize.setAttribute('aria-label','Workbench text size');
  textSize.addEventListener('input',()=>{dialog.style.fontSize=textSize.value+'px';});
  const status = el(
    "p",
    "workbench-status",
    "loading · Connecting to workspace…",
  );
  status.setAttribute("role", "status");
  const projects = el("div", "workbench-projects");
  const approvalView = el("div", "workbench-approval");
  const registration=el('details','workbench-registration');
  registration.append(el('summary','','Register project'));
  const inspector = el("section", "workbench-inspector");
  const repository = el("div", "workbench-repository");
  const files = el("div", "workbench-files");
  const fileView = el("div", "workbench-file");
  const bindingsView = el("div", "workbench-bindings");
  const execution = el("div", "workbench-execution");
  const doctor = el("div", "workbench-doctor");
  const root = el("input");
  root.setAttribute("aria-label", "Project root directory");
  root.placeholder = "Absolute project root";
  const name = el("input");
  name.setAttribute("aria-label", "Project name");
  name.placeholder = "Project name";
  const panes = el("select");
  panes.setAttribute("aria-label", "Link pane");
  const selectionStart = el("input");
  selectionStart.type = "number";
  selectionStart.min = "1";
  selectionStart.value = "1";
  selectionStart.setAttribute("aria-label", "Selection start line");
  const selectionEnd = el("input");
  selectionEnd.type = "number";
  selectionEnd.min = "1";
  selectionEnd.value = "1";
  selectionEnd.setAttribute("aria-label", "Selection end line");
  const selection = el("p", "workbench-selection", "No lines selected.");
  const filePath = el("p", "workbench-file-path");
  const fileMeta = el("p", "workbench-file-meta");
  const stale = el("span", "workbench-stale", "stale");
  stale.hidden = true;
  const text = el("textarea", "workbench-file-text");
  text.setAttribute("aria-label", "Project file text");
  text.readOnly = true;
  let epoch = 0;
  const controllers = new Set<AbortController>();
  let revision = 0;
  let project: Project | null = null;
  let inspection: Inspection | null = null;
  let openResource: Resource | null = null;
  let openSnapshot: FileSnapshot | null = null;
  let approval: Approval | null = null;

  function invalidate() {
    epoch++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  function current(token: number) {
    return dialog.open && epoch === token;
  }
  function state(kind: string, detail: string) {
    status.textContent = `${kind} · ${detail}`;
  }
  async function request<T>(body: Request, token = epoch): Promise<T | null> {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const ownerToken = getToken();
      if (!ownerToken) {
        if (current(token))
          state("disconnected", "Connect the owner workspace to continue.");
        return null;
      }
      try {
        await ensureWorkspaceSynced();
      } catch {
        if (current(token))
          state("disconnected", "Workspace synchronization failed.");
        return null;
      }
      if (!current(token)) return null;
      const response = await fetch("/api/workbench", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, workspace_id: workspaceId }),
        signal: controller.signal,
      });
      const data: { ok: boolean; code?: string } & T = await response.json();
      if (!current(token)) return null;
      if (!response.ok || !data.ok) {
        const kind =
          response.status === 403
            ? "permission_denied"
            : response.status === 409
              ? "stale"
              : "unavailable";
        state(
          kind,
          `${data.code ?? "Request failed"}. Refresh the workbench before retrying.`,
        );
        return null;
      }
      return data;
    } catch (error) {
      if (
        current(token) &&
        !(error instanceof Error && error.name === "AbortError")
      )
        state("unavailable", "Workbench request or connection failed.");
      return null;
    } finally {
      controllers.delete(controller);
    }
  }

  function updateButtons() {
    link.disabled = !project || !panes.value || revision < 1;
    bind.disabled = !project || !openResource || !panes.value || revision < 1;
  }
  function showBindings(items: Binding[]) {
    bindingsView.replaceChildren(el("h3", "", "Bindings"));
    if (!items.length) bindingsView.append(el("p", "", "No pane bindings."));
    for (const item of items) {
      const resource = inspection?.resources.find(
        (r) => r.id === item.resource_id,
      );
      bindingsView.append(
        field(
          "Binding",
          `${resource?.path ?? item.resource_id} · ${item.role} · ${item.pane_id}`,
        ),
        button('Remove binding',`Remove ${item.role} binding ${item.id}`,async()=>{
          if(!project)return;
          const result=await request<{bindings:Binding[]}>({action:'unbind',project_id:project.id,binding_id:item.id});
          if(result){showBindings(result.bindings);state('ready','Exact metadata binding removed; pane runtime unchanged.');}
        }),
      );
    }
  }
  function selectionReport() {
    const before = text.value.slice(0, text.selectionStart);
    const selected = text.value.slice(text.selectionStart, text.selectionEnd);
    const first = before.split("\n").length;
    const last = first + selected.split("\n").length - 1;
    selection.textContent =
      text.selectionStart === text.selectionEnd
        ? `Cursor at line ${first}.`
        : `Selected lines ${first}–${last}.`;
  }
  function showFile(resource: Resource, snapshot: FileSnapshot) {
    openResource = resource;
    openSnapshot = snapshot;
    fileView.hidden = false;
    filePath.textContent = resource.path ?? resource.id;
    fileMeta.textContent = `resource: ${resource.id} · snapshot: ${snapshot.id} · hash: ${snapshot.hash} · bytes: ${snapshot.bytes} · lines: ${snapshot.lines} · generation: ${snapshot.generation} · captured_at: ${new Date(snapshot.captured_at).toISOString()}`;
    text.value = snapshot.binary
      ? "Binary file is not displayed."
      : snapshot.text;
    stale.hidden = !snapshot.stale;
    selectionReport();
    updateButtons();
  }
  async function loadFile(resource: Resource) {
    if (!project) return;
    invalidate();
    const id = project.id;
    state("loading", `Reading ${resource.path ?? resource.id}…`);
    const result = await request<{
      resource: Resource;
      snapshot: FileSnapshot;
    }>({ action: "file", project_id: id, resource_id: resource.id });
    if (!result || project?.id !== id) return;
    showFile(result.resource, result.snapshot);
    state("ready", `Showing ${resource.path ?? resource.id}.`);
  }
  function renderInspection(data: Inspection) {
    inspection = data;
    project = data.project;
    inspector
      .querySelector(".workbench-project-meta")
      ?.replaceChildren(
        field(
          "Project",
           `${data.project.name} · ${data.project.id} · ${data.project.root} · generation: ${data.project.generation}`,
         ),
         field('Capture',`${data.snapshot.id} · ${new Date(data.snapshot.captured_at).toISOString()} · manifest SHA-256 ${data.snapshot.hash}`),
         field('Bounds',`${data.snapshot.total_bytes} bytes · ${data.snapshot.truncated ? 'Truncated/incomplete' : 'Within capture bounds'}`),
         field('Capture exclusions',JSON.stringify(data.snapshot.exclusions)),
      );
    repository.replaceChildren(
      el("h3", "", "Repository"),
      field("State", data.repository.state),
      field("Head", data.repository.head ?? "none"),
      field('Diff snapshot SHA-256',data.repository.snapshot_hash ?? 'unavailable'),
    );
    if (data.repository.state !== "available")
      repository.append(
        field("Reason", data.repository.reason ?? "Unavailable"),
      );
    for (const row of statusRows(data.repository.status ?? ""))
      repository.append(el("p", "workbench-status-row", row));
    const diff = el("pre", "workbench-diff", data.repository.diff ?? "");
    repository.append(diff);
    if (data.repository.exclusions)
      repository.append(field("Exclusions", data.repository.exclusions));
    files.replaceChildren(el("h3", "", "Files"));
    for (const resource of data.resources.filter((r) => r.kind === "file")) {
      const entry = el("div", "workbench-file-entry");
      entry.append(
        button(
          resource.path ?? resource.id,
          `Open file ${resource.path ?? resource.id}`,
          () => {
            void loadFile(resource);
          },
        ),
        field(
          "Snapshot",
          `${resource.path ?? resource.id} · ${(resource.hash ?? "").slice(0, 12)} · ${resource.bytes ?? 0} bytes · ${resource.state}`,
        ),
      );
      files.append(entry);
    }
    if (data.resources.every((r) => r.kind !== "file"))
      files.append(el("p", "", "No previewable files."));
    if (openResource && openSnapshot) {
      const latest = data.resources.find((r) => r.id === openResource?.id);
      stale.hidden =
        !!latest &&
        latest.hash === openSnapshot.hash &&
        latest.generation === openSnapshot.generation &&
        !openSnapshot.stale;
    }
    showBindings(data.bindings);
    execution.replaceChildren(
      el("h3", "", "Managed execution"),
      field("State", data.execution.state),
      field("Message", data.execution.message),
    );
    if (
      !data.execution.tasks.length &&
      !data.execution.jobs.length &&
      !data.execution.artifacts.length
    )
      execution.append(
        el(
          "p",
          "",
          "No managed tasks, jobs, or artifacts exist. Managed execution arrives in a later slice.",
        ),
      );
    updateButtons();
  }
  async function inspect() {
    if (!project) return;
    invalidate();
    const id = project.id;
    state("loading", "Inspecting project…");
    const result = await request<Inspection>({
      action: "inspect",
      project_id: id,
    });
    if (!result || project?.id !== id) return;
    renderInspection(result);
    state("ready", `Inspected ${result.project.name}.`);
  }
  async function list() {
    state("loading", "Loading projects and panes…");
    const result = await request<{
      projects: Project[];
      revision: number;
      surfaces: Surface[];
    }>({ action: "list" });
    if (!result) return;
    revision = result.revision;
    if(!result.projects.length)registration.open=true;
    projects.replaceChildren();
    for (const item of result.projects) {
      const entry = el("div", "workbench-project-entry");
      entry.append(
        button(item.name, `Open project ${item.name}`, () => {
          invalidate();
          project = item;
          registration.open=false;
          inspection = null;
          openResource = null;
          openSnapshot = null;
          fileView.hidden = true;
          text.value = "";
          repository.replaceChildren(field('State','Loading selected project…'));
          files.replaceChildren();bindingsView.replaceChildren();execution.replaceChildren();
          inspector.querySelector('.workbench-project-meta')?.replaceChildren(field('Project',`${item.name} · ${item.id}`));
          inspector.hidden = false;
          updateButtons();
          void inspect();
        }),
        field("Root", item.root),
        field('Access',item.active===false?'Revoked — preview registration again to restore owner observation':'Owner observation only'),
      );
      projects.append(entry);
    }
    panes.replaceChildren(el("option", "", "Select a pane"));
    panes.options[0].value = "";
    for (const surface of result.surfaces) {
      const option = el("option", "", `${surface.kind} · ${surface.name}`);
      option.value = surface.pane_id;
      panes.append(option);
    }
    updateButtons();
    state(
      result.projects.length ? "ready" : "empty",
      result.projects.length
        ? `${result.projects.length} projects available.`
        : "No projects registered. Preview a project root to begin.",
    );
  }

  const confirm = button(
    "Confirm project registration",
    "Confirm project registration",
    async () => {
      if (!approval) return;
      const pending = approval;
      confirm.disabled = true;
      state("loading", "Registering approved project…");
      const result = await request<{
        project: Project;
        approval_digest: string;
      }>({ action: "register_commit", approval_id: pending.approval_id });
      if (!result) {
        confirm.disabled = !approval;
        return;
      }
      approval = null;
      approvalView.replaceChildren();
      confirm.disabled = true;
      await list();
      project = result.project;
      registration.open=false;
      inspector.hidden = false;
      fileView.hidden = true;
      text.value = "";
      openResource = null;
      openSnapshot = null;
      await inspect();
    },
  );
  confirm.disabled = true;
  const preview = button(
    "Preview project registration",
    "Preview project registration",
    async () => {
      invalidate();
      approval = null;
      confirm.disabled = true;
      approvalView.replaceChildren();
      state("loading", "Previewing project registration…");
      const result = await request<Approval>({
        action: "register_preview",
        root: root.value,
        name: name.value,
      });
      if (!result) return;
      approval = result;
      approvalView.replaceChildren(
        field("Digest", result.digest),
        field("Expires at", new Date(result.expires_at).toISOString()),
        field("Root", result.root),
        field("Name", result.name),
        field("Authority", result.authority),
        field("Limits", JSON.stringify(result.limits)),
        field("Exclusions", result.exclusions.join(", ")),
      );
      confirm.disabled = false;
      state("ready", "Review the exact approval before confirming.");
    },
  );
  for (const input of [root, name])
    input.addEventListener("input", () => {
      invalidate();
      approval = null;
      approvalView.replaceChildren();
      confirm.disabled = true;
    });
  const refreshInspection = button(
    "Refresh project inspection",
    "Refresh project inspection",
    () => {
      void inspect();
    },
  );
  const refreshFile = button(
    "Refresh file preview",
    "Refresh file preview",
    () => {
      if (openResource) void loadFile(openResource);
    },
  );
  const highlight = button(
    "Highlight selected lines",
    "Highlight selected lines",
    () => {
      const [from, to] = lineRange(
        text.value,
        selectionStart.valueAsNumber,
        selectionEnd.valueAsNumber,
      );
      text.focus();
      text.setSelectionRange(from, to);
      selectionReport();
    },
  );
  text.addEventListener("select", selectionReport);
  const link = button(
    "Link selected pane metadata only",
    "Link selected pane metadata only",
    async () => {
      if (!project || !panes.value) return;
      state("loading", "Linking pane metadata…");
      const result = await request<{ resource: Resource; bindings: Binding[] }>(
        {
          action: "link_pane",
          project_id: project.id,
          pane_id: panes.value,
          base_revision: revision,
        },
      );
      if (result) {
        showBindings(result.bindings);
        state("ready", "Pane metadata linked.");
      }
    },
  );
  const bind = button(
    "Bind open file to pane",
    "Bind open file to pane",
    async () => {
      if (!project || !openResource || !panes.value) return;
      state("loading", "Binding file metadata…");
      const result = await request<{ bindings: Binding[] }>({
        action: "bind",
        project_id: project.id,
        resource_id: openResource.id,
        pane_id: panes.value,
        base_revision: revision,
        role: "project_files",
      });
      if (result) {
        showBindings(result.bindings);
        state("ready", "File binding saved.");
      }
    },
  );
  panes.addEventListener("change", updateButtons);
  const agent = button(
    "Ask agent about project",
    "Ask agent about project",
    () => {},
  );
  agent.disabled = true;
  agent.title = "Coming in Slice B";
  const doctorButton = button("Open doctor", "Open doctor", async () => {
    state("loading", "Loading workbench diagnostics…");
    const result = await request<Record<string, unknown>>({ action: "doctor" });
    if (!result) return;
    doctor.replaceChildren(el("h3", "", "Doctor"));
    for (const key of [
      "schema_version",
      "server_build",
      "frontend_build",
      "renderer_support",
      "gateway_compatibility",
      "active_workbench_jobs",
      "execution",
      "recovery",
      "authority",
    ])
      doctor.append(field(key, JSON.stringify(result[key] ?? null)));
    state("ready", "Doctor diagnostics loaded.");
  });
  fileView.append(
    el("h3", "", "File preview"),
    filePath,
    fileMeta,
    stale,
    refreshFile,
    text,
    labelled('From line',selectionStart),
    labelled('Through line',selectionEnd),
    highlight,
    selection,
  );
  fileView.hidden = true;
  inspector.append(
    el("div", "workbench-project-meta"),
    button('Revoke project access','Revoke project access',async()=>{
      if(!project||!window.confirm('Revoke future Workbench reads of this project? Previously displayed data cannot be recalled. Files, terminals, conversations and layout are not changed.'))return;
      invalidate();const selected=project;
      const result=await request<{project:Project}>({action:'revoke_project',project_id:selected.id,base_generation:selected.generation});
      if(!result)return;
      project=null;inspection=null;openResource=null;openSnapshot=null;text.value='';inspector.hidden=true;
      repository.replaceChildren();files.replaceChildren();bindingsView.replaceChildren();fileMeta.textContent='';
      await list();state('revoked','Future project reads are blocked. Register again with a fresh preview to restore owner observation.');
    }),
    refreshInspection,
    repository,
    files,
    fileView,
    panes,
    link,
    bind,
    el(
      "p",
      "workbench-note",
      "Pane links and bindings are metadata only; they do NOT authorize file disclosure or execution.",
    ),
    bindingsView,
    execution,
    agent,
    el(
      "p",
      "workbench-note",
      "Ask agent about project is disabled in Slice A; recipient-bound context sharing arrives in Slice B.",
    ),
  );
  inspector.hidden = true;
  registration.append(labelled('Project root',root),labelled('Project name',name),preview,approvalView,confirm);
  dialog.append(
    el("header", "", ""),
    status,
    labelled('Text size',textSize),
    registration,
    el("h3", "", "Projects"),
    button('Refresh projects and panes','Refresh projects and panes',()=>{invalidate();void list();}),
    projects,
    inspector,
    doctorButton,
    doctor,
  );
  dialog
    .querySelector("header")
    ?.append(el("h2", "", "Comet Project Workbench"), close);
  dialog.addEventListener("close", () => {
    invalidate();
    dialog.remove();
    previousFocus?.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  void list();
}
