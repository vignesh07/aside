const REDACTED = '[REDACTED]';

/**
 * Best-effort provider-bound secret redaction.
 *
 * This intentionally runs after transcript normalization but before any
 * provider call. It covers common credential shapes plus generic assignments;
 * it is a safety net, not a claim that arbitrary prose can be perfectly
 * classified as sensitive.
 */
export function redactSensitiveText(input: string): string {
  return input
    // Private keys and multiline credential blocks.
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      REDACTED,
    )
    // Well-known token families.
    .replace(/\b(?:sk-(?:proj-)?|sk-ant-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{12,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    // JWTs.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    // Authorization headers.
    .replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    // JSON, shell, YAML, and dotenv-style secret assignments.
    .replace(
      /((?:["']?[A-Za-z0-9_.-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd)["']?)\s*(?:=|:)\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    );
}
