// Read-only ACDD evidence view. Orbit only displays contracts and the
// bundlebees verifier's records; it never decides acceptance itself.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRedactor } from './grokbots-activity.mjs';

export const FAILURE_TEXT = Object.freeze({
  contract_invalid: 'The contract is missing required fields or uses an unsupported version.',
  contract_not_frozen: 'The contract has not been frozen by an approved human review.',
  contract_changed: 'The contract changed after evidence was collected.',
  red_invalid: 'The RED record does not show the expected behavioral failure.',
  red_incomplete: 'The RED record does not cover every acceptance criterion.',
  red_missing: 'No valid RED record was supplied.',
  stale_revision: 'The evidence was recorded against a different contract revision.',
  tests_tampered: 'The verifier found the test files or fingerprints were changed.',
  scope_violation: 'The change touched files outside the assigned scope.',
  green_failed: 'The GREEN verification did not pass.',
  refactor_failed: 'The refactor verification did not pass.',
  integration_failed: 'The integration verification did not pass.',
  review_failed: 'The independent review did not pass.',
  evidence_tampered: 'The evidence record failed its integrity check.',
  unrun: 'This required check has not run yet.',
});

export const STATUS_LABEL = Object.freeze({
  passed: 'Passed',
  failed: 'Failed',
  not_run: 'Not run',
  unrun: 'Not run',
  review_required: 'Needs review',
  valid: 'Valid',
});

const CONTRACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function failureText(code) {
  return FAILURE_TEXT[code] ?? `Unknown failure: ${code}`;
}

function label(status) {
  return STATUS_LABEL[status] ?? String(status ?? 'unknown');
}

export function parseContract(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw fail('contract_invalid', 'Contract must be an object.');
  }
  if (obj.contract_version !== 'acdd/1') {
    throw fail('contract_invalid', 'Contract must use contract_version acdd/1.');
  }
  const id = text(obj.id).trim();
  if (!id) throw fail('contract_invalid', 'Contract id is required.');
  if (!Array.isArray(obj.acceptance_criteria) || obj.acceptance_criteria.length === 0) {
    throw fail('contract_invalid', 'Contract must have a non-empty acceptance_criteria array.');
  }

  const redact = makeRedactor();
  const review = obj.review && typeof obj.review === 'object' ? obj.review : {};
  const scope = obj.scope && typeof obj.scope === 'object' ? obj.scope : {};
  const sha256 = typeof review.contract_sha256 === 'string' && review.contract_sha256
    ? review.contract_sha256
    : null;

  const criteria = obj.acceptance_criteria.map((criterion, index) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) {
      throw fail('contract_invalid', `Acceptance criterion ${index + 1} must be an object.`);
    }
    const criterionId = text(criterion.id).trim();
    if (!criterionId) {
      throw fail('contract_invalid', `Acceptance criterion ${index + 1} needs an id.`);
    }
    const given = text(criterion.given);
    const when = text(criterion.when);
    const then = text(criterion.then);
    const plain = given && when && then
      ? `Given ${given}, When ${when}, Then ${then}`
      : text(criterion.statement);
    return {
      id: redact(criterionId),
      text: redact(plain),
      verification: text(criterion.verification),
      tests: stringList(criterion.tests),
      regression: criterion.regression === true,
    };
  });

  return {
    id: redact(id),
    title: redact(text(obj.title, id)),
    sha256,
    shortSha: sha256 ? sha256.slice(0, 12) : null,
    frozen: review.status === 'approved' && sha256 !== null,
    criteria,
    assigned: stringList(scope.assigned_files).map(item => redact(item)),
    testFiles: stringList(scope.test_files).map(item => redact(item)),
    evidenceRequired: stringList(obj.evidence_required),
  };
}

export function parseEvidence(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw fail('evidence_invalid', 'Evidence record must be an object.');
  }
  if (obj.evidence_version !== 'tdd-evidence/1') {
    throw fail('evidence_invalid', 'Evidence must use evidence_version tdd-evidence/1.');
  }
  const phase = text(obj.phase).trim();
  if (!phase) throw fail('evidence_invalid', 'Evidence record needs a phase.');

  const revision = text(obj.revision);
  const producedBy = obj.produced_by && typeof obj.produced_by === 'object' ? obj.produced_by : {};
  return {
    phase,
    classification: text(obj.classification, 'unknown'),
    revision,
    shortRev: revision ? revision.slice(0, 12) : null,
    at: text(obj.at),
    by: text(producedBy.role),
    testFirst: obj.test_first === true,
    criteria: obj.criteria && typeof obj.criteria === 'object' && !Array.isArray(obj.criteria)
      ? obj.criteria
      : {},
    contractSha256: text(obj.contract_sha256) || null,
    signed: typeof obj.signature === 'string' && obj.signature.length === 64,
    raw: obj,
  };
}

function recordOk(record) {
  return record.phase === 'red'
    ? record.classification === 'behavioral_failure'
    : record.classification === 'passed';
}

function phaseResult(phase, record) {
  if (!record) return 'unrun';
  if (phase === 'red') {
    return record.classification === 'behavioral_failure' ? 'valid' : 'red_invalid';
  }
  if (record.classification === 'passed') return 'valid';
  const code = `${phase}_failed`;
  return FAILURE_TEXT[code] ? code : 'unrun';
}

export function buildEvidenceView(contract, records = [], report = null) {
  const parsedContract = parseContract(contract);
  const redact = makeRedactor();
  const notes = [];
  const failures = [];
  const seenFailures = new Set();
  const addFailure = code => {
    if (!code || seenFailures.has(code)) return;
    seenFailures.add(code);
    failures.push({ code, text: failureText(code) });
  };

  const counted = [];
  const input = Array.isArray(records) ? records : [];
  input.forEach((raw, index) => {
    let record;
    try {
      record = parseEvidence(raw);
    } catch (error) {
      const reason = error && error.code === 'evidence_invalid'
        ? error.message
        : 'the record could not be read';
      notes.push(redact(`Skipped evidence record ${index + 1}: ${reason}`));
      return;
    }
    if (parsedContract.sha256 !== null && record.contractSha256 !== parsedContract.sha256) {
      addFailure('stale_revision');
      return;
    }
    if (record.by === 'worker') {
      notes.push(redact(`Worker self-reports are not authority; ignored the ${record.phase} record ${index + 1}.`));
      return;
    }
    counted.push(record);
  });

  const timeline = counted.map(record => ({
    phase: record.phase,
    classification: record.classification,
    shortRev: record.shortRev,
    at: record.at,
    by: record.by,
    ok: recordOk(record),
  }));

  const reportPhases = report && report.phases && typeof report.phases === 'object' && !Array.isArray(report.phases)
    ? report.phases
    : null;
  const phases = {};
  if (reportPhases) {
    for (const phase of parsedContract.evidenceRequired) phases[phase] = 'unrun';
    for (const [phase, value] of Object.entries(reportPhases)) {
      if (typeof value === 'string') phases[phase] = value;
    }
  } else {
    for (const phase of parsedContract.evidenceRequired) {
      const last = [...counted].reverse().find(record => record.phase === phase);
      phases[phase] = phaseResult(phase, last);
    }
  }
  for (const code of Object.values(phases)) {
    if (code !== 'valid' && code !== 'unrun') addFailure(code);
  }

  const reportCriteria = report && report.criteria && typeof report.criteria === 'object' && !Array.isArray(report.criteria)
    ? report.criteria
    : null;
  const criteria = parsedContract.criteria.map(criterion => {
    let status = 'not_run';
    let evidence = null;
    if (reportCriteria) {
      const entry = reportCriteria[criterion.id];
      if (entry && typeof entry === 'object') {
        status = typeof entry.status === 'string' ? entry.status : 'not_run';
        evidence = typeof entry.evidence === 'string' ? redact(entry.evidence) : null;
      }
    } else {
      const last = [...counted].reverse().find(record => Object.prototype.hasOwnProperty.call(record.criteria, criterion.id));
      if (last) {
        const value = last.criteria[criterion.id];
        status = typeof value === 'string' ? value : 'not_run';
      }
    }
    return {
      id: criterion.id,
      text: criterion.text,
      verification: criterion.verification,
      status,
      label: label(status),
      evidence,
    };
  });

  return {
    contractId: parsedContract.id,
    title: parsedContract.title,
    shortSha: parsedContract.shortSha,
    frozen: parsedContract.frozen,
    authority: 'bundlebees verifier',
    timeline,
    criteria,
    phases,
    accepted: Boolean(report && report.accepted === true),
    failures,
    notes,
  };
}

export function toActivityItems(view) {
  const items = [];
  for (const [phase, result] of Object.entries(view.phases ?? {})) {
    const state = result === 'valid' ? 'done' : result === 'unrun' ? 'pending' : 'error';
    const text = result === 'valid'
      ? `${phase}: valid`
      : result === 'unrun'
        ? `${phase}: not run`
        : `${phase}: ${result} - ${failureText(result)}`;
    items.push({ kind: 'acdd', id: `${view.contractId}:${phase}`, title: `ACDD ${phase}`, state, text });
  }
  items.push({
    kind: 'acdd',
    id: `${view.contractId}:summary`,
    title: `ACDD ${view.contractId}`,
    state: view.accepted ? 'done' : 'pending',
    text: view.accepted ? 'accepted' : 'not accepted yet',
  });
  return items;
}

export async function readEvidenceDir(root, contractId, { maxFiles = 200, maxBytes = 256 * 1024 } = {}) {
  if (typeof contractId !== 'string' || !CONTRACT_ID_RE.test(contractId)) {
    throw fail('evidence_invalid', 'Contract id is not a safe evidence directory name.');
  }
  if (typeof root !== 'string' || !root) {
    throw fail('evidence_invalid', 'Evidence root must be a directory path.');
  }

  const dir = join(root, contractId);
  let dirStat;
  try {
    dirStat = await lstat(dir);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { records: [], skipped: [] };
    }
    throw error;
  }
  if (!dirStat.isDirectory()) return { records: [], skipped: [] };

  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { records: [], skipped: [] };
    }
    throw error;
  }
  names.sort();

  const records = [];
  const skipped = [];
  let candidates = 0;
  for (const file of names) {
    if (!file.endsWith('.json')) {
      skipped.push({ file, reason: 'not_json' });
      continue;
    }
    if (candidates >= maxFiles) {
      skipped.push({ file, reason: 'max_files' });
      continue;
    }
    const path = join(dir, file);
    let fileStat;
    try {
      fileStat = await lstat(path);
    } catch {
      skipped.push({ file, reason: 'unreadable' });
      candidates += 1;
      continue;
    }
    if (!fileStat.isFile()) {
      skipped.push({ file, reason: 'not_regular_file' });
      continue;
    }
    candidates += 1;
    if (fileStat.size > maxBytes) {
      skipped.push({ file, reason: 'too_large' });
      continue;
    }
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      skipped.push({ file, reason: 'unreadable' });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      skipped.push({ file, reason: 'invalid_json' });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.evidence_version !== 'tdd-evidence/1') {
      skipped.push({ file, reason: 'wrong_version' });
      continue;
    }
    records.push(parsed);
  }

  return { records, skipped };
}
