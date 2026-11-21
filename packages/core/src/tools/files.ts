import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { MEDIA_TYPES, mediaUrl } from '../media-sign.js';
import type { Kit } from './kit.js';
import { policyOf } from './policy.js';
import { fail, okv, type ToolResult } from './result.js';

/** Extensions a tool may write (what agents produce: pictures, video, documents, data). */
export const FILE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'pdf', 'svg', 'txt', 'json', 'csv', 'md'] as const;
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export interface StoredFile {
  /** Path relative to the renders folder (forward slashes): what `files.get`, `files.url` and `/admin/files/` take. */
  path: string;
  size: number;
}

export interface Files {
  put(dir: string, name: string, bytes: Uint8Array | string): Promise<ToolResult<StoredFile>>;
  get(path: string): Promise<ToolResult<{ path: string; bytes: Buffer; size: number }>>;
  list(dir: string): Promise<ToolResult<(StoredFile & { name: string; modifiedAt: number })[]>>;
  /**
   * Signed public URL (`<base>/<sig>/<path>`) for png, jpg, mp4 and pdf: what Instagram and other services fetch. With `ttlMs` the link expires
   * (the signature covers the expiry, `?e=<unix seconds>`): the cabinet's document links last 7 days.
   */
  url(path: string, o?: { ttlMs?: number }): Promise<ToolResult<string>>;
  /** The absolute path of a stored file (for `telegram.sendDocument` and adapters); null when unsafe or missing. */
  absolute(path: string): string | null;
}

/** A relative path made of safe segments (`dir/sub/name.ext`), or null. No `..`, no absolute paths, no odd characters. */
export function safeRel(path: string, needFile: boolean): string | null {
  if (typeof path !== 'string' || !path || path.length > 300) return null;
  const parts = path.split('/');
  if (parts.length > 5 || parts.some((p) => !SEG.test(p) && !(p === parts[parts.length - 1] && NAME.test(p)))) return null;
  if (parts.some((p) => p === '.' || p === '..' || p.includes('..'))) return null;
  if (needFile && !FILE_TYPES.includes((/\.([a-z0-9]+)$/i.exec(parts[parts.length - 1]!)?.[1] ?? '').toLowerCase() as (typeof FILE_TYPES)[number])) return null;
  return parts.join('/');
}

export function createFiles(k: Kit): Files {
  const root = (): string | undefined => k.cfg.rendersDir ?? (k.cfg.dataDir ? join(k.cfg.dataDir, 'renders') : undefined);
  const configured = () => Boolean(root());
  const max = policyOf('files.put')!.limits.maxBytes!;

  /** The absolute path under the root, checked again after resolving symlinks of the existing part. */
  function inside(rel: string): string | null {
    const r = root();
    if (!r) return null;
    mkdirSync(r, { recursive: true });
    const base = realpathSync(r);
    const abs = resolve(base, ...rel.split('/'));
    if (!abs.startsWith(base + sep)) return null;
    // the deepest existing ancestor must still be inside (a symlinked folder cannot lead out)
    let probe = abs;
    while (!existsSync(probe)) probe = resolve(probe, '..');
    const real = realpathSync(probe);
    return real === base || real.startsWith(base + sep) ? abs : null;
  }

  return {
    absolute: (path) => {
      const rel = safeRel(path, true);
      if (!rel || !configured()) return null;
      const abs = inside(rel);
      return abs && existsSync(abs) ? abs : null;
    },
    put: (dir, name, bytes) =>
      k.call('files.put', async () => {
        const rel = safeRel(`${dir}/${name}`, true);
        if (!rel || !SEG.test(String(dir).split('/')[0] ?? '')) return fail('invalid', 'unsafe or unsupported file name');
        const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
        if (buf.length > max) return fail('too_large', `file over ${max} bytes`);
        const abs = inside(rel);
        if (!abs) return fail('blocked', 'path leads outside the files folder');
        mkdirSync(resolve(abs, '..'), { recursive: true });
        const tmp = `${abs}.tmp-${process.pid}-${k.now()}`;
        writeFileSync(tmp, buf);
        renameSync(tmp, abs);
        return okv({ path: rel, size: buf.length });
      }),
    get: (path) =>
      k.call('files.get', async () => {
        const rel = safeRel(path, true);
        if (!rel) return fail('invalid', 'unsafe path');
        const abs = inside(rel);
        if (!abs) return fail('blocked', 'path leads outside the files folder');
        if (!existsSync(abs) || !statSync(abs).isFile()) return fail('not_found', 'no such file');
        const size = statSync(abs).size;
        if (size > max) return fail('too_large', `file over ${max} bytes`);
        return okv({ path: rel, bytes: readFileSync(abs), size });
      }),
    list: (dir) =>
      k.call('files.list', async () => {
        const rel = safeRel(dir, false);
        if (!rel) return fail('invalid', 'unsafe folder');
        const abs = inside(rel);
        if (!abs) return fail('blocked', 'path leads outside the files folder');
        if (!existsSync(abs)) return okv([]);
        const out = readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.isFile() && NAME.test(e.name) && !e.name.includes('.tmp-'))
          .map((e) => {
            const st = statSync(join(abs, e.name));
            return { name: e.name, path: `${rel}/${e.name}`, size: st.size, modifiedAt: st.mtimeMs };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        return okv(out);
      }),
    url: (path, o = {}) =>
      k.call('files.url', async () => {
        const rel = safeRel(path, true);
        if (!rel) return fail('invalid', 'unsafe path');
        const ext = (/\.([a-z0-9]+)$/i.exec(rel)?.[1] ?? '').toLowerCase();
        if (!MEDIA_TYPES[ext]) return fail('invalid', `the public media route serves ${Object.keys(MEDIA_TYPES).join(', ')} only`);
        const abs = inside(rel);
        if (!abs) return fail('blocked', 'path leads outside the files folder');
        if (!existsSync(abs)) return fail('not_found', 'no such file');
        if (o.ttlMs !== undefined && !(Number.isFinite(o.ttlMs) && o.ttlMs > 0 && o.ttlMs <= 30 * 86_400_000)) return fail('invalid', 'ttlMs: up to 30 days');
        return okv(mediaUrl(k.cfg.mediaBase!, k.cfg.mediaSecret!, rel, o.ttlMs !== undefined ? { expiresAt: k.now() + o.ttlMs } : {}));
      }),
  };
}
