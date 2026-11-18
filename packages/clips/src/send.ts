import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

export interface SendArgs { file: string; caption: string | undefined }

/** `send <file.mp4> [caption...]`: paths are relative to where the user typed the command. */
export function parseSendArgs(argv: string[], cwd: string): SendArgs {
  const [fileArg, ...rest] = argv;
  if (!fileArg) throw new Error('Usage: pnpm --filter @fir/clips send <file.mp4> [caption]');
  const caption = rest.join(' ').trim();
  return { file: resolve(cwd, fileArg), caption: caption || undefined };
}

/** KEY=value lines of an env file (comments, quotes and `export` allowed). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = /^(["'])(.*)\1/.exec(v);
    v = q ? q[2]! : v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

export interface SendEnv { token: string; chatId: string }

/**
 * `HQ_BOT_TOKEN` and `OWNER_TELEGRAM_ID` from the process env first, then from the env file `CLIPS_ENV_FILE`
 * (absolute, or relative to the package; default `../../apps/hq/.env.local`).
 */
export function loadSendEnv(env: NodeJS.ProcessEnv, pkgDir: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): SendEnv {
  const rel = env.CLIPS_ENV_FILE?.trim() || '../../apps/hq/.env.local';
  const path = isAbsolute(rel) ? rel : resolve(pkgDir, rel);
  let file: Record<string, string> = {};
  try {
    file = parseEnvFile(read(path));
  } catch {
    // no file: the process env must have both values
  }
  const token = env.HQ_BOT_TOKEN?.trim() || file.HQ_BOT_TOKEN;
  const chatId = env.OWNER_TELEGRAM_ID?.trim() || file.OWNER_TELEGRAM_ID;
  if (!token || !chatId) throw new Error(`HQ_BOT_TOKEN and OWNER_TELEGRAM_ID are needed (environment or ${path})`);
  return { token, chatId };
}

type Fetch = (url: string, init: { method: string; body: FormData }) => Promise<{ json(): Promise<unknown>; status: number }>;

/** Telegram `sendVideo` as multipart. Returns the message id. The token never appears in errors or logs. */
export async function sendVideo(
  env: SendEnv, file: string, caption: string | undefined,
  deps: { fetch?: Fetch; read?: (p: string) => Uint8Array } = {},
): Promise<number> {
  const read = deps.read ?? ((p: string) => readFileSync(p));
  const doFetch = deps.fetch ?? (fetch as unknown as Fetch);
  const form = new FormData();
  form.set('chat_id', env.chatId);
  form.set('supports_streaming', 'true');
  if (caption) form.set('caption', caption.slice(0, 1024));
  form.set('video', new Blob([read(file) as BlobPart], { type: 'video/mp4' }), basename(file));
  let res;
  try {
    res = await doFetch(`https://api.telegram.org/bot${env.token}/sendVideo`, { method: 'POST', body: form });
  } catch {
    throw new Error('Telegram is unreachable (network error)');
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
  if (!body?.ok || body.result?.message_id === undefined) throw new Error(`Telegram refused the video (HTTP ${res.status}): ${body?.description ?? 'no answer'}`);
  return body.result.message_id;
}
