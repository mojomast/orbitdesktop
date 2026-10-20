import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const projectPattern = /^p_[a-f0-9]{16}$/;
const taskPattern = /^t_[a-f0-9]{16}$/;
const artifactPattern = /^a_[a-f0-9]{16}$/;

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function mintCollabId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* the parent may already be tighter */ }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

export function createCollabStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* already private */ }

  function projectDir(id) {
    if (!projectPattern.test(id || '')) throw fail('Unknown Collab project.', 404);
    return path.join(directory, id);
  }

  function writeProject(project) {
    atomicWrite(path.join(projectDir(project.id), 'project.json'), JSON.stringify(project));
  }

  function readProject(id) {
    try {
      const project = JSON.parse(fs.readFileSync(path.join(projectDir(id), 'project.json'), 'utf8'));
      if (!project || project.id !== id) throw fail('The Collab project could not be read.');
      return project;
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('Unknown Collab project.', 404);
      if (error.status) throw error;
      throw fail('The Collab project could not be read.');
    }
  }

  function writeTask(projectId, task) {
    if (!taskPattern.test(task?.id || '')) throw fail('Unknown Collab task.', 404);
    atomicWrite(path.join(projectDir(projectId), 'tasks', `${task.id}.json`), JSON.stringify(task));
  }

  function listTasks(projectId) {
    const dir = path.join(projectDir(projectId), 'tasks');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const tasks = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try { tasks.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch { /* skip a torn file */ }
    }
    return tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function listArtifactMetas(projectId) {
    const dir = path.join(projectDir(projectId), 'artifacts');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const metas = [];
    for (const name of names) {
      if (!artifactPattern.test(name)) continue;
      try { metas.push(JSON.parse(fs.readFileSync(path.join(dir, name, 'meta.json'), 'utf8'))); } catch { /* skip */ }
    }
    return metas.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function load(id) {
    return { project: readProject(id), tasks: listTasks(id), artifacts: listArtifactMetas(id) };
  }

  function save(bundle) {
    bundle.project.updatedAt = Date.now();
    writeProject(bundle.project);
    for (const task of bundle.tasks) writeTask(bundle.project.id, task);
  }

  function appendEvent(projectId, event) {
    const file = path.join(projectDir(projectId), 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  }

  function readEvents(projectId) {
    const file = path.join(projectDir(projectId), 'events.jsonl');
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* ignore a partial trailing line */ }
    }
    return events;
  }

  function putArtifact(projectId, { name, kind, content, by, taskId, baseVersion, note }) {
    const metas = listArtifactMetas(projectId);
    let meta = metas.find(item => item.name === name);
    const latest = meta?.versions?.at(-1)?.v || 0;
    if (!meta) {
      if (baseVersion !== 0) throw fail(`Artifact ${name} does not exist yet. Start at version 0.`, 409);
      meta = { id: mintCollabId('a'), name, kind, mime: 'text/plain', taskId: taskId || '', createdAt: Date.now(), versions: [] };
    } else if (baseVersion !== latest) {
      throw fail(`Artifact ${name} is at version ${latest}. Reload it before writing.`, 409);
    }
    const version = latest + 1;
    const dir = path.join(projectDir(projectId), 'artifacts', meta.id);
    atomicWrite(path.join(dir, `v${version}.txt`), content);
    meta.versions.push({ v: version, by, at: Date.now(), note: String(note || '').slice(0, 300) });
    meta.kind = kind || meta.kind;
    if (taskId) meta.taskId = taskId;
    atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(meta));
    if (kind === 'file' || kind === 'test') mirrorWorkspaceFile(projectId, name, content);
    return { meta, version };
  }

  function workspaceDir(id) {
    const dir = path.join(projectDir(id), 'workspace');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function initWorkspace(id) {
    const dir = workspaceDir(id);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      try { spawnSync('git', ['init', '-q'], { cwd: dir, timeout: 8000, stdio: 'ignore' }); } catch { /* the directory still works without git */ }
    }
    return dir;
  }

  function safeWorkspaceFile(id, name) {
    if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return '';
    const parts = name.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return '';
    const root = path.resolve(workspaceDir(id));
    const resolved = path.resolve(root, name);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return '';
    return resolved;
  }

  function mirrorWorkspaceFile(id, name, content) {
    const dest = safeWorkspaceFile(id, name);
    if (!dest) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, content, { mode: 0o600 });
  }

  function listWorkspaceFiles(id) {
    const root = workspaceDir(id);
    const out = [];
    const walk = rel => {
      if (out.length >= 40) return;
      let entries = [];
      try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile()) {
          let stat;
          try { stat = fs.statSync(path.join(root, next)); } catch { continue; }
          if (!stat.isFile() || stat.size <= 0 || stat.size > 100000) continue;
          let content = '';
          try { content = fs.readFileSync(path.join(root, next), 'utf8'); } catch { continue; }
          if (content.includes('\u0000')) continue;
          out.push({ name: next, content });
        }
        if (out.length >= 40) return;
      }
    };
    walk('');
    return out;
  }

  function readArtifact(projectId, artifactId, version) {
    if (!artifactPattern.test(artifactId || '')) throw fail('Unknown artifact.', 404);
    const metaPath = path.join(projectDir(projectId), 'artifacts', artifactId, 'meta.json');
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail('Unknown artifact.', 404); throw fail('The artifact could not be read.'); }
    const chosen = Number.isInteger(version) && version > 0 ? version : meta.versions.at(-1)?.v;
    if (!chosen || !meta.versions.some(item => item.v === chosen)) throw fail('Unknown artifact version.', 404);
    const content = fs.readFileSync(path.join(projectDir(projectId), 'artifacts', artifactId, `v${chosen}.txt`), 'utf8');
    return { meta, version: chosen, content };
  }

  function listProjects() {
    let names = [];
    try { names = fs.readdirSync(directory); } catch { return []; }
    const projects = [];
    for (const name of names) {
      if (!projectPattern.test(name)) continue;
      try { projects.push(readProject(name)); } catch { /* skip */ }
    }
    return projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function removeProject(id) {
    fs.rmSync(projectDir(id), { recursive: true, force: true });
  }

  return { load, save, writeProject, appendEvent, readEvents, putArtifact, readArtifact, listProjects, listArtifactMetas, removeProject, initWorkspace, listWorkspaceFiles };
}
