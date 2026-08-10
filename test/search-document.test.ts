import { describe, expect, it } from 'vitest';
import {
  extractSearchDocuments,
  MAX_SEARCH_DOCUMENT_CHARS,
} from '../src/core/search-document.js';

describe('search document extraction', () => {
  it('keeps Codex user and assistant prose while dropping successful tool output', () => {
    const user = extractSearchDocuments(
      JSON.stringify({
        timestamp: '2026-07-23T12:00:00Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Build content search' },
      }),
      'codex',
    );
    const assistant = extractSearchDocuments(
      JSON.stringify({
        timestamp: '2026-07-23T12:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Use an inverted index' }],
        },
      }),
      'codex',
    );
    const successfulOutput = extractSearchDocuments(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: JSON.stringify({
            output: 'thousands of noisy successful build lines',
            metadata: { exit_code: 0 },
          }),
        },
      }),
      'codex',
    );

    expect(user).toMatchObject([{ kind: 'user', body: 'Build content search' }]);
    expect(assistant).toMatchObject([
      { kind: 'assistant', body: 'Use an inverted index' },
    ]);
    expect(successfulOutput).toEqual([]);
  });

  it('indexes tool targets and failures from all supported vendors', () => {
    const claude = extractSearchDocuments(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'npm run content-search' },
            },
          ],
        },
      }),
      'claude',
    );
    const pi = extractSearchDocuments(
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          isError: true,
          content: [{ type: 'text', text: 'EADDRINUSE on the search worker' }],
        },
      }),
      'pi',
    );
    const opencode = extractSearchDocuments(
      JSON.stringify({
        schema: 'aside.opencode.v1',
        type: 'tool',
        timestamp: '2026-08-09T12:00:00Z',
        tool: 'bash',
        title: 'Run content search tests',
        input: { command: 'npm test -- search-document' },
        state: 'error',
        error: 'OpenCode search test failed',
      }),
      'opencode',
    );

    expect(claude[0]?.body).toContain('npm run content-search');
    expect(pi).toMatchObject([
      { kind: 'error', body: 'EADDRINUSE on the search worker' },
    ]);
    expect(opencode).toEqual([
      expect.objectContaining({
        kind: 'tool',
        body: expect.stringContaining('npm test -- search-document'),
      }),
      expect.objectContaining({
        kind: 'error',
        body: 'OpenCode search test failed',
      }),
    ]);
  });

  it('indexes normalized OpenCode user and assistant text', () => {
    const user = extractSearchDocuments(
      JSON.stringify({
        schema: 'aside.opencode.v1',
        type: 'text',
        role: 'user',
        text: 'Add OpenCode session discovery',
        timestamp: '2026-08-09T12:00:00Z',
      }),
      'opencode',
    );
    const assistant = extractSearchDocuments(
      JSON.stringify({
        schema: 'aside.opencode.v1',
        type: 'text',
        role: 'assistant',
        text: 'Reading the local OpenCode database safely',
        timestamp: '2026-08-09T12:00:01Z',
      }),
      'opencode',
    );

    expect(user).toMatchObject([
      { kind: 'user', body: 'Add OpenCode session discovery' },
    ]);
    expect(assistant).toMatchObject([
      { kind: 'assistant', body: 'Reading the local OpenCode database safely' },
    ]);
  });

  it('removes injected context blocks and redacts secrets before persistence', () => {
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    const [document] = extractSearchDocuments(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message:
            `<environment_context>private machine metadata</environment_context>` +
            ` Find the deploy token ${secret}`,
        },
      }),
      'codex',
    );

    expect(document?.body).not.toContain('private machine metadata');
    expect(document?.body).not.toContain(secret);
    expect(document?.body).toContain('[REDACTED]');
  });

  it('bounds individual index documents', () => {
    const [document] = extractSearchDocuments(
      JSON.stringify({
        type: 'user',
        message: { content: 'x'.repeat(MAX_SEARCH_DOCUMENT_CHARS * 2) },
      }),
      'claude',
    );
    expect(document?.body).toHaveLength(MAX_SEARCH_DOCUMENT_CHARS);
  });
});
