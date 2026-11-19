import { describe, expect, it } from 'vitest';
import { GoogleAuth, consentUrl, exchangeCode, parseClientJson, parseCode, type PostFn } from '../src/google-oauth.js';

const client = { clientId: 'cid', clientSecret: 'sec' };

describe('parseClientJson', () => {
  it('reads installed.client_id and client_secret; rubbish is null', () => {
    expect(parseClientJson('{"installed":{"client_id":"a","client_secret":"b","x":1}}')).toEqual({ clientId: 'a', clientSecret: 'b' });
    expect(parseClientJson('{"installed":{}}')).toBeNull();
    expect(parseClientJson('nope')).toBeNull();
    expect(parseClientJson(undefined)).toBeNull();
  });
});

describe('GoogleAuth', () => {
  it('exchanges the refresh token once and caches the access token until expiry minus 60 s', async () => {
    const calls: { url: string; body: string }[] = [];
    const post: PostFn = (url, o) => {
      calls.push({ url, body: String(o.body) });
      return Promise.resolve({ ok: true, status: 200, body: { access_token: `tok${calls.length}`, expires_in: 3600 }, headers: {} });
    };
    const clock = { t: 1_000_000 };
    const auth = new GoogleAuth({ client, refreshToken: 'rt', now: () => clock.t, post });
    expect(await auth.accessToken()).toBe('tok1');
    clock.t += 3_500_000; // 3500 s: still before 3600 - 60
    expect(await auth.accessToken()).toBe('tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt');
    clock.t += 100_000; // past expiry minus 60 s
    expect(await auth.accessToken()).toBe('tok2');
    expect(calls).toHaveLength(2);
  });

  it('a refusal throws without the token in the message', async () => {
    const post: PostFn = () => Promise.resolve({ ok: true, status: 400, body: { error: 'invalid_grant' }, headers: {} });
    const err = await new GoogleAuth({ client, refreshToken: 'SECRET-RT', post }).accessToken().catch((e: Error) => e.message);
    expect(err).toBe('Google OAuth: HTTP 400 invalid_grant');
  });
});

describe('one-time authorisation helpers', () => {
  it('consent URL asks for upload and readonly, offline, forced consent', () => {
    const u = new URL(consentUrl(client));
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
  });
  it('the code is taken bare or from the redirected address', () => {
    expect(parseCode('4/0AbC-d_e')).toBe('4/0AbC-d_e');
    expect(parseCode('http://localhost/?code=4%2F0AbC&scope=x')).toBe('4/0AbC');
    expect(parseCode('  ')).toBeNull();
  });
  it('exchangeCode returns the refresh token, and says so when Google sends none', async () => {
    const ok: PostFn = () => Promise.resolve({ ok: true, status: 200, body: { refresh_token: 'r1' }, headers: {} });
    expect(await exchangeCode(client, 'c', ok)).toBe('r1');
    const none: PostFn = () => Promise.resolve({ ok: true, status: 200, body: { access_token: 'a' }, headers: {} });
    await expect(exchangeCode(client, 'c', none)).rejects.toThrow(/refresh_token/);
  });
});
