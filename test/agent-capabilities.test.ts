import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectAgentCapabilities,
  listAgentLaunchOptions,
  planAgentLaunchOption,
} from '../src/core/handoff/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function executable(directory: string, name: string): string {
  const target = path.join(directory, name);
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return target;
}

function application(
  directory: string,
  name: string,
  bundleIdentifier: string,
): string {
  const target = path.join(directory, name);
  const contents = path.join(target, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleIdentifier</key>',
      `<string>${bundleIdentifier}</string>`,
      '</dict></plist>',
    ].join(''),
  );
  return target;
}

describe('agent target capability detection', () => {
  it('uses installed binaries and app bundles without consulting provider stores', async () => {
    const bin = makeTemp('aside-agent-bin-');
    const apps = makeTemp('aside-agent-apps-');
    const codex = executable(bin, 'codex');
    const claude = executable(bin, 'claude');
    const cursorAgent = executable(bin, 'cursor-agent');
    const opencode = executable(bin, 'opencode');
    application(apps, 'Codex.app', 'com.openai.codex');
    application(apps, 'Cursor.app', 'com.todesktop.230313mzl4w4u92');

    const capabilities = await detectAgentCapabilities({
      env: { PATH: bin },
      platform: 'darwin',
      applicationRoots: [apps],
    });

    expect(capabilities.codex).toMatchObject({
      installed: true,
      executablePath: codex,
      applicationPath: path.join(apps, 'Codex.app'),
      nativeResume: { available: true, transport: 'deep-link' },
      crossProviderContinue: {
        available: true,
        transport: 'deep-link',
        contextCarried: true,
        promptBehavior: 'prefilled',
      },
    });
    expect(capabilities.claude.executablePath).toBe(claude);
    expect(capabilities.claude.crossProviderContinue).toMatchObject({
      transport: 'cli',
      promptBehavior: 'submitted-after-confirmation',
    });
    expect(capabilities.cursor.executablePath).toBe(cursorAgent);
    expect(capabilities.cursor.applicationPath).toBe(path.join(apps, 'Cursor.app'));
    expect(capabilities.opencode.executablePath).toBe(opencode);
    expect(capabilities.opencode.richImport).toMatchObject({
      available: false,
      experimental: true,
    });
  });

  it('reports Cursor GUI as workspace-only when Cursor Agent is absent', async () => {
    const apps = makeTemp('aside-cursor-app-');
    application(apps, 'Cursor.app', 'com.todesktop.230313mzl4w4u92');
    const capabilities = await detectAgentCapabilities({
      env: { PATH: '' },
      platform: 'darwin',
      applicationRoots: [apps],
    });

    expect(capabilities.cursor.crossProviderContinue).toMatchObject({
      available: true,
      transport: 'open-workspace',
      contextCarried: false,
      promptBehavior: 'none',
    });
    expect(capabilities.cursor.nativeResume.available).toBe(false);
  });

  it('detects the current Codex desktop bundle name', async () => {
    const apps = makeTemp('aside-codex-chatgpt-app-');
    application(apps, 'ChatGPT.app', 'com.openai.codex');

    const capabilities = await detectAgentCapabilities({
      env: { PATH: '' },
      platform: 'darwin',
      applicationRoots: [apps],
    });

    expect(capabilities.codex).toMatchObject({
      installed: true,
      applicationPath: path.join(apps, 'ChatGPT.app'),
      nativeResume: { available: true, transport: 'deep-link' },
      crossProviderContinue: {
        available: true,
        transport: 'deep-link',
        promptBehavior: 'prefilled',
      },
    });
  });

  it('uses Claude deep links only when the registered handler is present', async () => {
    const bin = makeTemp('aside-claude-handler-bin-');
    const apps = makeTemp('aside-claude-handler-apps-');
    executable(bin, 'claude');
    const withoutHandler = await detectAgentCapabilities({
      env: { PATH: bin },
      platform: 'darwin',
      applicationRoots: [apps],
    });

    expect(withoutHandler.claude.crossProviderContinue).toMatchObject({
      available: true,
      transport: 'cli',
      promptBehavior: 'submitted-after-confirmation',
    });

    application(
      apps,
      'Claude Code URL Handler.app',
      'com.anthropic.claude-code-url-handler',
    );
    const withHandler = await detectAgentCapabilities({
      env: { PATH: bin },
      platform: 'darwin',
      applicationRoots: [apps],
    });

    expect(withHandler.claude.crossProviderContinue).toMatchObject({
      available: true,
      transport: 'deep-link',
      promptBehavior: 'prefilled',
    });
  });

  it('ignores lookalike app directories with the wrong bundle identifier', async () => {
    const apps = makeTemp('aside-lookalike-apps-');
    application(apps, 'ChatGPT.app', 'example.invalid.chat');
    application(apps, 'Cursor.app', 'example.invalid.cursor');

    const capabilities = await detectAgentCapabilities({
      env: { PATH: '' },
      platform: 'darwin',
      applicationRoots: [apps],
    });

    expect(capabilities.codex.installed).toBe(false);
    expect(capabilities.cursor.installed).toBe(false);
  });

  it('exposes stable, distinct Cursor Agent and Cursor project option IDs', async () => {
    const bin = makeTemp('aside-options-bin-');
    const apps = makeTemp('aside-options-apps-');
    executable(bin, 'claude');
    executable(bin, 'cursor-agent');
    application(apps, 'Cursor.app', 'com.todesktop.230313mzl4w4u92');
    const capabilities = await detectAgentCapabilities({
      env: { PATH: bin },
      platform: 'darwin',
      applicationRoots: [apps],
    });

    const options = listAgentLaunchOptions({
      source: { provider: 'claude', sessionId: 'claude-1' },
      capabilities,
    });

    expect(options.find((option) => option.id === 'resume:claude')).toMatchObject({
      label: 'Resume in Claude Code',
      kind: 'resume',
      available: true,
    });
    expect(options.find((option) => option.id === 'continue:cursor-agent')).toMatchObject({
      label: 'Continue with Cursor Agent',
      kind: 'continue',
      targetSurface: 'cli',
      available: true,
    });
    expect(options.find((option) => option.id === 'open:cursor-project')).toMatchObject({
      label: 'Open project in Cursor',
      kind: 'open-project',
      targetSurface: 'app',
      available: true,
    });
    expect(options.find((option) => option.id === 'continue:opencode')).toMatchObject({
      label: 'Continue in OpenCode Terminal',
      kind: 'continue',
    });
    expect(options.map((option) => option.id)).toEqual([
      'continue:codex',
      'resume:claude',
      'continue:cursor-agent',
      'open:cursor-project',
      'continue:opencode',
    ]);
    expect(planAgentLaunchOption({
      source: { provider: 'claude', sessionId: 'claude-1' },
      optionId: 'open:cursor-project',
      capabilities,
    })).toMatchObject({
      optionId: 'open:cursor-project',
      target: 'cursor',
      targetSurface: 'app',
      contextCarried: false,
    });
  });

  it('labels native OpenCode resumes as terminal actions', async () => {
    const bin = makeTemp('aside-opencode-options-bin-');
    executable(bin, 'opencode');
    const capabilities = await detectAgentCapabilities({
      env: { PATH: bin },
      platform: 'darwin',
      applicationRoots: [],
    });

    const options = listAgentLaunchOptions({
      source: { provider: 'opencode', sessionId: 'opencode-1' },
      capabilities,
    });

    expect(options.find((option) => option.id === 'resume:opencode')).toMatchObject({
      label: 'Resume in OpenCode Terminal',
      kind: 'resume',
      available: true,
    });
  });
});
