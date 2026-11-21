/**
 * Signed public URLs of rendered files (`GET /media/<sig>/<path>` on the HQ webhook). Moved here from the Publisher (2026-11-20) so
 * `tools.files.url` signs exactly the way the route verifies; the Publisher re-exports it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Content types of the files the public media route may serve (renders only). */
export const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4', pdf: 'application/pdf' };

/** What a cabinet client may upload and download (`DATA_DIR/uploads/<client>/`): pictures, PDF, Word, zip, plain text for the agent's knowledge. */
export const UPLOAD_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
};

/** HMAC-SHA256(secret, path) as hex, 32 chars: the unguessable part of a public media URL. */
export const signMedia = (secret: string, path: string): string => createHmac('sha256', secret).update(path).digest('hex').slice(0, 32);

export function verifyMedia(secret: string, sig: string, path: string): boolean {
  const a = Buffer.from(sig);
  const b = Buffer.from(signMedia(secret, path));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `<base>/<signature>/<path>`; the signature covers the plain path (segments are percent-encoded only on the wire). */
export const mediaUrl = (base: string, secret: string, path: string, o: { expiresAt?: number } = {}): string => {
  const wire = path.split('/').map(encodeURIComponent).join('/');
  if (o.expiresAt === undefined) return `${base.replace(/\/+$/, '')}/${signMedia(secret, path)}/${wire}`;
  // an expiring link: the signature covers the path AND the expiry (unix seconds), so the expiry cannot be cut off or moved
  const e = Math.floor(o.expiresAt / 1000);
  return `${base.replace(/\/+$/, '')}/${signMedia(secret, `${path}?e=${e}`)}/${wire}?e=${e}`;
};

/** The path of `file` relative to the renders folder (forward slashes), or null when it lies outside. */
export function relUnder(rendersDir: string, file: string): string | null {
  const r = relative(rendersDir, file);
  return r && !r.startsWith('..') && !r.includes(':') ? r.split(sep).join('/') : null;
}

/**
 * Verifies a request for `/media/<sig>/<rel>` and finds the file. Null (a 404) for a wrong signature, a path with `..`, empty
 * or odd segments, an unknown extension, a symlink out of the folder, or a missing file. Only files under `rendersDir`.
 */
export function resolveMedia(
  rendersDir: string, secret: string, sig: string, rel: string,
  o: { exp?: number | null; now?: number; types?: Record<string, string> } = {},
): { file: string; type: string; size: number } | null {
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return null;
  const type = (o.types ?? MEDIA_TYPES)[(/\.([a-z0-9]+)$/i.exec(rel)?.[1] ?? '').toLowerCase()];
  if (!type || !/^[0-9a-f]{32}$/.test(sig)) return null;
  if (o.exp !== undefined && o.exp !== null) {
    // expired, or a signature made for another expiry (or for none): the same 404 as an unknown file
    if (!Number.isInteger(o.exp) || o.exp * 1000 < (o.now ?? Date.now()) || !verifyMedia(secret, sig, `${rel}?e=${o.exp}`)) return null;
  } else if (!verifyMedia(secret, sig, rel)) return null;
  try {
    const root = realpathSync(rendersDir);
    const file = realpathSync(join(root, ...parts));
    if (!file.startsWith(root + sep)) return null;
    const st = statSync(file);
    return st.isFile() ? { file, type, size: st.size } : null;
  } catch {
    return null;
  }
}
