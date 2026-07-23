// Check whether a built .app is actually distributable.
//
//   npm run verify:signing [path/to/aside.app]
//
// "It built" and "it will open on someone else's Mac" are different claims. A
// signed-but-not-notarized app runs fine on the machine that built it and is
// blocked everywhere else — so local launching proves nothing. This asserts the
// things Gatekeeper actually checks.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath =
  process.argv[2] ?? path.join(here, '..', 'release', 'mac-arm64', 'Aside.app');

/**
 * Run a tool and capture stdout *and* stderr together.
 *
 * codesign prints its report (Authority, flags, entitlements) to stderr even on
 * success, so reading stdout alone silently sees nothing and reports a correctly
 * signed app as unsigned.
 */
function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out ?? '' };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** codesign writes its metadata to stderr; merge the streams to read it. */
function runMerged(cmd, args) {
  try {
    const out = execFileSync(`${cmd} ${args.map((a) => `'${a}'`).join(' ')} 2>&1`, {
      encoding: 'utf-8',
      shell: '/bin/sh',
    });
    return { ok: true, out: out ?? '' };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

if (!fs.existsSync(appPath)) {
  console.error(`no app at ${appPath}\nBuild one first: npm run pack`);
  process.exit(1);
}
console.log(`verifying ${appPath}\n`);

// 1. Signature valid, and every nested binary too (--deep), strictly.
const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
check('signature valid (deep, strict)', verify.ok, verify.out.trim().split('\n').at(-1));

// 2. Signed by Developer ID — not ad-hoc, not Apple Development.
const info = runMerged('codesign', ['-dv', '--verbose=4', appPath]);
const authority = /Authority=(.+)/.exec(info.out)?.[1] ?? '(none)';
check(
  'signed with Developer ID Application',
  authority.startsWith('Developer ID Application'),
  `Authority=${authority}`,
);

// 3. Hardened runtime — notarization is refused without it.
check(
  'hardened runtime enabled',
  /flags=.*runtime/.test(info.out),
  /CodeDirectory .*flags=[^\s]+/.exec(info.out)?.[0] ?? '(no flags)',
);

// 4. The JIT entitlements Electron dies without.
const ents = runMerged('codesign', ['-d', '--entitlements', ':-', appPath]);
for (const key of [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
]) {
  check(`entitlement ${key}`, ents.out.includes(key), ents.out.includes(key) ? 'present' : 'MISSING');
}

// 5. Notarization ticket stapled — the difference between "opens on my Mac" and
//    "opens on anyone's Mac", including offline.
const staple = run('xcrun', ['stapler', 'validate', appPath]);
check('notarization ticket stapled', staple.ok, staple.out.trim().split('\n').at(-1));

// 6. What Gatekeeper will actually decide on first launch.
const spctl = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
check('Gatekeeper accepts', spctl.ok, spctl.out.trim().split('\n').at(-1));

// 7. Electron's alternate code-loading paths are fused off in the binary.
const fuseWire = await getCurrentFuseWire(appPath);
const fuseExpected = [
  ['RunAsNode disabled', FuseV1Options.RunAsNode, false],
  ['NODE_OPTIONS disabled', FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  ['Node inspector arguments disabled', FuseV1Options.EnableNodeCliInspectArguments, false],
  ['ASAR integrity enabled', FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
  ['only signed app.asar loads', FuseV1Options.OnlyLoadAppFromAsar, true],
  ['extra file:// privileges disabled', FuseV1Options.GrantFileProtocolExtraPrivileges, false],
];
for (const [name, option, enabled] of fuseExpected) {
  const actual = fuseWire[option];
  const expected = enabled ? '1'.charCodeAt(0) : '0'.charCodeAt(0);
  check(`Electron fuse: ${name}`, actual === expected, `state=${String.fromCharCode(actual)}`);
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? '  ok  ' : '  FAIL'}  ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
}

console.log(
  failed === 0
    ? '\nDistributable: signed, hardened, notarized, stapled.'
    : `\n${failed} check(s) failed — this app will be blocked on other machines.`,
);
process.exit(failed === 0 ? 0 : 1);
