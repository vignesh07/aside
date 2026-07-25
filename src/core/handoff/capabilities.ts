import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentCapabilities,
  AgentProvider,
  AgentTargetCapability,
} from './types.js';

export interface CapabilityDetectionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Override application roots in tests or managed installations. No vendor
   * preferences, databases, or session stores are inspected.
   */
  applicationRoots?: readonly string[];
}

async function accessible(candidate: string, executable = false): Promise<boolean> {
  return access(candidate, executable ? fsConstants.X_OK : fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
}

async function resolveExecutable(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const pathValue = env['PATH'] ?? '';
  const extensions = platform === 'win32'
    ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        if (await accessible(candidate, true)) return candidate;
      }
    }
  }
  return undefined;
}

interface ApplicationCandidate {
  name: string;
  bundleIdentifiers: readonly string[];
}

async function matchesApplicationBundle(
  candidate: string,
  bundleIdentifiers: readonly string[],
): Promise<boolean> {
  const metadata = await stat(candidate).catch(() => undefined);
  if (!metadata?.isDirectory()) return false;
  const plist = await readFile(
    path.join(candidate, 'Contents', 'Info.plist'),
  ).catch(() => undefined);
  if (!plist) return false;
  return bundleIdentifiers.some((identifier) =>
    plist.includes(Buffer.from(identifier, 'utf8')),
  );
}

async function resolveApplication(
  apps: readonly ApplicationCandidate[],
  roots: readonly string[],
): Promise<string | undefined> {
  for (const root of roots) {
    for (const app of apps) {
      const candidate = path.join(root, app.name);
      if (await matchesApplicationBundle(candidate, app.bundleIdentifiers)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function baseCapability(provider: AgentProvider): AgentTargetCapability {
  return {
    provider,
    installed: false,
    nativeResume: {
      available: false,
      transport: 'unavailable',
      note: 'Install the provider client to resume its sessions.',
    },
    crossProviderContinue: {
      available: false,
      transport: 'unavailable',
      contextCarried: false,
      promptBehavior: 'none',
      note: 'Install the provider client to continue with this thread.',
    },
    richImport: {
      available: false,
      experimental: false,
      note: 'No supported generic transcript import is available.',
    },
  };
}

/**
 * Detect launch surfaces from executables and application bundles only.
 * Deliberately never opens provider-owned JSONL or SQLite session stores.
 */
export async function detectAgentCapabilities(
  options: CapabilityDetectionOptions = {},
): Promise<AgentCapabilities> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const roots = options.applicationRoots ?? (
    platform === 'darwin'
      ? ['/Applications', path.join(os.homedir(), 'Applications')]
      : []
  );
  const [
    codexExecutable,
    claudeExecutable,
    cursorAgentExecutable,
    opencodeExecutable,
    codexApplication,
    claudeUrlHandlerApplication,
    cursorApplication,
  ] = await Promise.all([
    resolveExecutable(['codex'], env, platform),
    resolveExecutable(['claude'], env, platform),
    resolveExecutable(['cursor-agent'], env, platform),
    resolveExecutable(['opencode'], env, platform),
    // The current Codex desktop bundle is installed as ChatGPT.app while
    // retaining the `com.openai.codex` bundle ID and `codex://` URL scheme.
    // Keep Codex.app first for older or renamed installations.
    resolveApplication([
      { name: 'Codex.app', bundleIdentifiers: ['com.openai.codex'] },
      { name: 'ChatGPT.app', bundleIdentifiers: ['com.openai.codex'] },
    ], roots),
    resolveApplication([
      {
        name: 'Claude Code URL Handler.app',
        bundleIdentifiers: ['com.anthropic.claude-code-url-handler'],
      },
    ], roots),
    resolveApplication([
      {
        name: 'Cursor.app',
        bundleIdentifiers: [
          'com.todesktop.230313mzl4w4u92',
          'com.cursor.Cursor',
        ],
      },
    ], roots),
  ]);

  const codex = baseCapability('codex');
  codex.installed = Boolean(codexExecutable || codexApplication);
  codex.executablePath = codexExecutable;
  codex.applicationPath = codexApplication;
  codex.nativeResume = codex.installed
    ? {
        available: true,
        transport: codexApplication ? 'deep-link' : 'cli',
      }
    : codex.nativeResume;
  codex.crossProviderContinue = codex.installed
    ? {
        available: true,
        transport: codexApplication ? 'deep-link' : 'cli',
        contextCarried: true,
        promptBehavior: codexApplication ? 'prefilled' : 'submitted-after-confirmation',
      }
    : codex.crossProviderContinue;
  codex.richImport = {
    available: false,
    experimental: true,
    note: 'Codex has a first-party external-agent importer, but per-thread migration needs separate compatibility validation.',
  };

  const claude = baseCapability('claude');
  claude.installed = Boolean(claudeExecutable);
  claude.executablePath = claudeExecutable;
  claude.applicationPath = claudeUrlHandlerApplication;
  claude.nativeResume = claudeExecutable
    ? { available: true, transport: 'cli' }
    : claude.nativeResume;
  claude.crossProviderContinue = claudeExecutable
    ? {
        available: true,
        transport: claudeUrlHandlerApplication ? 'deep-link' : 'cli',
        contextCarried: true,
        promptBehavior: claudeUrlHandlerApplication
          ? 'prefilled'
          : 'submitted-after-confirmation',
        ...(!claudeUrlHandlerApplication && platform === 'darwin'
          ? {
              note:
                'Claude Code URL handling is unavailable, so Aside will continue in Terminal.',
            }
          : {}),
      }
    : claude.crossProviderContinue;

  const cursor = baseCapability('cursor');
  cursor.installed = Boolean(cursorAgentExecutable || cursorApplication);
  cursor.executablePath = cursorAgentExecutable;
  cursor.applicationPath = cursorApplication;
  cursor.nativeResume = cursorAgentExecutable
    ? {
        available: true,
        transport: 'cli',
        note: 'Exact resume is supported for Cursor Agent CLI sessions, not Cursor editor chats.',
      }
    : cursor.nativeResume;
  cursor.crossProviderContinue = cursorAgentExecutable
    ? {
        available: true,
        transport: 'cli',
        contextCarried: true,
        promptBehavior: 'submitted-after-confirmation',
        note: 'Creates a Cursor Agent CLI session.',
      }
    : cursorApplication
      ? {
          available: true,
          transport: 'open-workspace',
          contextCarried: false,
          promptBehavior: 'none',
          note: 'Cursor exposes no supported GUI chat prefill or transcript import; Aside can only open the project.',
        }
      : cursor.crossProviderContinue;

  const opencode = baseCapability('opencode');
  opencode.installed = Boolean(opencodeExecutable);
  opencode.executablePath = opencodeExecutable;
  opencode.nativeResume = opencodeExecutable
    ? { available: true, transport: 'cli' }
    : opencode.nativeResume;
  opencode.crossProviderContinue = opencodeExecutable
    ? {
        available: true,
        transport: 'cli',
        contextCarried: true,
        promptBehavior: 'submitted-after-confirmation',
      }
    : opencode.crossProviderContinue;
  opencode.richImport = {
    available: false,
    experimental: true,
    note: 'OpenCode has an official JSON importer; foreign transcript translation remains intentionally disabled.',
  };

  return { codex, claude, cursor, opencode };
}
