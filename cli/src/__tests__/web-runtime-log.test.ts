import { expect, it } from 'vitest';
import { createSecretStreamRedactor } from '../web/runtime-log';

it('redacts model and account credentials at every chunk boundary and flushes trailing diagnostics', () => {
  const key = 'test-only-model.key+$', text = `Before ${key} middle account-token after`;
  for (let split = 0; split <= text.length; split++) {
    const redact = createSecretStreamRedactor([key, 'account-token', '', key]);
    expect(redact(text.slice(0, split)) + redact(text.slice(split)) + redact('', true)).toBe('Before [redacted] middle [redacted] after');
  }
  const redact = createSecretStreamRedactor([key]);
  expect([...text].map(character => redact(character)).join('') + redact('', true)).toBe('Before [redacted] middle account-token after');
});

it('handles overlapping credentials, repeated matches, empty secrets and incomplete values at EOF', () => {
  const redact = createSecretStreamRedactor(['long-token', 'long-token-next', 'token']);
  expect(redact('long-') + redact('token-next long-token token long-') + redact('', true)).toBe('[redacted] [redacted] [redacted] long-');
  expect(createSecretStreamRedactor([])('plain log')).toBe('plain log');
});
