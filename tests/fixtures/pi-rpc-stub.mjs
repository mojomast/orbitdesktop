#!/usr/bin/env node
/**
 * A stand-in for `pi --mode rpc` so gateway tests never need a model credential.
 *
 * It speaks the documented record shapes: correlated command responses, session
 * events with deltas, tool execution events, an extension dialog request, and an
 * abort path. Prompts can select a scripted behavior:
 *
 *   [FAIL]  provider failure path: auto_retry_end with success false, no text
 *   [ASK]   extension_ui_request before the run; the run only continues when the
 *           client answers it
 *   [SLOW]  long run that only settles when the caller aborts
 *
 * It also supports `--session-id`, `--name`, and `--session-dir` and records the
 * commands it received to `PI_STUB_COMMANDS` when that variable names a file.
 */
import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const value = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
};
const sessionId = value('--session-id') || 'stub-session';
const sessionName = value('--name') || '';
const commandsFile = process.env.PI_STUB_COMMANDS || '';

let buffer = '';
let runTimer = null;
const pendingDialogs = new Map();

function write(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function remember(record) {
  if (!commandsFile) return;
  try {
    fs.appendFileSync(commandsFile, `${JSON.stringify(record)}\n`);
  } catch {}
}

function textOf(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message?.content)) return message.content.filter(block => block?.type === 'text').map(block => block.text).join('');
  return typeof message?.content === 'string' ? message.content : '';
}

function runPrompt(id, message) {
  const failure = message.includes('[FAIL]');
  const ask = message.includes('[ASK]');
  const slow = message.includes('[SLOW]');
  const reply = failure ? '' : `hello from pi: ${message.split('\n')[0].slice(0, 60)}`;
  write({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  write({ type: 'agent_start' });
  if (failure) {
    setTimeout(() => {
      write({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'provider refused this request' });
      write({ type: 'agent_end', messages: [], willRetry: false });
      write({ type: 'agent_settled', aborted: false });
    }, 5);
    return;
  }
  if (slow) {
    runTimer = setTimeout(() => {
      write({ type: 'agent_end', messages: [], willRetry: false });
      write({ type: 'agent_settled', aborted: false });
    }, 30_000);
    return;
  }
  write({ type: 'turn_start' });
  write({ type: 'message_start', message: { role: 'assistant', content: [] } });
  const chunks = [reply.slice(0, 5), reply.slice(5)];
  write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunks[0] } });
  write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunks[1] } });
  write({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: { path: 'README.md' } });
  write({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'read', result: { content: [{ type: 'text', text: 'file body' }] }, isError: false, durationMs: 3 });
  write({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' },
  });
  write({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] });
  const settle = () => {
    write({ type: 'agent_end', messages: [], willRetry: false });
    write({ type: 'agent_settled', aborted: false });
  };
  runTimer = setTimeout(settle, 5);
  if (ask) {
    const dialogId = 'dialog-1';
    pendingDialogs.set(dialogId, () => {
      clearTimeout(runTimer);
      runTimer = setTimeout(settle, 5);
    });
    write({ type: 'extension_ui_request', id: dialogId, method: 'confirm', title: 'Trust this folder?', message: 'A project file wants to run.', timeout: 10_000 });
  }
}

function handle(record) {
  if (!record || typeof record !== 'object') return;
  remember(record);
  const id = typeof record.id === 'string' ? record.id : '';
  if (record.type === 'extension_ui_response') {
    const resume = pendingDialogs.get(record.id);
    if (resume) pendingDialogs.delete(record.id);
    if (resume) resume();
    return;
  }
  if (record.type === 'get_state') {
    write({
      id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { model: { id: 'stub-model' }, isStreaming: false, sessionId, ...(sessionName ? { sessionName } : {}), messageCount: 1 },
    });
    return;
  }
  if (record.type === 'get_messages') {
    write({ id, type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
    return;
  }
  if (record.type === 'prompt') {
    runPrompt(id, textOf(record.message));
    return;
  }
  if (record.type === 'abort') {
    clearTimeout(runTimer);
    write({ id, type: 'response', command: 'abort', success: true });
    write({ type: 'agent_settled', aborted: true });
    return;
  }
  write({ id, type: 'response', command: record.type, success: false, error: `stub cannot ${record.type}` });
}

process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      process.stderr.write('stub could not parse a command\n');
    }
  }
});

process.stdin.on('end', () => {
  clearTimeout(runTimer);
  process.exit(0);
});

process.stderr.write('stub pi ready\n');
