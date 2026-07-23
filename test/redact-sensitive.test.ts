import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../src/core/redact-sensitive.js';

describe('redactSensitiveText', () => {
  it('redacts common provider, GitHub, Slack, AWS, and JWT credentials', () => {
    const openAiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    const githubToken = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz'].join('');
    const slackToken = ['xo', 'xb-', '123456789012-abcdefghijkl'].join('');
    const awsAccessKey = ['AK', 'IA', '1234567890ABCDEF'].join('');
    const input = [
      `OPENAI_API_KEY=${openAiKey}`,
      `github: ${githubToken}`,
      `slack=${slackToken}`,
      `aws ${awsAccessKey}`,
      'jwt eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop',
    ].join('\n');
    const output = redactSensitiveText(input);
    expect(output).not.toContain('sk-proj-');
    expect(output).not.toContain('ghp_');
    expect(output).not.toContain('xoxb-');
    expect(output).not.toContain('AKIA');
    expect(output).not.toContain('eyJ');
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('redacts secret assignments and authorization headers while preserving labels', () => {
    const output = redactSensitiveText(
      'password: "hunter2"\nAuthorization: Bearer extremely-secret-token\nnormal: visible',
    );
    expect(output).toContain('password: [REDACTED]');
    expect(output).toContain('Authorization: Bearer [REDACTED]');
    expect(output).toContain('normal: visible');
  });

  it('redacts complete private key blocks', () => {
    const begin = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const end = ['-----END ', 'PRIVATE KEY-----'].join('');
    const output = redactSensitiveText(
      `before\n${begin}\nabc123\n${end}\nafter`,
    );
    expect(output).toBe('before\n[REDACTED]\nafter');
  });
});
