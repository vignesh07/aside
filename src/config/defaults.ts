export const COLORS = {
  header1: '#ff6b6b',
  header2: '#4ecdc4',
  border: '#5a5a7a',
  textPrimary: '#e0e0e0',
  textDim: '#888888',

  sessionActive: '#00ff41',
  sessionIdle: '#888888',
  sessionEnded: '#555555',

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
  seedLines: 20,
  maxCommentaryLines: 200,
} as const;

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_AUTH_FILE = `${process.env['HOME']}/.pi/agent/auth.json`;

export const CLAUDE_DIR = `${process.env['HOME']}/.claude`;
export const CODEX_DIR = `${process.env['HOME']}/.codex`;
export const PI_DIR = `${process.env['HOME']}/.pi`;
