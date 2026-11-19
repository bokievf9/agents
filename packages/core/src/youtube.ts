import { GOOGLE_HOSTS, type PostFn } from './google-oauth.js';

/**
 * The pure part of a YouTube upload (moved from the Publisher, 2026-11-20): open a resumable session with the metadata, then send
 * the whole file in one PUT. No retries: a failed session is dropped. Used by the Publisher's `YouTubePoster` and `tools.google.youtube.upload`.
 */
export const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
/** One upload costs 1600 of the 10 000 daily units; we stop at 9 000 and leave the rest for the manual flow. */
export const YT_UPLOAD_COST = 1600;
export const YT_QUOTA_LIMIT = 9000;

export type YtUploadOutcome =
  | { ok: true; id: string }
  | { ok: false; stage: 'session' | 'upload'; status?: number; transport?: string; reason: string };

/** « quotaExceeded»: the machine reason from a Google error body, if any (never a token: those are not in answers). */
export function googleReason(body: unknown): string {
  const e = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
  const r = e?.errors?.[0]?.reason ?? e?.status;
  return typeof r === 'string' ? ` ${r.slice(0, 60)}` : '';
}

export async function youtubeResumableUpload(post: PostFn, token: string, meta: unknown, bytes: Uint8Array, mime = 'video/mp4'): Promise<YtUploadOutcome> {
  const init = await post(YT_UPLOAD_URL, {
    allowHosts: GOOGLE_HOSTS,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(bytes.length), 'x-upload-content-type': mime },
    body: JSON.stringify(meta),
    timeoutMs: 30_000,
  });
  if (!init.ok) return { ok: false, stage: 'session', transport: init.error, reason: '' };
  if (init.status !== 200 || !init.headers.location) return { ok: false, stage: 'session', status: init.status, reason: googleReason(init.body) };
  const put = await post(init.headers.location, { method: 'PUT', allowHosts: GOOGLE_HOSTS, headers: { 'content-type': mime }, body: bytes, timeoutMs: 60_000 });
  if (!put.ok) return { ok: false, stage: 'upload', transport: put.error, reason: '' };
  const id = (put.body as { id?: unknown } | null)?.id;
  if ((put.status !== 200 && put.status !== 201) || typeof id !== 'string') return { ok: false, stage: 'upload', status: put.status, reason: googleReason(put.body) };
  return { ok: true, id };
}
