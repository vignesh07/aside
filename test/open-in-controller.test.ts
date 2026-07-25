import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OpenInController,
  launchWorkspaceForSession,
} from '../menubar/src/open-in.js';
import type {
  AgentCapabilities,
  LaunchIntent,
} from '../src/core/handoff/index.js';
import type { TrackedSession } from '../src/types/session.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function capability(
  provider: 'codex' | 'claude' | 'cursor' | 'opencode',
  available: boolean,
) {
  return {
    provider,
    installed: available,
    ...(available ? { executablePath: `/bin/${provider}` } : {}),
    nativeResume: {
      available,
      transport: available ? ('cli' as const) : ('unavailable' as const),
    },
    crossProviderContinue: {
      available,
      transport: available ? ('cli' as const) : ('unavailable' as const),
      contextCarried: available,
      promptBehavior: available
        ? ('submitted-after-confirmation' as const)
        : ('none' as const),
    },
    richImport: {
      available: false,
      experimental: false,
      note: 'Unavailable',
    },
  };
}

function capabilities(cursorApp?: string): AgentCapabilities {
  return {
    codex: capability('codex', true),
    claude: capability('claude', true),
    cursor: {
      ...capability('cursor', true),
      ...(cursorApp ? { applicationPath: cursorApp } : {}),
    },
    opencode: capability('opencode', false),
  };
}

function session(workspace: string): TrackedSession {
  const transcript = path.join(workspace, 'session.jsonl');
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({
      timestamp: '2026-07-24T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Finish launch readiness' },
    })}\n`,
  );
  return {
    id: 'source-1',
    source: 'codex',
    projectName: 'Aside',
    title: 'Finish launch readiness',
    projectDir: workspace,
    jsonlPath: transcript,
    cwd: workspace,
    gitBranch: 'main',
    slug: '',
    model: 'gpt',
    version: '1',
    usedPercent: 0,
    contextStatus: 'safe',
    status: 'history',
    lastEventTime: new Date(),
    eventCount: 1,
    currentActivity: 'Waiting for the next step',
  };
}

describe('OpenInController', () => {
  it('exposes renderer-safe resume and continuation actions', async () => {
    const workspace = tempDir('aside-open-in-workspace-');
    const cursorApp = path.join(tempDir('aside-open-in-apps-'), 'Cursor.app');
    fs.mkdirSync(cursorApp);
    const source = session(workspace);
    const controller = new OpenInController(
      () => ({ session: source, sideChat: [] }),
      { execute: async () => {} },
      { detectCapabilities: async () => capabilities(cursorApp) },
    );

    const state = await controller.getOptions('session:codex:source-1');

    expect(state.defaultIncludeSideChat).toBe(false);
    expect(state.options.find((option) => option.id === 'resume:codex')).toMatchObject({
      kind: 'resume',
      available: true,
    });
    expect(state.options.find((option) => option.id === 'continue:claude')).toMatchObject({
      kind: 'continue',
      available: true,
    });
    expect(state.options.find((option) => option.id === 'open:cursor-project')).toMatchObject({
      kind: 'open-project',
      available: true,
    });
    expect(state.options.find((option) => option.id === 'continue:opencode')).toMatchObject({
      available: false,
    });
    expect(JSON.stringify(state)).not.toContain(source.jsonlPath);
  });

  it('creates a private handoff only after a confirmed cross-provider action', async () => {
    const workspace = tempDir('aside-open-in-handoff-');
    const capsuleRoot = path.join(tempDir('aside-open-in-capsules-'), 'handoffs');
    const source = session(workspace);
    const intents: LaunchIntent[] = [];
    const controller = new OpenInController(
      () => ({
        session: source,
        sideChat: [{
          id: 't1',
          role: 'user',
          content: 'Include this private side note',
          timestamp: new Date('2026-07-24T10:01:00Z'),
        }],
      }),
      { execute: async (intent) => { intents.push(intent); } },
      {
        detectCapabilities: async () => capabilities(),
        capsule: { rootDir: capsuleRoot },
      },
    );

    const result = await controller.open({
      threadId: 'session:codex:source-1',
      optionId: 'continue:claude',
      includeSideChat: true,
    });

    expect(result.ok).toBe(true);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: 'cli',
      provider: 'claude',
      promptBehavior: 'submitted-after-confirmation',
    });
    const capsulePath = intents[0]?.capsulePath;
    expect(capsulePath).toBeTruthy();
    expect(fs.statSync(capsulePath!).mode & 0o777).toBe(0o600);
    const capsule = JSON.parse(fs.readFileSync(capsulePath!, 'utf8'));
    expect(capsule.asideSideChat[0].text).toContain('private side note');
    expect(capsule.recentTranscript[0].text).toContain('launch readiness');
  });

  it('rejects provider transcript folders as launch workspaces', () => {
    const home = tempDir('aside-open-in-home-');
    const transcriptDir = path.join(home, '.claude', 'projects', 'encoded');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const source = session(transcriptDir);
    expect(launchWorkspaceForSession(source, home)).toBeNull();
  });

  it('removes a private capsule when the destination fails to open', async () => {
    const workspace = tempDir('aside-open-in-failed-handoff-');
    const capsuleRoot = path.join(
      tempDir('aside-open-in-failed-capsules-'),
      'handoffs',
    );
    const source = session(workspace);
    const controller = new OpenInController(
      () => ({ session: source, sideChat: [] }),
      {
        execute: async () => {
          throw new Error('Destination failed');
        },
      },
      {
        detectCapabilities: async () => capabilities(),
        capsule: { rootDir: capsuleRoot },
      },
    );

    await expect(controller.open({
      threadId: 'session:codex:source-1',
      optionId: 'continue:claude',
      includeSideChat: false,
    })).rejects.toThrow('Destination failed');

    expect(
      fs.readdirSync(capsuleRoot).filter((name) => name.endsWith('.json')),
    ).toEqual([]);
  });
});
