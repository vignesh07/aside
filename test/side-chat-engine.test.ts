import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '../src/core/side-chat-engine.js';

describe('SYSTEM_PROMPT', () => {
  it('declares the observer read-only with no tools', () => {
    expect(SYSTEM_PROMPT).toMatch(/READ-ONLY/);
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/no tools|cannot edit/);
  });

  it('frames the view as spanning every session, not one', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/bird's-eye|every session|all sessions/);
  });

  it('bounds the scope honestly to agent sessions only', () => {
    // The product promise must not imply visibility into the whole machine.
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/cannot see builds|agent sessions only/);
  });

  it('tells the model to use the supplied clock for idleness', () => {
    // Elapsed time is underivable from a transcript: silence writes nothing.
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/quiet for|current time/);
  });

  it('warns against reading truncation as the agent stopping', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/truncat/);
  });

  it('distinguishes benign quiet from a stall', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/waiting for input|not automatically a problem/);
  });

  it('asks for plain prose, since both frontends render text literally', () => {
    // Markdown is not parsed by the Ink pane or the menubar renderer, so "##"
    // and "**" reach the user verbatim.
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/plain prose/);
    expect(SYSTEM_PROMPT).toMatch(/markdown/i);
  });
});
