/**
 * Extract a human-readable project name from a Claude Code project directory name.
 * e.g. "-Users-vignesh-babyshark" → "babyshark"
 * e.g. "-Users-vignesh-trading-nautilus" → "nautilus"
 */
export function extractProjectName(dirName: string): string {
  const parts = dirName.replace(/^-/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

/**
 * Extract project name from a Codex session's cwd.
 * e.g. "/Users/vignesh/openclaw" → "openclaw"
 */
export function extractProjectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
