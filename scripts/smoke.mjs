// End-to-end smoke test (no TUI): discover every agent session on this machine,
// build a real world snapshot from their transcripts, and ask the observer a
// question that spans all of them.
import { scanAllSessions } from '../dist/core/session-scanner.js';
import { classifyLine } from '../dist/core/event-classifier.js';
import { SideChatEngine } from '../dist/core/side-chat-engine.js';
import { renderWorld } from '../dist/core/world-view.js';
import * as fs from 'node:fs';

const { sessions, jsonlPaths } = scanAllSessions({});
console.log(`discovered ${sessions.length} sessions`);
for (const s of sessions.slice(0, 10)) {
  console.log(`  [${s.source}] ${s.projectName} (${s.status}) — ${s.id.slice(0, 8)}`);
}
if (sessions.length === 0) {
  console.log('no sessions to test against; exiting');
  process.exit(0);
}

const now = new Date();
const snapshots = [];
for (const s of sessions) {
  const path = jsonlPaths.get(s.id);
  let transcript = [];
  if (path && fs.existsSync(path)) {
    const lines = fs.readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines.slice(-150)) {
      const ev = classifyLine(line, s.source);
      if (ev) transcript.push(ev);
    }
  }
  snapshots.push({
    id: s.id.slice(0, 8),
    source: s.source,
    projectName: s.projectName,
    gitBranch: s.gitBranch,
    model: s.model,
    status: s.status,
    idleForMs: Math.max(0, now.getTime() - s.lastEventTime.getTime()),
    currentActivity: s.currentActivity,
    contextUsedPercent: s.usedPercent,
    contextStatus: s.contextStatus,
    transcript,
  });
}

// Focus the busiest session, as the frontends do by default.
const world = { now, sessions: snapshots, focusId: snapshots[0]?.id ?? null };

const totalEvents = snapshots.reduce((n, s) => n + s.transcript.length, 0);
const rendered = renderWorld(world);
console.log(`\nclassified ${totalEvents} events across ${snapshots.length} sessions`);
console.log(`rendered prompt: ${rendered.length} chars (budget-bounded)`);
console.log('\n--- roster the model sees ---');
console.log(rendered.split('=== Recent activity ===')[0].trim());

const engine = new SideChatEngine({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
const question =
  'Across all my agent sessions: what is each one doing, and is any of them stuck or idle longer than it should be?';
console.log(`\nasking the observer: "${question}"\n`);
console.log('ANSWER:', await engine.ask({ world, history: [], question }));
