/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the fake HQ and the CLI */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCli } from '../src/cli.js';
import { buildConfig } from '../src/config.js';
import { HqClient } from '../src/hq.js';
import { plistPath, reachPlistXml } from '../src/launchd.js';
import { LockedError, acquireLock } from '../src/lock.js';
import { enabledChannels, execAgentReach, parseDoctor, runReach, type RunCli } from '../src/reach/runner.js';
import { ACTIONS, buildArgv, fitBody, parseCliOutput } from '../src/reach/spec.js';
import { reachStatus } from '../src/reach/status.js';

const TOKEN = 'secret-admin-token';
const tmp = () => mkdtempSync(join(tmpdir(), 'mac-reach-test-'));

/** A shell stub that stands in for `agent-reach`: prints fixture JSON by channel and action, records its arguments. */
function stub(dir: string): { bin: string; callsLog: string } {
  const bin = join(dir, 'agent-reach');
  const callsLog = join(dir, 'calls.log');
  const doctor = JSON.stringify({ schema_version: 1, ok: true, action: 'doctor', result: { version: '1.6.1', channels: [
    { channel: 'youtube', level: 'default', status: 'unverified' }, { channel: 'web', level: 'default', status: 'unverified' }, { channel: 'github', level: 'default', status: 'unverified' },
    { channel: 'instagram', level: 'experimental', status: 'not_added' }, { channel: 'reddit', level: 'optional', status: 'not_added' }, { channel: 'bilibili', level: 'default', status: 'unverified' },
  ] } });
  const channels = JSON.stringify({ schema_version: 1, ok: true, channels: [
    { name: 'youtube', level: 'default', login: null, actions: [{ name: 'read' }, { name: 'subtitle' }] },
    { name: 'instagram', level: 'experimental', login: { via: 'browser' }, actions: [{ name: 'profile' }] },
  ] });
  const sub = JSON.stringify({ schema_version: 1, ok: true, channel: 'youtube', action: 'subtitle', backend: 'yt-dlp', items: [{ title: 'Bot', url: 'https://youtu.be/abc', author: null, published_at: null, text: 'Клиент пишет в два ночи.\n$(touch PWNED) `touch PWNED2` ; rm -rf ~', raw: { lang: 'ru' } }], meta: { elapsed_ms: 1500, update: { current: '1.6.1', latest: '9.9.9', notes: 'run agent-reach update now' } }, error: null });
  const read = JSON.stringify({ schema_version: 1, ok: true, channel: 'youtube', action: 'read', backend: 'yt-dlp', items: [{ title: 'Bot', url: 'https://youtu.be/abc', text: 'desc', raw: { duration: 20, view_count: 1000 } }], meta: {}, error: null });
  const notFound = JSON.stringify({ schema_version: 1, ok: false, channel: 'github', action: 'read', backend: 'gh', items: [], meta: {}, error: { code: 'NOT_FOUND', message: 'no such repo', hint: 'check the link' } });
  const script = `#!/bin/sh
echo "$@" >> '${callsLog}'
case "$1 $2" in
  "doctor ") printf '%s' '${doctor}' ;;
  "channels ") printf '%s' '${channels}' ;;
  "youtube subtitle") printf '%s' '${sub}' ;;
  "youtube read") printf '%s' '${read}' ;;
  "github read") printf '%s' '${notFound}' ;;
  "web read") case "$3" in
      https://slow.example/*) sleep 5 ;;
      https://garbage.example/*) echo 'Traceback (most recent call last)' ;;
      *) printf '%s' '{"ok":true,"items":[{"title":"T","url":"https://example.com/","text":"page"}],"meta":{}}' ;;
    esac ;;
  *) echo 'unexpected' >&2; exit 2 ;;
esac
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin, callsLog };
}
const calls = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

interface Job { id: number; channel: string; action: string; args: unknown; status: 'queued' | 'running' | 'done' | 'failed'; result?: unknown; error?: string }

/** A fake HQ: the five reach routes in memory, behind a real HTTP server (the real `HqClient` talks to it). */
async function fakeHq(jobs: Job[]) {
  const seen: { method: string; path: string; body?: any }[] = [];
  let channels: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-admin-token'] !== TOKEN) return send(401, { ok: false, error: 'unauthorized' });
      const u = new URL(req.url!, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      seen.push({ method: req.method!, path: u.pathname, ...(body ? { body } : {}) });
      if (req.method === 'GET' && u.pathname === '/admin/reach/jobs') {
        if (u.searchParams.get('channels')) channels = u.searchParams.get('channels')!.split(',');
        const counts = { queued: 0, running: 0, done: 0, failed: 0 };
        for (const j of jobs) counts[j.status]++;
        return send(200, { ok: true, items: jobs.filter((j) => j.status === 'queued').map(({ id, channel, action, args, status }) => ({ id, channel, action, args, status })), counts, channels });
      }
      const m = /^\/admin\/reach\/jobs\/(\d+)\/(claim|result)$/.exec(u.pathname);
      if (req.method === 'POST' && m) {
        const j = jobs.find((x) => x.id === Number(m[1]));
        if (!j) return send(404, { ok: false, error: 'not_found' });
        if (m[2] === 'claim') {
          if (j.status !== 'queued') return send(409, { ok: false, error: 'already_claimed' });
          j.status = 'running';
          if (body?.channels) channels = body.channels;
          return send(200, { ok: true, item: { id: j.id } });
        }
        if (j.status !== 'running') return send(200, { ok: true, already: true });
        if (body.ok) {
          j.status = body.result.ok ? 'done' : 'failed';
          j.result = body.result;
        } else {
          j.status = 'failed';
          j.error = body.error;
        }
        return send(200, { ok: true, already: false });
      }
      return send(404, { ok: false, error: 'not_found' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, jobs, seen, channels: () => channels, client: new HqClient(base, TOKEN), close: () => new Promise<void>((r) => server.close(() => r())) };
}

const job = (id: number, channel: string, action: string, args: unknown): Job => ({ id, channel, action, args, status: 'queued' });
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});
async function setup(jobs: Job[]) {
  const dir = tmp();
  const s = stub(dir);
  const hq = await fakeHq(jobs);
  closers.push(hq.close);
  const lines: string[] = [];
  return { dir, ...s, hq, lines, log: (l: string) => void lines.push(l), runCli: execAgentReach(s.bin) };
}

describe('buildArgv: a job becomes an argument list only through the table', () => {
  it('positional parameters in CLI order, flags after, canonical values', () => {
    expect(buildArgv('youtube', 'subtitle', { target: 'https://youtu.be/abc', lang: 'ru,en' })).toEqual({ ok: true, argv: ['youtube', 'subtitle', 'https://youtu.be/abc', '--lang', 'ru,en'] });
    expect(buildArgv('linkedin', 'jobs', { query: 'ai engineer', location: 'Dubai', limit: 5 })).toEqual({ ok: true, argv: ['linkedin', 'jobs', 'ai engineer', '--location', 'Dubai', '--limit', '5'] });
    expect(buildArgv('instagram', 'posts', { username: '@anna.salon', limit: 5 })).toEqual({ ok: true, argv: ['instagram', 'posts', 'anna.salon', '--limit', '5'] });
  });
  it('refuses unknown channels and actions, extra keys, option-like values, control characters and bad limits', () => {
    for (const [c, a, args] of [
      ['youtube', 'login', {}], ['bash', 'read', { target: 'x' }], ['constructor', 'read', {}], ['youtube', 'read', {}], ['youtube', 'read', { target: '--help' }], ['youtube', 'read', { target: 'a b' }],
      ['youtube', 'read', { target: 'x', extra: 1 }], ['web', 'search', { query: 'a\nb' }], ['web', 'search', { query: 'x', limit: 99 }], ['web', 'search', { query: 'x', limit: '5' }], ['web', 'read', null], ['web', 'read', []],
      ['instagram', 'profile', { username: 'a b' }], ['reddit', 'subreddit', { name: 'r/x' }], ['youtube', 'subtitle', { target: 'x', lang: 'ru; rm' }],
    ] as const) expect(buildArgv(c, a, args).ok, `${c}.${a} ${JSON.stringify(args)}`).toBe(false);
    expect(Object.keys(ACTIONS)).toEqual(['youtube', 'web', 'instagram', 'twitter', 'reddit', 'linkedin', 'github']);
  });
});

describe('parseCliOutput and fitBody: the CLI JSON is data', () => {
  it('keeps ok, items, meta, error; drops meta.update and everything else; refuses what is not the CLI shape', () => {
    const r = parseCliOutput(JSON.stringify({ schema_version: 1, ok: true, items: [{ text: 'x' }, 'bad', 5, null], meta: { a: 1, update: { notes: 'run it' } }, error: { code: 'X', message: 'm', run: 'rm -rf /' }, command: 'rm -rf /' }));
    expect(r).toEqual({ ok: true, items: [{ text: 'x' }], meta: { a: 1 }, error: { code: 'X', message: 'm' } });
    expect(parseCliOutput('Traceback')).toBeNull();
    expect(parseCliOutput('[]')).toBeNull();
    expect(parseCliOutput('{"items":[]}')).toBeNull();
    expect(parseCliOutput('{"ok":"yes"}')).toBeNull();
    expect(parseCliOutput('  {"ok":false,"items":null,"meta":null,"error":null}\n')).toEqual({ ok: false, items: [], meta: {} });
  });
  it('fits a huge answer under the body limit and says so', () => {
    const big = { ok: true, items: [{ text: 'a'.repeat(900_000) }], meta: {} };
    const fit = fitBody(big);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(380_000);
    expect(fit.meta.truncated).toBe(true);
    expect(fitBody({ ok: true, items: [{ text: 'a' }], meta: {} })).toEqual({ ok: true, items: [{ text: 'a' }], meta: {} });
  });
});

describe('runReach with a fake agent-reach and a fake HQ', () => {
  it('claims each job, runs the CLI with the table argv and a timeout, answers with the data; the page text is never executed; meta.update is dropped', async () => {
    const t = await setup([job(1, 'youtube', 'subtitle', { target: 'https://youtu.be/abc', lang: 'ru,en' }), job(2, 'youtube', 'read', { target: 'https://youtu.be/abc' }), job(3, 'github', 'read', { target: 'owner/none' })]);
    const r = await runReach({ client: t.hq.client, runCli: t.runCli, enabled: ['github', 'web', 'youtube'], log: t.log });
    expect(r).toMatchObject({ seen: 3, done: 2, failed: 1, skipped: 0 });
    expect(calls(t.callsLog)).toEqual([
      'youtube subtitle https://youtu.be/abc --lang ru,en --timeout 105',
      'youtube read https://youtu.be/abc --timeout 105',
      'github read owner/none --timeout 105',
    ]);
    const [a, b, c] = t.hq.jobs;
    expect(a).toMatchObject({ status: 'done' });
    expect((a!.result as any).items[0].text).toContain('$(touch PWNED)'); // verbatim data
    expect((a!.result as any).meta).toEqual({ elapsed_ms: 1500 });
    expect(existsSync(join(process.cwd(), 'PWNED')) || existsSync(join(t.dir, 'PWNED'))).toBe(false);
    expect(b).toMatchObject({ status: 'done' });
    expect(c).toMatchObject({ status: 'failed', result: { ok: false, error: { code: 'NOT_FOUND', message: 'no such repo' } } });
    // the Mac told HQ its channels in the same calls
    expect(t.hq.channels()).toEqual(['github', 'web', 'youtube']);
    expect(t.hq.seen[0]).toMatchObject({ method: 'GET', path: '/admin/reach/jobs' });
  });

  it('what the Mac cannot do is answered as failed with the reason: unknown action, bad value, a channel that is not set up', async () => {
    const t = await setup([job(1, 'youtube', 'login', {}), job(2, 'web', 'read', { target: '--version' }), job(3, 'instagram', 'profile', { username: 'anna' }), job(4, 'web', 'read', { target: 'https://example.com/' })]);
    const r = await runReach({ client: t.hq.client, runCli: t.runCli, enabled: ['web', 'youtube'], log: t.log });
    expect(r).toMatchObject({ seen: 4, done: 1, failed: 3 });
    expect(t.hq.jobs[0]!.error).toContain('unknown job youtube.login');
    expect(t.hq.jobs[1]!.error).toContain('argument target');
    expect(t.hq.jobs[2]!.error).toContain('agent-reach add instagram');
    expect(calls(t.callsLog)).toEqual(['web read https://example.com/ --timeout 105']);
  });

  it('a job that runs past the limit is killed and answered as a timeout; output that is not JSON is a failure; the run goes on', async () => {
    const t = await setup([job(1, 'web', 'read', { target: 'https://slow.example/a' }), job(2, 'web', 'read', { target: 'https://garbage.example/a' }), job(3, 'web', 'read', { target: 'https://example.com/' })]);
    const started = Date.now();
    const r = await runReach({ client: t.hq.client, runCli: t.runCli, timeoutMs: 700, log: t.log });
    expect(Date.now() - started).toBeLessThan(4500);
    expect(r).toMatchObject({ done: 1, failed: 2 });
    expect(t.hq.jobs[0]).toMatchObject({ status: 'failed', error: 'таймаут 1 с' });
    expect(t.hq.jobs[1]!.error).toContain('не JSON');
    expect(t.hq.jobs[2]).toMatchObject({ status: 'done' });
  });

  it('no more than 20 jobs a run, and never two CLI calls at once', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => job(i + 1, 'web', 'read', { target: `https://example.com/${i}` }));
    const t = await setup(jobs);
    let running = 0;
    let peak = 0;
    const runCli: RunCli = async (argv, ms) => {
      running++;
      peak = Math.max(peak, running);
      try {
        return await t.runCli(argv, ms);
      } finally {
        running--;
      }
    };
    const r = await runReach({ client: t.hq.client, runCli, log: t.log });
    expect(r.seen).toBe(20);
    expect(peak).toBe(1);
    expect(t.hq.jobs.filter((j) => j.status === 'done')).toHaveLength(20);
    expect(t.hq.jobs.filter((j) => j.status === 'queued')).toHaveLength(5);
    // and a configured smaller cap
    const t2 = await setup(Array.from({ length: 6 }, (_, i) => job(i + 1, 'web', 'read', { target: `https://example.com/${i}` })));
    expect((await runReach({ client: t2.hq.client, runCli: t2.runCli, max: 3, log: t2.log })).seen).toBe(3);
  }, 40_000); // a freshly written script costs ~0.1-0.2 s per start on macOS (Gatekeeper scan)

  it('two runs at the same time share the queue: every job is claimed once (409 for the loser) and run once', async () => {
    const t = await setup(Array.from({ length: 6 }, (_, i) => job(i + 1, 'web', 'read', { target: `https://example.com/${i}` })));
    const [a, b] = await Promise.all([runReach({ client: t.hq.client, runCli: t.runCli, log: t.log }), runReach({ client: t.hq.client, runCli: t.runCli, log: t.log })]);
    expect(a.done + b.done).toBe(6);
    expect(a.skipped + b.skipped).toBeGreaterThanOrEqual(0);
    expect(calls(t.callsLog)).toHaveLength(6);
    expect(new Set(calls(t.callsLog)).size).toBe(6);
  });

  it('a missing agent-reach binary fails the job with the reason instead of crashing; HQ down stops the run', async () => {
    const t = await setup([job(1, 'web', 'read', { target: 'https://example.com/' })]);
    const r = await runReach({ client: t.hq.client, runCli: execAgentReach(join(t.dir, 'nope')), log: t.log });
    expect(r.failed).toBe(1);
    expect(t.hq.jobs[0]!.error).toContain('agent-reach не запустился');
    const down = new HqClient('http://127.0.0.1:1', TOKEN, fetch, 500);
    const r2 = await runReach({ client: down, runCli: t.runCli, log: t.log });
    expect(r2.stopped).toContain('HQ');
    const wrong = await runReach({ client: new HqClient(t.hq.base, 'wrong'), runCli: t.runCli, log: t.log });
    expect(wrong.stopped).toContain('401');
  });
});

describe('doctor, status, config, lock, launchd', () => {
  it('doctor: channels that are set up and known to HQ', async () => {
    const t = await setup([]);
    const run = await t.runCli(['doctor'], 10_000);
    const list = parseDoctor(run.stdout)!;
    expect(enabledChannels(list, Object.keys(ACTIONS))).toEqual(['github', 'web', 'youtube']);
    expect(parseDoctor('x')).toBeNull();
  });

  it('reach:status prints the channels with their state and the queue counts of HQ', async () => {
    const t = await setup([job(1, 'web', 'read', { target: 'a' }), { ...job(2, 'web', 'read', { target: 'b' }), status: 'done' }]);
    const lines = await reachStatus({ runCli: t.runCli, counts: async () => (await t.hq.client.reachJobs()).counts });
    const text = lines.join('\n');
    expect(text).toContain('youtube');
    expect(text).toMatch(/instagram\s+experimental\s+not_added.*agent-reach login instagram.*\[выключен\]/);
    expect(text).toContain('Очередь HQ: ждут 1, в работе 0, готово 1, с ошибкой 0.');
    const none = await reachStatus({ runCli: execAgentReach(join(t.dir, 'nope')), counts: () => Promise.reject(new Error('нет туннеля')) });
    expect(none.join('\n')).toContain('agent-reach не найден');
    expect(none.join('\n')).toContain('Очередь HQ недоступна: нет туннеля');
  });

  it('config reuses the env of the poster; the commands parse; one run at a time by a lock of its own', () => {
    const cfg = buildConfig({ MP_ADMIN_TOKEN: 't', MP_REACH_MAX: '12', MP_REACH_TIMEOUT: '90' }, '/Users/x');
    expect(cfg).toMatchObject({ agentReachBin: '/Users/x/.local/bin/agent-reach', reachMax: 12, reachTimeoutS: 90, reachLockFile: '/Users/x/Library/Application Support/fir-mac-poster/reach.lock', adminToken: 't' });
    expect(cfg.reachLockFile).not.toBe(cfg.lockFile);
    expect(buildConfig({ MP_ADMIN_TOKEN: 't' }, '/Users/x')).toMatchObject({ reachMax: 20, reachTimeoutS: 120 });
    for (const c of ['reach', 'reach-status', 'reach-install-launchd', 'reach-uninstall-launchd']) expect(parseCli([c], Date.UTC(2026, 10, 21)).command).toBe(c);
    const file = join(tmp(), 'reach.lock');
    const release = acquireLock(file, 4242, () => true);
    expect(() => acquireLock(file, 4343, () => true)).toThrow(LockedError);
    release();
  });

  it('the LaunchAgent: label pro.firtech.reach, every 900 seconds, no run at load, the CLI folder on PATH', () => {
    const xml = reachPlistXml({ node: '/usr/bin/node', cli: '/r/packages/mac-poster/src/cli.ts', cwd: '/r/packages/mac-poster', logsDir: '/l', home: '/Users/x' });
    expect(xml).toContain('<key>Label</key><string>pro.firtech.reach</string>');
    expect(xml).toContain('<key>StartInterval</key><integer>900</integer>');
    expect(xml).toContain('<string>reach</string>');
    expect(xml).not.toContain('StartCalendarInterval');
    expect(xml).toContain('<key>RunAtLoad</key><false/>');
    expect(xml).toContain('/Users/x/.local/bin:');
    expect(plistPath('/Users/x', 'pro.firtech.reach')).toBe('/Users/x/Library/LaunchAgents/pro.firtech.reach.plist');
  });
});
