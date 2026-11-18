import { describe, expect, it } from 'vitest';
import { loadSendEnv, parseEnvFile, parseSendArgs, sendVideo } from '../src/send';

describe('clips send', () => {
  it('parses args: file relative to cwd, caption joined', () => {
    expect(parseSendArgs(['out/a.mp4', 'Привет', 'мир'], '/w')).toEqual({ file: '/w/out/a.mp4', caption: 'Привет мир' });
    expect(parseSendArgs(['/x/a.mp4'], '/w')).toEqual({ file: '/x/a.mp4', caption: undefined });
    expect(() => parseSendArgs([], '/w')).toThrow(/Usage/);
  });

  it('parses env files', () => {
    expect(parseEnvFile('# c\nexport A=1\nB="x y" # note\nC=z # n\n\nbad line')).toEqual({ A: '1', B: 'x y', C: 'z' });
  });

  it('loads env from process first, then from the file (default and absolute path)', () => {
    const reads: string[] = [];
    const read = (p: string) => { reads.push(p); return 'HQ_BOT_TOKEN=ftok\nOWNER_TELEGRAM_ID=42\n'; };
    expect(loadSendEnv({}, '/repo/packages/clips', read)).toEqual({ token: 'ftok', chatId: '42' });
    expect(reads[0]).toBe('/repo/apps/hq/.env.local');
    expect(loadSendEnv({ HQ_BOT_TOKEN: 'etok', CLIPS_ENV_FILE: '/abs/.env' }, '/p', read)).toEqual({ token: 'etok', chatId: '42' });
    expect(reads[1]).toBe('/abs/.env');
    expect(() => loadSendEnv({}, '/p', () => { throw new Error('ENOENT'); })).toThrow(/HQ_BOT_TOKEN/);
  });

  it('sends multipart sendVideo and returns the message id; the token stays out of errors', async () => {
    const calls: { url: string; body: FormData }[] = [];
    const ok = (async (url: string, init: { body: FormData }) => { calls.push({ url, body: init.body }); return { status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }) }; });
    const id = await sendVideo({ token: 'SECRET', chatId: '42' }, '/o/a.mp4', 'cap', { fetch: ok, read: () => new Uint8Array([1, 2, 3]) });
    expect(id).toBe(77);
    expect(calls[0]!.url).toBe('https://api.telegram.org/botSECRET/sendVideo');
    expect(calls[0]!.body.get('chat_id')).toBe('42');
    expect(calls[0]!.body.get('caption')).toBe('cap');
    expect((calls[0]!.body.get('video') as File).name).toBe('a.mp4');
    const bad = (async () => ({ status: 400, json: async () => ({ ok: false, description: 'Bad Request' }) }));
    await expect(sendVideo({ token: 'SECRET', chatId: '1' }, '/o/a.mp4', undefined, { fetch: bad, read: () => new Uint8Array() })).rejects.toThrow(/Bad Request/);
    const down = (async () => { throw new Error('connect https://api.telegram.org/botSECRET/x'); });
    await expect(sendVideo({ token: 'SECRET', chatId: '1' }, '/o/a.mp4', undefined, { fetch: down, read: () => new Uint8Array() })).rejects.not.toThrow(/SECRET/);
  });
});
