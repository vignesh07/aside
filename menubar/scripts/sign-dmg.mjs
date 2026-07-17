// Sign, notarize, and staple the DMGs produced by electron-builder.
//
// Why this exists as a separate step:
//
// electron-builder's afterSign hook notarizes the .app — but the DMG is built
// *after* that hook runs, so the container never gets notarized. And
// electron-builder does not sign DMGs by default.
//
// That combination fails in the one place that matters. The app inside is
// perfect: signed, hardened, notarized, stapled. But the DMG is what a user
// actually downloads, and an unsigned container has no signature for Gatekeeper
// to anchor a ticket to — `spctl` reports "no usable signature" and the user is
// stopped at the door, never reaching the notarized app inside. Verifying the
// .app alone hides this completely.
//
// Order matters: sign first, then notarize. Signing rewrites the file and
// invalidates any ticket already stapled to it.
//
//   npm run dist && npm run sign:dmg

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.join(here, '..', 'release');
const PROFILE = process.env['ASIDE_NOTARY_PROFILE'] ?? 'aside-notary';

/** Read the signing identity from electron-builder.yml — one source of truth. */
function signingIdentity() {
  const config = fs.readFileSync(path.join(here, '..', 'electron-builder.yml'), 'utf-8');
  const match = /^\s*identity:\s*(.+)$/m.exec(config);
  if (!match) throw new Error('no `identity` in electron-builder.yml');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function run(cmd, args, label) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60_000 });
    return true;
  } catch (err) {
    console.error(`  ✗ ${label}: ${String(err.stderr ?? err.message).trim().slice(0, 200)}`);
    return false;
  }
}

const dmgs = fs
  .readdirSync(releaseDir)
  .filter((f) => f.endsWith('.dmg'))
  .map((f) => path.join(releaseDir, f));

if (dmgs.length === 0) {
  console.error('no DMGs in release/. Run `npm run dist` first.');
  process.exit(1);
}

const identity = signingIdentity();
let failed = 0;

for (const dmg of dmgs) {
  const name = path.basename(dmg);
  console.log(`\n${name}`);

  if (!run('codesign', ['--force', '--sign', identity, '--timestamp', dmg], 'sign')) {
    failed += 1;
    continue;
  }
  console.log('  ✓ signed');

  if (!run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', PROFILE, '--wait'], 'notarize')) {
    failed += 1;
    continue;
  }
  console.log('  ✓ notarized');

  if (!run('xcrun', ['stapler', 'staple', dmg], 'staple')) {
    failed += 1;
    continue;
  }
  console.log('  ✓ stapled');

  // The only check that reflects what a downloader's Mac actually decides.
  // Everything above can pass while this fails, which is the whole point.
  const accepted = run(
    'spctl',
    ['-a', '-t', 'open', '--context', 'context:primary-signature', dmg],
    'gatekeeper',
  );
  if (!accepted) failed += 1;
  else console.log('  ✓ Gatekeeper: accepted — Notarized Developer ID');
}

console.log(
  failed === 0
    ? `\n${dmgs.length} DMG(s) ready to distribute.`
    : `\n${failed} step(s) failed — do not distribute these.`,
);
process.exit(failed === 0 ? 0 : 1);
