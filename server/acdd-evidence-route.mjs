// Read-only HTTP surface for bundlebees ACDD contracts and evidence.
// Orbit never writes, signs or decides acceptance here; it only displays
// what the bundlebees verifier recorded.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRedactor } from './grokbots-activity.mjs';
import {
  buildEvidenceView, bundlebeesEvidenceKey, loadLeaseKey, readEvidenceDir, toActivityItems, verifyRecordSignature,
} from './acdd-evidence.mjs';

const CONTRACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_EVIDENCE_DIRS = 200;
const MAX_LEASE_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  res.writeHead(status, HEADERS);
  res.end(headOnly ? undefined : body);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error) {
  return Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function loadLeaseContracts(stateDir) {
  const dir = join(stateDir, 'leases');
  let dirStat;
  try {
    dirStat = await lstat(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!dirStat.isDirectory()) return [];

  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const contracts = [];
  for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
    const path = join(dir, name);
    let fileStat;
    try {
      fileStat = await lstat(path);
    } catch {
      continue;
    }
    if (!fileStat.isFile() || fileStat.size > MAX_LEASE_BYTES) continue;

    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    const contract = isObject(parsed) && isObject(parsed.brief) ? parsed.brief.contract : null;
    if (isObject(contract) && typeof contract.id === 'string') {
      contracts.push({ file: name, contract });
    }
  }
  return contracts;
}

function selectContract(matches, newestSha) {
  if (matches.length === 0) return null;
  if (newestSha) {
    const preferred = matches.filter(match => (
      isObject(match.contract.review) && match.contract.review.contract_sha256 === newestSha
    ));
    if (preferred.length > 0) return preferred[preferred.length - 1].contract;
  }
  return matches[matches.length - 1].contract;
}

async function evidenceDirState(stateDir, contractId) {
  try {
    const entry = await lstat(join(stateDir, 'evidence', contractId));
    return entry.isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function newestEvidenceSha(records) {
  const newest = records.length > 0 ? records[records.length - 1] : null;
  const sha = newest && newest.contract_sha256;
  return typeof sha === 'string' && sha ? sha : null;
}

async function countEvidenceRecords(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = await lstat(join(dir, name));
      if (entry.isFile()) count += 1;
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return count;
}

async function listContracts(stateDir) {
  const evidenceRoot = join(stateDir, 'evidence');
  let rootStat;
  try {
    rootStat = await lstat(evidenceRoot);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!rootStat.isDirectory()) return [];

  let names;
  try {
    names = await readdir(evidenceRoot);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const ids = [];
  for (const name of names.filter(entry => CONTRACT_ID_RE.test(entry)).sort()) {
    if (ids.length >= MAX_EVIDENCE_DIRS) break;
    try {
      const entry = await lstat(join(evidenceRoot, name));
      if (entry.isDirectory()) ids.push(name);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  ids.sort();

  const leases = await loadLeaseContracts(stateDir);
  const redact = makeRedactor();
  const contracts = [];
  for (const id of ids) {
    const dir = join(evidenceRoot, id);
    const records = await countEvidenceRecords(dir);
    const matches = leases.filter(match => match.contract.id === id);
    let title = null;
    if (matches.length > 0) {
      let newestSha = null;
      if (matches.length > 1) {
        try {
          newestSha = newestEvidenceSha((await readEvidenceDir(evidenceRoot, id)).records);
        } catch {
          newestSha = null;
        }
      }
      const contract = selectContract(matches, newestSha);
      if (contract && typeof contract.title === 'string') title = redact(contract.title);
    }
    contracts.push({ id, title, records });
  }
  return contracts;
}

function verificationKeys(keyState) {
  if (!keyState || !keyState.available || !keyState.key) return [];
  const keys = [keyState.key];
  const derived = bundlebeesEvidenceKey(keyState.key);
  if (derived) keys.push(derived);
  return keys;
}

function verifiesWithKeys(record, keys) {
  return keys.some(key => verifyRecordSignature(record, key));
}

async function readAcceptanceReport(stateDir, contractId, keys) {
  if (keys.length === 0) return null;
  const path = join(stateDir, 'reports', `${contractId}.json`);
  let reportStat;
  try {
    reportStat = await lstat(path);
  } catch {
    return null;
  }
  if (!reportStat.isFile() || reportStat.size > MAX_REPORT_BYTES) return null;

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(parsed) || !verifiesWithKeys(parsed, keys)) return null;
  return parsed;
}

async function readContractView(stateDir, contractId) {
  const evidenceExists = await evidenceDirState(stateDir, contractId);
  let records = [];
  let skipped = [];
  if (evidenceExists) {
    const evidence = await readEvidenceDir(join(stateDir, 'evidence'), contractId);
    records = evidence.records;
    skipped = evidence.skipped;
  }

  const leases = await loadLeaseContracts(stateDir);
  const matches = leases.filter(match => match.contract.id === contractId);
  const contract = selectContract(matches, newestEvidenceSha(records));

  if (!evidenceExists && !contract) {
    return { status: 404, payload: { error: 'unknown contract' } };
  }
  if (evidenceExists && !contract) {
    return { status: 404, payload: { error: 'contract not found in bundlebees leases' } };
  }

  const keyState = await loadLeaseKey(stateDir);
  const keys = verificationKeys(keyState);
  const report = await readAcceptanceReport(stateDir, contractId, keys);
  const view = buildEvidenceView(contract, records, report, {
    verify: record => verifiesWithKeys(record, keys),
    verificationAvailable: keys.length > 0,
  });
  return {
    status: 200,
    payload: {
      configured: true,
      view,
      verification: view.verification,
      items: toActivityItems(view),
      skipped: skipped.length,
    },
  };
}

export function createAcddEvidenceRoute({ stateDir, authorize } = {}) {
  async function handle(req, res, url) {
    const headOnly = String(req && req.method ? req.method : 'GET').toUpperCase() === 'HEAD';
    try {
      let authorized = false;
      try {
        authorized = Boolean(await authorize(req));
      } catch {
        authorized = false;
      }
      if (!authorized) {
        return send(res, 403, { error: 'Orbit authentication required' }, headOnly);
      }

      const method = String(req && req.method ? req.method : 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        return send(res, 405, { error: 'method not allowed' });
      }

      if (!stateDir) {
        return send(res, 200, { configured: false, contracts: [] }, headOnly);
      }

      const contractId = url && url.searchParams ? url.searchParams.get('contract') : null;
      if (contractId !== null) {
        if (!CONTRACT_ID_RE.test(contractId)) {
          return send(res, 400, { error: 'invalid contract id' }, headOnly);
        }
        const result = await readContractView(stateDir, contractId);
        return send(res, result.status, result.payload, headOnly);
      }

      const contracts = await listContracts(stateDir);
      return send(res, 200, { configured: true, contracts }, headOnly);
    } catch {
      try {
        return send(res, 500, { error: 'evidence unavailable' }, headOnly);
      } catch {
        return undefined;
      }
    }
  }

  return { handle };
}
