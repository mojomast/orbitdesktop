import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LocalHostProvider, captureHistory } from '../server/local-host.mjs';
test('capture retained output beyond viewport, including alternate-screen shell history', async () => {
 const pane_id = randomUUID();
 const shell = new LocalHostProvider().spawn({cols:80, rows:24, pane_id});
 const waitFor = (command, marker) => new Promise((resolve,reject) => {
  let output=''; const timeout=setTimeout(()=>{sub.dispose();reject(Error('timeout'));},8000);
  const sub=shell.onData(data=>{output+=data;if(output.includes(marker)){clearTimeout(timeout);sub.dispose();resolve();}});
  setTimeout(()=>shell.write(command+'\r'),200);
 });
 try {
  await waitFor("for i in $(seq 1 150); do printf 'HISTORY_LINE_%s\\n' $i; done; printf 'DONE_%s\\n' capture", 'DONE_capture');
  let text=await captureHistory(pane_id);
  assert.ok(text.includes('HISTORY_LINE_1\n'));
  assert.ok(text.includes('HISTORY_LINE_150'));
  await waitFor("printf '\\033[?1049hAPP_%s\\n' screen", 'APP_screen');
  text=await captureHistory(pane_id);
  assert.ok(text.includes('HISTORY_LINE_1\n'));
  assert.ok(text.includes('APP_screen'));
  await assert.rejects(captureHistory('../invalid'));
 } finally {
  shell.kill();
  execFileSync('/usr/bin/tmux',['-L','orbit-persistent','kill-session','-t','pane-'+pane_id]);
 }
});
