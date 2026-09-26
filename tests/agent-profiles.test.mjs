import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentProfiles, validSessionId, sanitizeSessions, sanitizeHistory } from '../server/agent-profiles.mjs';

const configured = { apiUrl: null, apiKey: null };
const entry = { id: 'team_1', label: 'Team', apiUrl: 'https://hermes.example/p/team_1/', apiKey: 'private-key' };

test('legacy default and explicit profiles map public routes to private origins', () => {
  const profiles = createAgentProfiles({ profiles: [entry], apiUrl: 'http://127.0.0.1:28643', apiKey: 'legacy-secret' });
  assert.deepEqual(profiles.list, [{ id: 'default', label: 'Default' }, { id: 'team_1', label: 'Team' }]);
  assert.equal(profiles.defaultId, 'default');
  assert.deepEqual(profiles.get('team_1'), { ...entry, apiUrl: 'https://hermes.example/p/team_1', legacy: false });
  assert.deepEqual(profiles.resolveRun('team_1'), { url: 'https://hermes.example/p/team_1/v1/runs', apiKey: 'private-key' });
  assert.equal(profiles.runPath('team_1'), '/p/team_1/v1/runs');
  assert.equal(profiles.resolveRun('default').url, 'http://127.0.0.1:28643/v1/runs');
  assert.equal(profiles.get('missing'), null);
  assert.equal(profiles.runPath('missing'), null);
  assert.ok(!JSON.stringify(profiles.list).includes('private-key'));
  assert.ok(!JSON.stringify(profiles.list).includes('hermes.example'));
  assert.ok(!JSON.stringify(profiles.list).includes('legacy-secret'));
});

test('JSON configuration, empty configuration, and failed configuration', () => {
  assert.deepEqual(createAgentProfiles({ ...configured, profilesJson: JSON.stringify([entry]) }).list, [{ id: 'team_1', label: 'Team' }]);
  assert.deepEqual(createAgentProfiles({ ...configured, profiles: [] }).list, []);
  assert.deepEqual(createAgentProfiles({ ...configured, profilesJson: '[]' }).list, []);
  for (const profilesJson of ['{', '{}', 'null', JSON.stringify([{ ...entry, apiKey: '' }])]) {
    assert.throws(() => createAgentProfiles({ ...configured, profilesJson }), error => error.message === 'Invalid Hermes profiles configuration.');
  }
  assert.throws(() => createAgentProfiles({ profiles: [entry], apiUrl: 'http://ok.test', apiKey: 'secret', profilesJson: '[]' }));
  assert.throws(() => createAgentProfiles({ profiles: [entry], apiUrl: 'http://ok.test', apiKey: null }));
});

test('strict IDs, URLs, schemas and duplicates fail closed without echoing credentials', () => {
  for (const id of ['with:colon', 'a/b', '', 'x'.repeat(65), '../escape']) {
    assert.throws(() => createAgentProfiles({ ...configured, profiles: [{ ...entry, id }] }));
  }
  for (const apiUrl of ['file:///tmp/a', 'https://user:password@hermes.example', 'https://hermes.example/../path', 'https://hermes.example?key=secret', 'https://hermes.example/#anchor', 'https://hermes.example\\bad', 'http://hermes.example/%2e%2e', 'http://hermes.example:bad', 'http://hermes.example:80@evil.example']) {
    assert.throws(() => createAgentProfiles({ ...configured, profiles: [{ ...entry, apiUrl }] }), error => !error.message.includes('private-key') && !error.message.includes(apiUrl));
  }
  for (const bad of [{ ...entry, secret: 'leak' }, { ...entry, label: '\n' }, { ...entry, apiKey: 123 }, null]) {
    assert.throws(() => createAgentProfiles({ ...configured, profiles: [bad] }));
  }
  assert.throws(() => createAgentProfiles({ ...configured, profiles: [entry, entry] }));
  assert.throws(() => createAgentProfiles({ profiles: [entry, { ...entry, id: 'default' }], apiUrl: 'http://default.test', apiKey: 'legacy' }));
});

test('session identifiers and session page retain safe bounded display fields only', () => {
  for (const id of ['a', 'orbit-abc_123:xyz', 'x'.repeat(128)]) assert.equal(validSessionId(id), true);
  for (const id of ['', 'x'.repeat(129), '../sessions', 'a?b', 'a/b', '%2e', 12]) assert.equal(validSessionId(id), false);
  const page = sanitizeSessions({ data: [
    { id: 'ok', title: 't'.repeat(400), updated_at: 'd'.repeat(200), apiKey: 'SECRET' },
    { id: '../bad', title: 'bad' },
    ...Array.from({ length: 110 }, (_, i) => ({ id: `s${i}`, title: 'safe' })),
  ], has_more: false, auth: 'SECRET' });
  assert.equal(page.data.length, 99);
  assert.equal(page.has_more, true);
  assert.equal(page.data[0].title.length, 200);
  assert.equal(page.data[0].updated_at.length, 100);
  assert.ok(!JSON.stringify(page).includes('SECRET'));
  assert.deepEqual(sanitizeSessions(null), { data: [], has_more: false });
});

test('history excludes tool/system metadata and respects 80/16k/120k bounds', () => {
  const history = sanitizeHistory({ data: [
    { role: 'system', content: 'SECRET' },
    { role: 'assistant', content: 'orphan' },
    { role: 'user', content: 'u'.repeat(20000), private: 'SECRET' },
    { role: 'tool', content: 'SECRET' },
    { role: 'assistant', content: 'tool call', tool_calls: [{}] },
    ...Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000), extra: 'SECRET' })),
  ] });
  assert.ok(history.length <= 80);
  assert.ok(history.reduce((sum, message) => sum + message.text.length, 0) <= 120000);
  assert.ok(history.every(message => Object.keys(message).join(',') === 'role,text' && message.text.length <= 16000));
  assert.equal(history[0].role, 'user');
  assert.ok(!JSON.stringify(history).includes('SECRET'));
  assert.deepEqual(sanitizeHistory([{ role: 'user', content: 'hello' }, { role: 'assistant', text: 'hi' }]), [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }]);
});
