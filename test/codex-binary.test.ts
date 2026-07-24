import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCodexBinary } from '../src/core/providers/codex-cli.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCodex(root: string, version: string): string {
  fs.mkdirSync(root, { recursive: true });
  const executable = path.join(root, 'codex');
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`,
    { mode: 0o700 },
  );
  return executable;
}

describe('Codex binary resolution', () => {
  it('returns the exact newest executable it successfully version-probed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-codex-bin-'));
    tempDirs.push(root);
    const oldBin = fakeCodex(path.join(root, 'old'), '0.39.0');
    const newBin = fakeCodex(path.join(root, 'new'), '0.144.5');

    expect(
      resolveCodexBinary({
        HOME: os.homedir(),
        PATH: `${path.dirname(oldBin)}${path.delimiter}${path.dirname(newBin)}`,
      }),
    ).toBe(newBin);
  });
});
