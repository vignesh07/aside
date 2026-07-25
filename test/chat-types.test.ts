import { describe, expect, it } from 'vitest';
import {
  FLEET_THREAD_ID,
  legacySessionThreadId,
  scopeFromThreadId,
  sessionThreadId,
} from '../src/types/chat.js';

describe('session side-chat ids', () => {
  it('round-trips a provider-qualified id without truncating the vendor id', () => {
    const id = sessionThreadId('codex', 'root:worker:42');
    expect(id).toBe('session:codex:root:worker:42');
    expect(scopeFromThreadId(id)).toEqual({
      kind: 'session',
      source: 'codex',
      sessionId: 'root:worker:42',
    });
  });

  it('keeps pre-namespacing session ids readable for migration', () => {
    expect(scopeFromThreadId(legacySessionThreadId('old-id'))).toEqual({
      kind: 'session',
      sessionId: 'old-id',
    });
  });

  it('fails closed to fleet for malformed thread ids', () => {
    expect(scopeFromThreadId(FLEET_THREAD_ID)).toEqual({ kind: 'fleet' });
    expect(scopeFromThreadId('session:')).toEqual({ kind: 'fleet' });
    expect(scopeFromThreadId('something-else')).toEqual({ kind: 'fleet' });
  });
});
