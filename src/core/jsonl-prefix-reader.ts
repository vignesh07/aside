import * as fs from 'node:fs';

export interface JsonlPrefixReaderOptions {
  maxBytes?: number;
  chunkBytes?: number;
  maxLines?: number;
}

/**
 * Reads complete JSONL lines from the start of a file without loading the
 * entire file into memory.
 */
export function scanJsonlPrefix(
  jsonlPath: string,
  onLine: (line: string) => boolean | void,
  options?: JsonlPrefixReaderOptions,
): void {
  const maxBytes = options?.maxBytes ?? 256 * 1024;
  const chunkBytes = options?.chunkBytes ?? 64 * 1024;
  const maxLines = options?.maxLines ?? 200;

  let fd: number | null = null;
  const buffer = Buffer.alloc(chunkBytes);
  let bytesReadTotal = 0;
  let linesRead = 0;
  let carry = '';

  try {
    fd = fs.openSync(jsonlPath, 'r');

    while (bytesReadTotal < maxBytes && linesRead < maxLines) {
      const remaining = maxBytes - bytesReadTotal;
      const toRead = Math.min(chunkBytes, remaining);
      const bytesRead = fs.readSync(fd, buffer, 0, toRead, bytesReadTotal);
      if (bytesRead <= 0) break;

      bytesReadTotal += bytesRead;
      carry += buffer.subarray(0, bytesRead).toString('utf-8');

      let newline = carry.indexOf('\n');
      while (newline >= 0 && linesRead < maxLines) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        newline = carry.indexOf('\n');

        if (!line) continue;
        linesRead++;
        if (onLine(line) === true) return;
      }
    }

    // Handle very small files without a trailing newline.
    const tail = carry.trimEnd();
    if (tail && linesRead < maxLines) {
      onLine(tail);
    }
  } catch {
    // Ignore read errors and return partial metadata.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
