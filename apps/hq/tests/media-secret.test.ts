import { describe, expect, it } from 'vitest';
import { loadConfig, mediaSecretOf } from '../src/config.js';

describe('P2-3: MEDIA_SECRET is its own secret', () => {
  it('equal to WEB_CHAT_TOKEN is refused, a distinct value is used, no fallback to WEB_CHAT_TOKEN', () => {
    expect(() => mediaSecretOf({ MEDIA_SECRET: 'same-secret-0123456789', WEB_CHAT_TOKEN: 'same-secret-0123456789' })).toThrow(/differ/);
    expect(mediaSecretOf({ MEDIA_SECRET: 'media-secret-01234567', WEB_CHAT_TOKEN: 'chat-token-0123456789' })).toBe('media-secret-01234567');
    expect(mediaSecretOf({ WEB_CHAT_TOKEN: 'chat-token-0123456789' })).toBeUndefined();
  });
  it('missing in production stops the start; dev and tests may go without', () => {
    expect(() => mediaSecretOf({ NODE_ENV: 'production', WEB_CHAT_TOKEN: 'chat-token-0123456789' })).toThrow(/MEDIA_SECRET is required/);
    expect(() => mediaSecretOf({ NODE_ENV: 'production' })).toThrow(/required/);
    expect(mediaSecretOf({ NODE_ENV: 'production', MEDIA_SECRET: 'media-secret-01234567' })).toBe('media-secret-01234567');
    expect(mediaSecretOf({ NODE_ENV: 'development' })).toBeUndefined();
    expect(typeof loadConfig).toBe('function');
  });
});
