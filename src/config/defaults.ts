export const COLORS = {
  header1: '#ff6b6b',
  header2: '#4ecdc4',
  border: '#5a5a7a',
  textPrimary: '#e0e0e0',
  textDim: '#888888',

  sessionActive: '#00ff41',
  sessionIdle: '#888888',
  sessionHistory: '#555555',

  badgeClaude: '#c084fc',
  badgeCodex: '#00ff41',
  badgePi: '#ffb86c',

  healthSafe: '#00ff41',
  healthCaution: '#ffee32',
  healthCritical: '#ff4444',

  toneHype: '#ffee32',
  toneShock: '#ff6b6b',
  toneSass: '#c084fc',
  toneChill: '#4ecdc4',
  tonePanic: '#ff4444',

  ticker: '#4ecdc4',
  live: '#ff4444',

  // Scoreboard
  hypeBar: '#ffee32',
  hypeBarHot: '#ff4444',
  chaosLow: '#00ff41',
  chaosMid: '#ffee32',
  chaosHigh: '#ff4444',
  meterEmpty: '#333333',
  scoreLabel: '#e0e0e0',
  comboText: '#ffee32',
} as const;

export const TIMING = {
  scanIntervalMs: 5000,
  batchIntervalMs: 10000,
  activeThresholdMs: 30_000,
  idleThresholdMs: 300_000,
  tailPollMs: 1000,
  seedLines: 100,
  maxCommentaryLines: 200,
} as const;

/**
 * Truncation limits, applied at classify time.
 *
 * Prose (user prompts, agent replies) is where the *reasoning* lives — it's what
 * answers "why did the agent pick this path?", so it's kept long. Targets (file
 * paths, commands) are identifiers, not arguments, so they stay terse. Anything
 * too long for a given surface is cut again at render time; classification is
 * deliberately the generous end, since data dropped here can't be recovered.
 */
export const TRUNCATE = {
  /** User prompts and assistant text — carries intent and rationale. */
  prose: 600,
  /** Tool targets: file paths, commands, patterns. */
  target: 60,
  /** Shell command lines. */
  command: 80,
  /** One-line activity string for a session card / roster line. */
  activity: 80,
} as const;

/**
 * Default to the user's existing Claude Code login rather than an API key.
 *
 * aside's premise is that you're already running these agents — so the CLI is
 * already installed and already authenticated. Delegating to it means the
 * default experience needs no key, no signup, and no second bill.
 */
export const DEFAULT_PROVIDER = 'claude-cli';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export const CLAUDE_DIR = `${process.env['HOME']}/.claude`;
export const CODEX_DIR = `${process.env['HOME']}/.codex`;
export const PI_DIR = `${process.env['HOME']}/.pi`;
