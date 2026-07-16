import { describe, it, expect } from 'vitest';
import { buildDockArgs, buildTmuxBindLine } from '../src/launcher.js';

const DEFAULTS = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
};

describe('buildDockArgs', () => {
  it('forwards nothing when only defaults are set', () => {
    expect(
      buildDockArgs(
        { provider: DEFAULTS.provider, model: DEFAULTS.model },
        DEFAULTS,
      ),
    ).toEqual([]);
  });

  it('forwards changed provider/model and project', () => {
    const args = buildDockArgs(
      { provider: 'openai', model: 'gpt-4o-mini', project: 'myrepo' },
      DEFAULTS,
    );
    expect(args).toEqual(['--provider', 'openai', '--model', 'gpt-4o-mini', '--project', 'myrepo']);
  });

  it('only forwards a valid --source', () => {
    expect(
      buildDockArgs({ provider: DEFAULTS.provider, model: DEFAULTS.model, source: 'codex' }, DEFAULTS),
    ).toEqual(['--source', 'codex']);
    expect(
      buildDockArgs({ provider: DEFAULTS.provider, model: DEFAULTS.model, source: 'bogus' }, DEFAULTS),
    ).toEqual([]);
  });

  it('forwards each repeated --session', () => {
    const args = buildDockArgs(
      { provider: DEFAULTS.provider, model: DEFAULTS.model, session: ['a', 'b'] },
      DEFAULTS,
    );
    expect(args).toEqual(['--session', 'a', '--session', 'b']);
  });

});

describe('buildTmuxBindLine', () => {
  const line = buildTmuxBindLine('/usr/local/bin/node', '/Users/v/aside/dist/cli.js');

  it('binds <prefix> C-a to a run-shell command', () => {
    expect(line).toMatch(/^bind-key C-a run-shell '/);
  });

  it('double-quotes each path inside the single-quoted run-shell arg', () => {
    expect(line).toContain('"/usr/local/bin/node"');
    expect(line).toContain('"/Users/v/aside/dist/cli.js"');
    expect(line).toContain('"dock"');
  });

  it('avoids the fragile shell-nested-quote idiom that breaks tmux.conf', () => {
    expect(line).not.toContain(`'\\''`);
  });
});
