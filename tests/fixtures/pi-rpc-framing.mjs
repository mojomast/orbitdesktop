#!/usr/bin/env node
/**
 * A framing probe for `createPiRpc`.
 *
 * It answers `get_state` with a record whose text contains U+2028 and U+2029.
 * A client that uses `readline` would split that record in two and fail to parse
 * it; a client that splits on LF only reads it whole.
 */
const argv = process.argv.slice(2);
const index = argv.indexOf('--session-id');
const sessionId = index >= 0 ? argv[index + 1] : 'framing';

let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const at = buffer.indexOf('\n');
    if (at < 0) break;
    const line = buffer.slice(0, at).replace(/\r$/, '');
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const id = typeof record.id === 'string' ? record.id : '';
    if (record.type === 'get_state') {
      process.stdout.write(`${JSON.stringify({ id, type: 'response', command: 'get_state', success: true, data: { sessionId, text: 'before\u2028middle\u2029after' } })}\n`);
      continue;
    }
    if (record.type === 'get_messages') {
      process.stdout.write(`${JSON.stringify({ id, type: 'response', command: 'get_messages', success: true, data: { messages: [] } })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({ id, type: 'response', command: record.type, success: false, error: 'framing probe has one job' })}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));
