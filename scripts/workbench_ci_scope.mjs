#!/usr/bin/env node
// Dependency-free Workbench CI scope detector.
//
// The Workbench browser gate is policy-light on every push/pull request and
// policy-deep for Workbench-related paths, release branches/tags, release-target
// pull requests, the weekly schedule and manual dispatch. This module owns that
// decision so it can be unit-tested instead of buried in shell.
//
// The caller computes the changed-file list (git diff) and passes any diff failure
// as --diff-error. An unknown event or an unreadable diff resolves to the FULL
// gate: the detector must never turn a failed diff into a silent "false".
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// Paths whose change exercises the deferred Workbench suites or their generator
// and workflow dependencies. Kept narrow on purpose; the light suites always run.
export const WORKBENCH_PATTERNS = Object.freeze([
  /^src\/(?:workbench[-.]|pane-workbench|project-workbench|candidate-diff-)/,
  /^server\/(?:workbench(?:[.-]|$)|project-(?:tools|files)(?:[.-]|$))/,
  // The primary store owns the Workbench tables and writer-version fence.
  /^server\/sqlite-workspace-store\.mjs$/,
  /^contracts\/(?:workbench-|project-tools)/,
  /^tests\/(?:workbench[-_]|test_workbench|project-workbench)/,
  /^tests\/browser_workspace\.py$/,
  /^hermes-plugin\/workbench/,
  // Deferred generator and its workflow: editing either changes what the deep
  // gate covers, so the deep gate must run.
  /^scripts\/generate-workbench-contract\.mjs$/,
  /^scripts\/workbench_ci_scope\.mjs$/,
  /^\.github\/workflows\/workbench\.yml$/,
]);

export function isWorkbenchPath(file) {
  return WORKBENCH_PATTERNS.some(pattern => pattern.test(file));
}

const RELEASE_REF = /^refs\/(?:heads\/release\/|tags\/)/;
const ZERO_SHA = /^0+$/;

export function shouldRunWorkbench({event = '', ref = '', baseRef = '', before = '', diffError = false, changedFiles = []} = {}) {
  // A failed diff or an unreadable range must not skip the deep gate.
  if (diffError) return true;
  // The weekly schedule and manual dispatch exercise every suite.
  if (event === 'schedule' || event === 'workflow_dispatch') return true;
  // Releases, release-branch pushes and tags validate the packaged Workbench.
  if (RELEASE_REF.test(ref)) return true;
  // A pull request into a release branch is release validation even though its
  // own ref is refs/pull/<n>/merge rather than the release branch.
  if (event === 'pull_request' && baseRef.startsWith('release/')) return true;
  if (event === 'pull_request' || event === 'push') {
    // A new branch without a reachable previous commit runs the full gate.
    if (event === 'push' && (!before || ZERO_SHA.test(before))) return true;
    return changedFiles.some(isWorkbenchPath);
  }
  // Unknown/unsupported events fail closed to the full gate.
  return true;
}

function parseArgs(argv) {
  const options = {event: '', ref: '', baseRef: '', before: '', diffError: false};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--event') options.event = argv[++index] ?? '';
    else if (token === '--ref') options.ref = argv[++index] ?? '';
    else if (token === '--base-ref') options.baseRef = argv[++index] ?? '';
    else if (token === '--before') options.before = argv[++index] ?? '';
    else if (token === '--diff-error') options.diffError = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw Error(`Unknown argument: ${token}`);
  }
  return options;
}

function readChangedFiles() {
  // An unreadable input is a detector error; the workflow falls back to full.
  const input = readFileSync(0, 'utf8');
  return input.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line).filter(line => line !== '');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: workbench_ci_scope.mjs --event EVENT [--ref REF] [--base-ref BASE] [--before SHA] [--diff-error] [< changed-files]\n');
    return;
  }
  const changedFiles = readChangedFiles();
  const run = shouldRunWorkbench({...options, changedFiles});
  const reason = options.diffError ? 'diff-error'
    : run ? changedFiles.find(isWorkbenchPath) || 'policy-full'
    : 'no-workbench-path';
  process.stderr.write(`workbench scope: ${run ? 'run' : 'skip'} (${reason})\n`);
  process.stdout.write(`workbench=${run}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
