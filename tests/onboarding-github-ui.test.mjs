import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP_LABELS, STEP, nextStep, previousStep } from '../src/onboarding-steps.ts';
import { parseRepoInput, repoInputError } from '../src/onboarding-repos-input.ts';

test('the wizard has six steps with GitHub and Repos between Models and Review', () => {
  assert.deepEqual(STEP_LABELS, ['Install', 'Providers & keys', 'Models', 'GitHub', 'Repos to watch', 'Review']);
  assert.deepEqual([STEP.github, STEP.repos, STEP.review], [3, 4, 5]);
});

test('custom path walks every step in order, both ways', () => {
  const forward = [0];
  while (forward.at(-1) !== STEP.review) forward.push(nextStep(forward.at(-1), 'custom'));
  assert.deepEqual(forward, [0, 1, 2, 3, 4, 5]);
  const back = [STEP.review];
  while (back.at(-1) !== 0) back.push(previousStep(back.at(-1), 'custom'));
  assert.deepEqual(back, [5, 4, 3, 2, 1, 0]);
});

test('minimal path still goes from providers straight to review, and back', () => {
  assert.equal(nextStep(STEP.providers, 'minimal'), STEP.review);
  assert.equal(previousStep(STEP.review, 'minimal'), STEP.providers);
  // Opened from the review card, the optional steps return to review.
  assert.equal(nextStep(STEP.github, 'minimal'), STEP.repos);
  assert.equal(nextStep(STEP.repos, 'minimal'), STEP.review);
  assert.equal(previousStep(STEP.github, 'minimal'), STEP.review);
});

test('repo input accepts commas, spaces, newlines and GitHub URLs', () => {
  assert.deepEqual(parseRepoInput('octo/one, octo/two\nhttps://github.com/octo/three\n\n octo/one '), ['octo/one', 'octo/two', 'octo/three']);
  assert.deepEqual(parseRepoInput(''), []);
  assert.equal(repoInputError(['octo/one']), '');
  assert.match(repoInputError(['octo']), /owner\/name/);
});
