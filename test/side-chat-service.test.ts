import { describe, it, expect } from 'vitest';
import { SideChatService, type AskEngine } from '../src/core/side-chat-service.js';
import type { AskParams } from '../src/core/side-chat-engine.js';

class FakeEngine implements AskEngine {
  calls: AskParams[] = [];
  constructor(private responder: (p: AskParams) => Promise<string> = async () => 'ok') {}
  async ask(params: AskParams): Promise<string> {
    this.calls.push(params);
    return this.responder(params);
  }
  setModel(): void {}
}

describe('SideChatService.ask', () => {
  it('appends a user turn then an assistant turn', async () => {
    const engine = new FakeEngine(async () => 'because the test said so');
    const svc = new SideChatService(engine);
    await svc.ask('s1', 'why?');

    const chat = svc.getChat('s1');
    expect(chat.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(chat[0]!.content).toBe('why?');
    expect(chat[1]!.content).toBe('because the test said so');
    expect(chat[1]!.error).toBe(false);
  });

  it('passes prior turns as history but not the current question', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine);
    await svc.ask('s1', 'first');
    await svc.ask('s1', 'second');

    // Second call: history should be the two prior turns (Q1 + A1), and the
    // question is delivered separately, never inside history.
    const secondCall = engine.calls[1]!;
    expect(secondCall.question).toBe('second');
    expect(secondCall.history.map((t) => t.content)).toEqual(['first', 'ok']);
    expect(secondCall.history.some((t) => t.content === 'second')).toBe(false);
  });

  it('records an error turn when the engine throws', async () => {
    const engine = new FakeEngine(async () => {
      throw new Error('rate limited');
    });
    const svc = new SideChatService(engine);
    await svc.ask('s1', 'hi');

    const last = svc.getChat('s1').at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.error).toBe(true);
    expect(last.content).toContain('rate limited');
  });

  it('toggles thinking true during the call and false after', async () => {
    let resolve!: (v: string) => void;
    const engine = new FakeEngine(() => new Promise<string>((r) => (resolve = r)));
    const log: boolean[] = [];
    const svc = new SideChatService(engine, { onThinking: (t) => log.push(t) });

    const pending = svc.ask('s1', 'q');
    expect(svc.isThinking()).toBe(true);
    resolve('done');
    await pending;
    expect(svc.isThinking()).toBe(false);
    expect(log).toEqual([true, false]);
  });

  it('is a no-op for a null session or empty question', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine);
    await svc.ask(null, 'q');
    await svc.ask('s1', '   ');
    expect(engine.calls).toHaveLength(0);
    expect(svc.getChat('s1')).toEqual([]);
  });

  it('keeps separate chat histories per session', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine);
    await svc.ask('a', 'qa');
    await svc.ask('b', 'qb');
    expect(svc.getChat('a').map((t) => t.content)).toEqual(['qa', 'ok']);
    expect(svc.getChat('b').map((t) => t.content)).toEqual(['qb', 'ok']);
  });
});
