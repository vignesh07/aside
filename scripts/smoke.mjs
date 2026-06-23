// End-to-end smoke test (no TUI): discover sessions, classify a real
// transcript, and ask the side-chat engine a question about it.
import { scanAllSessions } from '../dist/core/session-scanner.js';
import { classifyLine } from '../dist/core/event-classifier.js';
import { SideChatEngine } from '../dist/core/side-chat-engine.js';
import * as fs from 'node:fs';

const { sessions, jsonlPaths } = scanAllSessions({});
console.log(`discovered ${sessions.length} sessions`);
for (const s of sessions.slice(0, 5)) {
  console.log(`  [${s.source}] ${s.projectName} (${s.status}) — ${s.id.slice(0, 8)}`);
}

const target = sessions.find((s) => s.source === 'claude') ?? sessions[0];
if (!target) {
  console.log('no sessions to test against; exiting');
  process.exit(0);
}
console.log(`\ntarget: [${target.source}] ${target.projectName} (${target.id.slice(0, 8)})`);

const path = jsonlPaths.get(target.id);
const lines = fs.readFileSync(path, 'utf-8').split('\n').filter(Boolean);
const transcript = [];
for (const line of lines.slice(-200)) {
  const ev = classifyLine(line, target.source);
  if (ev) transcript.push(ev);
}
console.log(`classified ${transcript.length} events from ${lines.length} lines`);

const engine = new SideChatEngine({
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
});
console.log('\nasking the observer: "In one sentence, what is this session working on?"\n');
const answer = await engine.ask({
  projectName: target.projectName,
  transcript,
  history: [],
  question: 'In one sentence, what is this session working on right now?',
});
console.log('ANSWER:', answer);
