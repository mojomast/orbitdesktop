import test from 'node:test';
import assert from 'node:assert/strict';
import {feedbackDraft} from '../apps/rizzstack-rails/feedback.js';

test('the preview is immutable, excludes private prose, and keys only the reviewed operation', () => {
  const draft = feedbackDraft('event-1', -1, 'quality', 'unstructured private text', null);
  assert.equal(draft.note,'[redacted]'); assert.equal(draft.target_event_id,'event-1');
  assert.equal(draft.rating,-1); assert.ok(Object.isFrozen(draft));
  assert.notEqual(draft.idempotency_key,feedbackDraft('event-1',1,'quality','',null).idempotency_key);
  assert.throws(()=>feedbackDraft('event-1',1,'retry','',null));
});
