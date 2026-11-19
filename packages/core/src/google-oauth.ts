import { safePost, type SafePostOptions } from './net.js';

/** Hosts a YouTube client may call. */
export const GOOGLE_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com', 'youtube.googleapis.com'] as const;
export const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] as const;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Reads the Google «Desktop app» client JSON (`{"installed":{"client_id","client_secret",...}}`, «web» is accepted too). Null when it is not one. */
export function parseClientJson(raw: string | undefined): OAuthClient | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { installed?: Record<string, unknown>; web?: Record<string, unknown> };
    const c = j.installed ?? j.web;
    return typeof c?.client_id === 'string' && typeof c.client_secret === 'string' && c.client_id && c.client_secret ? { clientId: c.client_id, clientSecret: c.client_secret } : null;
  } catch {
    return null;
  }
}

export type PostFn = (url: string, opts: SafePostOptions) => ReturnType<typeof safePost>;

export interface GoogleAuthOptions {
  client: OAuthClient;
  refreshToken: string;
  now?: () => number;
  /** Tests. */
  post?: PostFn;
}

/** Refresh-token flow. The access token is cached in memory until 60 s before it expires. Tokens are never logged or put into errors. */
export class GoogleAuth {
  private cached: { token: string; until: number } | null = null;
  private readonly now: () => number;
  private readonly post: PostFn;

  constructor(private readonly o: GoogleAuthOptions) {
    this.now = o.now ?? Date.now;
    this.post = o.post ?? safePost;
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.until > this.now()) return this.cached.token;
    const body = new URLSearchParams({ client_id: this.o.client.clientId, client_secret: this.o.client.clientSecret, refresh_token: this.o.refreshToken, grant_type: 'refresh_token' }).toString();
    const r = await this.post(TOKEN_URL, { allowHosts: GOOGLE_HOSTS, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 15_000 });
    if (!r.ok) throw new Error(`Google OAuth: ${r.error}`);
    const b = r.body as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (r.status !== 200 || typeof b?.access_token !== 'string') throw new Error(`Google OAuth: HTTP ${r.status}${typeof b?.error === 'string' ? ` ${b.error}` : ''}`);
    const ttl = typeof b.expires_in === 'number' ? b.expires_in : 3600;
    this.cached = { token: b.access_token, until: this.now() + ttl * 1000 - 60_000 };
    return b.access_token;
  }
}

export const REDIRECT_URI = 'http://localhost';

/** The consent URL for the one-time authorisation (offline access, forced consent so Google returns a refresh token). */
export function consentUrl(client: OAuthClient): string {
  const q = new URLSearchParams({ client_id: client.clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: YT_SCOPES.join(' '), access_type: 'offline', prompt: 'consent' });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

/** The pasted text is the bare code or the whole address the browser ended on (`http://localhost/?code=...`). */
export function parseCode(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//.test(t)) {
    try {
      return new URL(t).searchParams.get('code');
    } catch {
      return null;
    }
  }
  return /^[\w\-./~]+$/.test(t) ? t : null;
}

/** Exchanges the pasted code for a refresh token. */
export async function exchangeCode(client: OAuthClient, code: string, post: PostFn = safePost): Promise<string> {
  const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }).toString();
  const r = await post(TOKEN_URL, { allowHosts: GOOGLE_HOSTS, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 15_000 });
  if (!r.ok) throw new Error(`Google OAuth: ${r.error}`);
  const b = r.body as { refresh_token?: unknown; error?: unknown } | null;
  if (r.status !== 200 || typeof b?.refresh_token !== 'string') throw new Error(`Google OAuth: HTTP ${r.status}${typeof b?.error === 'string' ? ` ${b.error}` : ''}${r.status === 200 ? ' (нет refresh_token: отзовите доступ приложения в аккаунте Google и повторите)' : ''}`);
  return b.refresh_token;
}
