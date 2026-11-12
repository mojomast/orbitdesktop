// Read-only ACDD evidence view. Orbit only displays contracts and the
// bundlebees verifier's records; it never decides acceptance itself.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
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
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const EVIDENCE_KEY_LABEL = 'bundlebees/tdd-evidence/1';

function hex4(codePoint) {
  return codePoint.toString(16).padStart(4, '0');
}

function escapeString(value) {
  let out = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x22) out += '\\"';
    else if (codePoint === 0x5c) out += '\\\\';
    else if (codePoint === 0x08) out += '\\b';
    else if (codePoint === 0x0c) out += '\\f';
    else if (codePoint === 0x0a) out += '\\n';
    else if (codePoint === 0x0d) out += '\\r';
    else if (codePoint === 0x09) out += '\\t';
    else if (codePoint >= 0x20 && codePoint <= 0x7e) out += character;
    else if (codePoint <= 0xffff) out += `\\u${hex4(codePoint)}`;
    else {
      const astral = codePoint - 0x10000;
      out += `\\u${hex4(0xd800 + (astral >> 10))}\\u${hex4(0xdc00 + (astral & 0x3ff))}`;
    }
  }
  return `${out}"`;
}

function codePointsOf(value) {
  return Array.from(value, character => character.codePointAt(0));
}

function compareCodePoints(left, right) {
  const a = codePointsOf(left);
  const b = codePointsOf(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function normalizeExponent(value) {
  const match = /^(-?)(\d+(?:\.\d+)?)e([+-]?)(\d+)$/.exec(value);
  if (!match) return value;
  const digits = match[4].padStart(2, '0');
  return `${match[1]}${match[2]}e${match[3] === '-' ? '-' : '+'}${digits}`;
}

function numberJson(value) {
  if (!Number.isFinite(value)) return 'null';
  if (Object.is(value, -0)) return '0';
  if (Number.isInteger(value)) {
    if (Math.abs(value) >= 1e21) return normalizeExponent(value.toExponential());
    return String(value);
  }
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e16) {
    return normalizeExponent(value.toExponential());
  }
  const literal = value.toString();
  return /e/i.test(literal) ? normalizeExponent(value.toExponential()) : literal;
}

// Canonical JSON matching Python json.dumps(obj, sort_keys=True,
// separators=(",", ":"), ensure_ascii=True), which bundlebees signs.
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') return numberJson(value);
  if (type === 'string') return escapeString(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort(compareCodePoints);
    return `{${keys.map(key => `${escapeString(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return 'null';
}

function signablePayload(record) {
  const payload = {};
  for (const key of Object.keys(record)) {
    if (key === 'signature' || key.startsWith('_')) continue;
    payload[key] = record[key];
  }
  return payload;
}

function keyBuffer(key) {
  if (Buffer.isBuffer(key)) return key;
  if (key instanceof Uint8Array) return Buffer.from(key);
  if (key instanceof ArrayBuffer) return Buffer.from(key);
  return null;
}

export function verifyRecordSignature(record, key) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const signature = record.signature;
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return false;
  const secret = keyBuffer(key);
  if (!secret) return false;
  const expected = createHmac('sha256', secret)
    .update(canonicalJson(signablePayload(record)), 'utf8')
    .digest();
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function bundlebeesEvidenceKey(leaseKey) {
  const secret = keyBuffer(leaseKey);
  if (!secret) return null;
  return createHmac('sha256', secret).update(EVIDENCE_KEY_LABEL, 'utf8').digest();
}

// The lease key is private to the coordinator. It is never logged, returned
// or placed in a view; unsafe keys simply disable verification.
export async function loadLeaseKey(stateDir) {
  const unavailable = reason => ({ available: false, key: null, reason });
  if (typeof stateDir !== 'string' || !stateDir) return unavailable('missing');
  const path = join(stateDir, 'lease.key');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return unavailable(error && error.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return unavailable('unsafe');
    if ((info.mode & 0o077) !== 0) return unavailable('unsafe');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      return unavailable('unsafe');
    }
    if (info.size !== 32) return unavailable('unsafe');
    const buffer = Buffer.alloc(33);
    const { bytesRead } = await handle.read(buffer, 0, 33, 0);
    if (bytesRead !== 32) return unavailable('unsafe');
    return { available: true, key: buffer.subarray(0, 32), reason: null };
  } catch {
    return unavailable('unreadable');
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing a read-only handle cannot change the verification result.
    }
  }
}

export const readLeaseKey = loadLeaseKey;

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
    hasSignature: typeof obj.signature === 'string' && SIGNATURE_RE.test(obj.signature),
    signed: false,
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

function resolveVerifier(options) {
  if (typeof options === 'function') return { verify: options, available: true };
  if (!options || typeof options !== 'object') return { verify: null, available: false };
  let verify = typeof options.verify === 'function'
    ? options.verify
    : typeof options.verifyRecord === 'function'
      ? options.verifyRecord
      : null;
  if (!verify && options.key) verify = record => verifyRecordSignature(record, options.key);
  if (!verify && Array.isArray(options.keys)) {
    verify = record => options.keys.some(key => verifyRecordSignature(record, key));
  }
  return {
    verify,
    available: options.verificationAvailable !== false && typeof verify === 'function',
  };
}

function evidenceReference(value, redact) {
  const reference = text(value);
  if (!reference) return null;
  const safe = reference.startsWith('/') || /^[A-Za-z]:[\\/]/.test(reference)
    ? reference.split(/[\\/]/).pop()
    : reference;
  return redact(safe);
}

export function buildEvidenceView(contract, records = [], report = null, options = {}) {
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

  const { verify, available: verificationAvailable } = resolveVerifier(options);
  const safeVerify = value => {
    if (!verificationAvailable || typeof verify !== 'function') return false;
    try {
      return Boolean(verify(value));
    } catch {
      return false;
    }
  };

  const hasReport = report !== null && report !== undefined;
  let trustedReport = null;
  if (hasReport && typeof report === 'object' && !Array.isArray(report)
    && text(report.contract_id) === parsedContract.id
    && parsedContract.sha256 !== null
    && text(report.contract_sha256) === parsedContract.sha256) {
    if (verificationAvailable) {
      if (safeVerify(report)) trustedReport = report;
    } else {
      trustedReport = report;
    }
  }
  if (hasReport && !trustedReport) {
    notes.push(redact('Acceptance report ignored: its signature or contract identity did not match the frozen contract.'));
  }

  if (!verificationAvailable) {
    notes.push(redact('Signature verification is unavailable; no evidence was counted.'));
  }

  const counted = [];
  let verifiedCount = 0;
  let rejectedCount = 0;
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

    if (!safeVerify(raw)) {
      rejectedCount += 1;
      if (verificationAvailable && record.by === 'verifier') {
        addFailure('evidence_tampered');
        notes.push(redact(`Evidence record ${index + 1} claims verifier output but its signature did not verify; ignored.`));
        return;
      }
      if (record.by === 'worker') {
        notes.push(redact(`Worker self-reports are not authority; ignored the ${record.phase} record ${index + 1}.`));
        return;
      }
      if (verificationAvailable) {
        notes.push(redact(`Evidence record ${index + 1} is unsigned or has an invalid signature; ignored.`));
      }
      return;
    }

    verifiedCount += 1;
    if (record.by === 'worker') {
      notes.push(redact(`Worker self-reports are not authority; ignored the ${record.phase} record ${index + 1}.`));
      return;
    }
    if (record.by !== 'verifier') {
      notes.push(redact(`Only verifier output is authoritative; ignored the ${record.phase} record ${index + 1}.`));
      return;
    }
    if (parsedContract.sha256 !== null && record.contractSha256 !== parsedContract.sha256) {
      addFailure('stale_revision');
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

  const reportPhases = trustedReport
    && trustedReport.phases
    && typeof trustedReport.phases === 'object'
    && !Array.isArray(trustedReport.phases)
    ? trustedReport.phases
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

  const reportCriteria = trustedReport
    && trustedReport.criteria
    && typeof trustedReport.criteria === 'object'
    && !Array.isArray(trustedReport.criteria)
    ? trustedReport.criteria
    : null;
  const criteria = parsedContract.criteria.map(criterion => {
    let status = 'not_run';
    let evidence = null;
    if (reportCriteria) {
      const entry = reportCriteria[criterion.id];
      if (entry && typeof entry === 'object') {
        status = typeof entry.status === 'string' ? entry.status : 'not_run';
        evidence = evidenceReference(entry.evidence, redact);
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

  const verification = {
    available: verificationAvailable,
    verified: verifiedCount,
    rejected: rejectedCount,
  };

  return {
    contractId: parsedContract.id,
    title: parsedContract.title,
    shortSha: parsedContract.shortSha,
    frozen: parsedContract.frozen,
    authority: 'bundlebees verifier',
    timeline,
    criteria,
    phases,
    accepted: Boolean(trustedReport && trustedReport.accepted === true),
    verification,
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
