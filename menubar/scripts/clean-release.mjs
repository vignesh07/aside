import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(packageRoot, 'release');

// release/ is ignored generated output. Starting from an empty directory keeps
// stale DMGs from a previous product name/version out of signing and upload.
fs.rmSync(releaseDir, { recursive: true, force: true });
