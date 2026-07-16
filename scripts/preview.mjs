// Render the real aside TUI to stdout without needing an interactive terminal.
//
// This mounts the actual <App/> — real session scanning, real components, real
// key handling — into ink-testing-library's virtual stdout and prints frames.
// It's how you see the UI in a pipe, a CI log, or an agent session that has no
// TTY to drive.
//
//   node scripts/preview.mjs                    # launch frame
//   node scripts/preview.mjs i                  # + chat input focused
//   node scripts/preview.mjs m                  # + model picker open
//   node scripts/preview.mjs i "is it stuck?" ENTER --wait 25
//                                               # + a real question and answer
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../dist/app.js';

const argv = process.argv.slice(2);
const waitIdx = argv.indexOf('--wait');
// Seconds to hold after the last key, for an in-flight model call to land.
const waitSeconds = waitIdx === -1 ? 0 : Number(argv[waitIdx + 1]);
const keys = waitIdx === -1 ? argv : argv.slice(0, waitIdx);

const { lastFrame, stdin, unmount } = render(
  React.createElement(App, {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    scopeFilter: {},
  }),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Let the first session scan land before drawing.
await sleep(1200);

for (const key of keys) {
  stdin.write(key === 'ENTER' ? '\r' : key);
  await sleep(400);
}

if (waitSeconds > 0) await sleep(waitSeconds * 1000);

const rule = '─'.repeat(100);
console.log(rule);
console.log(lastFrame());
console.log(rule);

unmount();
process.exit(0);
