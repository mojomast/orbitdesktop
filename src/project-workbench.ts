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
  git_mapping?:unknown;
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
  const gitDirectory=el('input'),commonDirectory=el('input');
  gitDirectory.setAttribute('aria-label','Linked worktree Git directory');
  commonDirectory.setAttribute('aria-label','Linked worktree common directory');
  gitDirectory.placeholder='Optional: /repo/.git/worktrees/name';
  commonDirectory.placeholder='Optional: /repo/.git';
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
  let executionMount:{dispose:()=>void;refresh?:()=>void|Promise<void>}|null=null;
  let executionProject:string|null=null;
  function disposeExecution(){executionMount?.dispose();executionMount=null;executionProject=null;}
  async function askContext(source: Record<string,unknown>){
    if(!project)return;
    const selectedProject=project.id,selectedEpoch=epoch;
    const {showWorkbenchContext}=await import('./workbench-context');
    if(!current(selectedEpoch)||project?.id!==selectedProject)return;
    showWorkbenchContext({token:getToken(),workspace_id:workspaceId,project_id:selectedProject,source:source as Parameters<typeof showWorkbenchContext>[0]['source']});
  }
  async function mountExecution(){
    if(!project)return;
    if(executionProject===project.id){void executionMount?.refresh?.();return;}
    disposeExecution();execution.replaceChildren(el('p','','Loading tasks, candidates and evidence…'));
    const selectedProject=project.id,selectedEpoch=epoch;
    const [{mountWorkbenchExecution},{mountWorkbenchTaskAuthority},{mountWorkbenchWorkflow},{mountWorkbenchTaskResult}]=await Promise.all([import('./workbench-execution'),import('./workbench-task-authority'),import('./workbench-workflow'),import('./workbench-task-result')]);
    if(!current(selectedEpoch)||project?.id!==selectedProject)return;
    execution.replaceChildren();executionProject=selectedProject;
    const taskContainer=el('div'),authorityContainer=el('div'),workflowContainer=el('div'),resultContainer=el('div','workbench-task-results-panel');execution.append(taskContainer,authorityContainer,resultContainer,workflowContainer);
    const openReview=button('Open candidate Review view','Create or select one trusted, project-bound review pane',()=>{
      openReview.disabled=true;
      void import('./workbench-review-host').then(({openWorkbenchReview})=>openWorkbenchReview(selectedProject,getToken)).then(()=>{if(current(selectedEpoch))dialog.close();}).catch(error=>{if(current(selectedEpoch))state('error',`Review view unavailable: ${error.message}`);}).finally(()=>{openReview.disabled=false;});
    });
    execution.prepend(openReview);
    const openReviewRequested=(event:Event)=>{
      const detail=(event as CustomEvent).detail;
      if(current(selectedEpoch)&&project?.id===selectedProject&&detail?.workspace_id===workspaceId&&detail?.project_id===selectedProject)openReview.click();
    };
    window.addEventListener('orbit-open-workbench-review',openReviewRequested);
    const referenceDialogs=new Set<HTMLDialogElement>();
    function openReference(title:string,request:Record<string,unknown>,evidenceId?:string){
      const dialog=el('dialog','hermes-tools-dialog'),content=el('pre','workbench-result-text'),files=el('div');
      const abort=new AbortController(),token=getToken();
      const valid=()=>!abort.signal.aborted&&current(selectedEpoch)&&project?.id===selectedProject&&getToken()===token;
      async function read(body:Record<string,unknown>){
        const response=await fetch('/api/workbench/execution',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,project_id:selectedProject,...body}),signal:abort.signal});
        const data=await response.json();if(!valid())throw Error('stale_resource');
        if(!response.ok||data.ok!==true)throw Error(typeof data.code==='string'?data.code:'unavailable');return data;
      }
      content.textContent='Loading exact recorded identity…';
      dialog.setAttribute('aria-label',title);dialog.append(el('h3','',title),button('Close','Close recorded reference',()=>dialog.close()),files,content);
      referenceDialogs.add(dialog);document.body.append(dialog);dialog.showModal();
      const authorizationTimer=setInterval(()=>{if(!valid())dialog.close();},500);
      dialog.addEventListener('close',()=>{clearInterval(authorizationTimer);abort.abort();referenceDialogs.delete(dialog);dialog.remove();},{once:true});
      void read(request).then(data=>{
        if(evidenceId){const evidence=data.evidence?.find((entry:{id:string})=>entry.id===evidenceId);if(!evidence)throw Error('unavailable');content.textContent=JSON.stringify({job:data.job,evidence},null,2);return;}
        const candidate=data.candidate;
        if(candidate?.id!==request.candidate_id||candidate?.hash!==request.candidate_hash||candidate?.generation!==request.generation)throw Error('stale_resource');
        content.textContent=JSON.stringify(candidate,null,2);
        let sequence=0;
        for(const file of candidate.files??[])files.append(button(String(file.path),'Read this file from the exact recorded candidate version',()=>{
          const selected=++sequence;content.textContent='Loading recorded file…';
          void read({...request,action:'candidate_version_read',path:file.path}).then(value=>{if(selected===sequence)content.textContent=value.file?.binary?'Binary preview unavailable.':String(value.file?.text??'');}).catch(error=>{if(valid()&&selected===sequence)content.textContent=`Recorded file unavailable: ${error.message}`;});
        }));
      }).catch(error=>{if(valid())content.textContent=`Recorded reference unavailable: ${error.message}. No newer version was substituted.`;});
    }
    const task=mountWorkbenchExecution({container:taskContainer,token:getToken,workspace_id:workspaceId,project_id:selectedProject,onAskContext:(jobId:string)=>{void askContext({kind:'job',job_id:jobId});}});
    const authority=mountWorkbenchTaskAuthority({container:authorityContainer,token:getToken,workspace_id:workspaceId,project_id:selectedProject});
    const workflow=mountWorkbenchWorkflow({container:workflowContainer,token:getToken,workspace_id:workspaceId,project_id:selectedProject});
    const result=mountWorkbenchTaskResult({container:resultContainer,token:getToken,workspace_id:workspaceId,project_id:selectedProject,onOpenEvidence:ref=>openReference('Exact recorded check evidence',{action:'job_get',job_id:ref.job_id},ref.evidence_id),onOpenCandidate:ref=>openReference('Exact recorded candidate version',{action:'candidate_version_get',...ref})});
    executionMount={dispose(){window.removeEventListener('orbit-open-workbench-review',openReviewRequested);task.dispose();authority.dispose();workflow.dispose();result.dispose();for(const dialog of referenceDialogs)dialog.close();},async refresh(){await Promise.all([task.refresh(),authority.refresh(),workflow.refresh(),result.refresh()]);}};
  }
  async function askTerminal(resource:Resource){
    if(!project||resource.kind!=='terminal')return;
    const selectedEpoch=epoch,selectedProject=project.id;
    try{
      const response=await fetch('/api/managed-terminals',{method:'POST',headers:{Authorization:`Bearer ${getToken()}`,'Content-Type':'application/json'},body:JSON.stringify({action:'status'})});
      const result=await response.json();
      if(!current(selectedEpoch)||project?.id!==selectedProject)return;
      if(!response.ok)throw Error('Managed terminal status unavailable.');
      const adopted=(result.resources??[]).find((entry:{pane_id:string;workspace_id:string})=>entry.pane_id===resource.pane_id&&entry.workspace_id===workspaceId);
      const lease=(result.leases??[]).find((entry:{resource_id:string;scope:string;state:string})=>entry.resource_id===adopted?.resource_id&&entry.scope==='observe'&&entry.state==='active');
      if(!lease){state('permission-denied','Use the terminal’s Managed… controls to adopt it and grant a short-lived observe lease, then explicitly capture here. Observation does not authorize model sharing.');return;}
      await askContext({kind:'terminal',resource_id:resource.id,lease_id:lease.lease_id});
    }catch{if(current(selectedEpoch))state('unavailable','Cannot read managed terminal metadata. No output was shared.');}
  }

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
    agent.disabled=!project||!openResource||!openSnapshot||openSnapshot.binary;
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
      if(resource?.kind==='terminal')bindingsView.append(button('Ask agent about this terminal','Ask agent about this terminal',()=>{void askTerminal(resource);}));
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
    void mountExecution();
    updateButtons();
  }
  async function inspect() {
    if (!project) return;
    invalidate();
    if(project.active===false){
      repository.replaceChildren(field('State','Project access revoked. Existing job cancellation and agent supervision remain available.'));
      files.replaceChildren();fileView.hidden=true;
      await mountExecution();state('revoked','Future reads and execution are blocked. Existing records and intervention controls remain available.');return;
    }
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
          disposeExecution();
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
        ...(gitDirectory.value||commonDirectory.value?{git_mapping:{git_directory:gitDirectory.value,common_directory:commonDirectory.value}}:{}),
      });
      if (!result) return;
      approval = result;
      approvalView.replaceChildren(
        field("Digest", result.digest),
        field("Expires at", new Date(result.expires_at).toISOString()),
        field("Root", result.root),
        field("Name", result.name),
        field("Authority", result.authority),
        field('Approved Git mapping',JSON.stringify(result.git_mapping??'In-root repository only')),
        field("Limits", JSON.stringify(result.limits)),
        field("Exclusions", result.exclusions.join(", ")),
      );
      confirm.disabled = false;
      state("ready", "Review the exact approval before confirming.");
    },
  );
  for (const input of [root, name,gitDirectory,commonDirectory])
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
        if(inspection&&!inspection.resources.some(resource=>resource.id===result.resource.id))inspection.resources.push(result.resource);
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
    "Ask agent about this",
    "Ask agent about this",
    () => {
      if(!openResource||!openSnapshot)return;
      const first=text.selectionStart===text.selectionEnd?selectionStart.valueAsNumber:text.value.slice(0,text.selectionStart).split('\n').length;
      const last=text.selectionStart===text.selectionEnd?selectionEnd.valueAsNumber:text.value.slice(0,text.selectionEnd).split('\n').length;
      void askContext({kind:'file',resource_id:openResource.id,start_line:Math.max(1,first||1),end_line:Math.max(first,last||first),expected_hash:openSnapshot.hash});
    },
  );
  agent.disabled = true;
  agent.title = "Preview the selected snapshot and recipient before sharing once.";
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
    agent,
  );
  fileView.hidden = true;
  inspector.append(
    el("div", "workbench-project-meta"),
    button('Revoke project access','Revoke project access',async()=>{
      if(!project||!window.confirm('Revoke future Workbench reads of this project? Previously displayed data cannot be recalled. Files, terminals, conversations and layout are not changed.'))return;
      invalidate();const selected=project;
      const result=await request<{project:Project}>({action:'revoke_project',project_id:selected.id,base_generation:selected.generation});
      if(!result)return;
      const revoked=result as {project?:Project};
      project=revoked.project??{...selected,active:false};inspection=null;openResource=null;openSnapshot=null;text.value='';inspector.hidden=false;
      disposeExecution();
      repository.replaceChildren();files.replaceChildren();bindingsView.replaceChildren();fileMeta.textContent='';
      await list();await mountExecution();state('revoked','Future project reads are blocked. Existing job cancellation and agent supervision remain available. Register again with fresh approval to restore access.');
    }),
    refreshInspection,
    repository,
    button('Ask agent about this diff','Ask agent about this diff',()=>{if(inspection?.repository.snapshot_hash)void askContext({kind:'diff',expected_hash:inspection.repository.snapshot_hash});}),
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
    button('Activity and disclosures','Activity and disclosures',async()=>{
      if(!project)return;
      const selectedProject=project.id,selectedEpoch=epoch;
      const {showWorkbenchActivity}=await import('./workbench-context');
      if(current(selectedEpoch)&&project?.id===selectedProject)showWorkbenchActivity({token:getToken(),workspace_id:workspaceId,project_id:selectedProject});
    }),
    execution,
    el(
      "p",
      "workbench-note",
      "Capture and disclosure are separate. Review exact snapshots and the selected recipient before Share once.",
    ),
  );
  inspector.hidden = true;
  registration.append(labelled('Project root',root),labelled('Project name',name),labelled('Linked worktree Git directory',gitDirectory),labelled('Linked worktree common directory',commonDirectory),preview,approvalView,confirm);
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
    disposeExecution();
    dialog.remove();
    previousFocus?.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  void list();
}
