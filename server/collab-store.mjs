import fs from 'node:fs';
import path from 'node:path';
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
    return { meta, version };
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

  return { load, save, writeProject, appendEvent, readEvents, putArtifact, readArtifact, listProjects, listArtifactMetas, removeProject };
}
