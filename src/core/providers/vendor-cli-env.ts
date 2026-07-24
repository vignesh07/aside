/**
 * Build the environment for a vendor-owned CLI process.
 *
 * Aside delegates subscription-backed inference to the installed Codex and
 * Claude clients. Those clients must be able to find their own cached login
 * (through HOME, their config directory, or the OS credential store), but they
 * must not inherit an API key or bearer token from Aside's parent process.
 *
 * This is an allowlist rather than a list of known secrets. New credentials,
 * unrelated service tokens, and shell-only process hooks therefore stay out by
 * default instead of silently becoming available to a model client.
 */

const ALLOWED_EXACT = new Set([
  // Identity and executable lookup. HOME is also where both clients keep their
  // default configuration when an OS credential store is not selected.
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',

  // Windows equivalents needed for executable lookup and user configuration.
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',

  // Temporary files and ordinary terminal presentation.
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  '__CF_USER_TEXT_ENCODING',

  // Network routing. Proxy URLs can themselves be sensitive, but dropping them
  // would make a correctly configured corporate installation unable to log in.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',

  // Custom trust stores used in managed environments. Deliberately exclude
  // switches that disable certificate verification.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GIT_SSL_CAINFO',

  // Standard config roots plus the vendor-specific roots that locate cached
  // login state. These are paths, not credentials.
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
]);

function isAllowed(name: string): boolean {
  const canonical = name.toUpperCase();
  return ALLOWED_EXACT.has(canonical) || canonical.startsWith('LC_');
}

/**
 * Return a fresh, credential-free environment suitable for Codex or Claude.
 *
 * The original key spelling is retained so lowercase proxy variables and
 * platform-specific PATH casing continue to work.
 */
export function createVendorCliEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && isAllowed(name)) childEnv[name] = value;
  }
  return childEnv;
}
