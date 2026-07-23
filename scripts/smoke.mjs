// End-to-end smoke test (no TUI): discover every local agent thread, build the
// same bounded/query-relevant snapshot as the product, and ask the observer.
import { scanAllSessions } from '../dist/core/session-scanner.js';
import { SideChatEngine } from '../dist/core/side-chat-engine.js';
import { SideChatService } from '../dist/core/side-chat-service.js';
import { renderWorld } from '../dist/core/world-view.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../dist/config/defaults.js';

const { sessions, jsonlPaths } = scanAllSessions({});
console.log(`discovered ${sessions.length} sessions`);
for (const session of sessions.slice(0, 10)) {
  console.log(
    `  [${session.source}] ${session.projectName} (${session.status}) — ` +
    session.id.slice(0, 8),
  );
}
if (sessions.length === 0) {
  console.log('no sessions to test against; exiting');
  process.exit(0);
}

const engine = new SideChatEngine({
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
});
const service = new SideChatService(engine);
service.syncSessions(sessions, jsonlPaths);

const question =
  'Across all my agent sessions: what is each one doing, and is any of them stuck or idle longer than it should be?';
const world = service.snapshot('fleet', question);
const totalEvents = world.sessions.reduce(
  (count, session) => count + session.transcript.length,
  0,
);
const rendered = renderWorld(world);
console.log(
  `\nclassified ${totalEvents} events across ${world.sessions.length} prompt sessions ` +
  `(${world.totalSessionCount} discovered)`,
);
console.log(`rendered prompt: ${rendered.length} chars (budget-bounded)`);
console.log('\n--- roster the model sees ---');
console.log(rendered.split('=== Recent activity ===')[0].trim());

console.log(`observer: ${DEFAULT_PROVIDER} / ${DEFAULT_MODEL}`);
console.log(`\nasking the observer: "${question}"\n`);
await service.ask(question);
console.log('ANSWER:', service.getChat().at(-1)?.content ?? '(no answer)');

// The default provider may hold a CLI process open for conversation continuity.
service.dispose();
