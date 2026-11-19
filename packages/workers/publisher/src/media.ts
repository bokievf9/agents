import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Content types of the files the public media route may serve (renders only). */
export const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' };

/** HMAC-SHA256(secret, path) as hex, 32 chars: the unguessable part of a public media URL. */
export const signMedia = (secret: string, path: string): string => createHmac('sha256', secret).update(path).digest('hex').slice(0, 32);

export function verifyMedia(secret: string, sig: string, path: string): boolean {
  const a = Buffer.from(sig);
  const b = Buffer.from(signMedia(secret, path));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `<base>/<signature>/<path>`; the signature covers the plain path (segments are percent-encoded only on the wire). */
export const mediaUrl = (base: string, secret: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${signMedia(secret, path)}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** The path of `file` relative to the renders folder (forward slashes), or null when it lies outside. */
export function relUnder(rendersDir: string, file: string): string | null {
  const r = relative(rendersDir, file);
  return r && !r.startsWith('..') && !r.includes(':') ? r.split(sep).join('/') : null;
}

/**
 * Verifies a request for `/media/<sig>/<rel>` and finds the file. Null (a 404) for a wrong signature, a path with `..`, empty
 * or odd segments, an unknown extension, a symlink out of the folder, or a missing file. Only files under `rendersDir`.
 */
export function resolveMedia(rendersDir: string, secret: string, sig: string, rel: string): { file: string; type: string; size: number } | null {
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return null;
  const type = MEDIA_TYPES[(/\.([a-z0-9]+)$/i.exec(rel)?.[1] ?? '').toLowerCase()];
  if (!type || !/^[0-9a-f]{32}$/.test(sig) || !verifyMedia(secret, sig, rel)) return null;
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
