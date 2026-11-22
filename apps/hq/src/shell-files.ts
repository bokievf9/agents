import { createReadStream, realpathSync, statSync, type ReadStream } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

/**
 * `GET /admin/files/<path>`: the rendered files of the content calendar (PNG of posts and slides, `reel.mp4`, PDF documents) for the workplace.
 * Only inside `DATA_DIR/renders`: the path is cleaned, resolved with `realpath` (a symlink out of the folder is refused) and
 * must stay under the real folder. Content type by extension, `Range` for video (206), `cache-control: private, max-age=300`.
 */
const TYPES: Record<string, string> = { '.png': 'image/png', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.pdf': 'application/pdf' };
export const FILE_EXTENSIONS = Object.keys(TYPES).map((e) => e.slice(1));

export type FileReply =
  | { status: 200 | 206; headers: Record<string, string>; stream: () => ReadStream }
  | { status: 400 | 404 | 416; headers: Record<string, string>; json: Record<string, unknown> };

const deny = (status: 400 | 404 | 416, error: string, headers: Record<string, string> = {}): FileReply => ({ status, headers: { 'cache-control': 'no-store', ...headers }, json: { ok: false, error } });

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` against a file of `size` bytes; null: not a single satisfiable range. */
export function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return 'unsatisfiable';
  return { start, end };
}

export interface FileAccess {
  /** The full admin token may read client documents under `cabinet/`; any other caller (the cabinet token) may not. Default true (the admin token). */
  allowCabinet?: boolean;
}

export function serveFile(rendersDir: string | undefined, rawPath: string, range?: string, access: FileAccess = {}): FileReply {
  if (!rendersDir) return deny(404, 'not_found');
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    return deny(400, 'invalid');
  }
  // a second decode must change nothing: `%252e%252e`, `%2e%2e` that survived the URL parser, encoded slashes and backslashes are refused
  if (/%/.test(rel) || /%2e|%2f|%5c/i.test(rawPath)) return deny(400, 'invalid');
  // nothing that could climb out, hide a drive or an absolute path, or break a C string
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return deny(400, 'invalid');
  if ((access.allowCabinet ?? true) === false && /^cabinet(\/|$)/i.test(rel)) return deny(404, 'not_found');
  const type = TYPES[extname(rel).toLowerCase()];
  if (!type) return deny(400, 'invalid');
  let root: string;
  let file: string;
  try {
    root = realpathSync(rendersDir);
    file = realpathSync(resolve(root, rel));
  } catch {
    return deny(404, 'not_found');
  }
  if (!file.startsWith(root + sep)) return deny(404, 'not_found');
  if ((access.allowCabinet ?? true) === false && (file === join(root, 'cabinet') || file.startsWith(join(root, 'cabinet') + sep))) return deny(404, 'not_found');
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return deny(404, 'not_found');
    size = st.size;
  } catch {
    return deny(404, 'not_found');
  }
  const base = { 'content-type': type, 'cache-control': 'private, max-age=300', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' };
  const r = range ? parseRange(range, size) : null;
  if (r === 'unsatisfiable') return deny(416, 'range_not_satisfiable', { 'content-range': `bytes */${size}` });
  if (r) return { status: 206, headers: { ...base, 'content-range': `bytes ${r.start}-${r.end}/${size}`, 'content-length': String(r.end - r.start + 1) }, stream: () => createReadStream(file, { start: r.start, end: r.end }) };
  return { status: 200, headers: { ...base, 'content-length': String(size) }, stream: () => createReadStream(file) };
}
