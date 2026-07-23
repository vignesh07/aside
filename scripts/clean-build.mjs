import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');

// Keep npm packages deterministic: deleted source files must not survive as
// stale JavaScript in dist and accidentally ship in the next tarball.
fs.rmSync(output, { recursive: true, force: true });
