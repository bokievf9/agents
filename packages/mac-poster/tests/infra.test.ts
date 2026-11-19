import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseCli } from '../src/cli.js';
import { ConfigError, buildConfig, loadEnv, parseEnvFile } from '../src/config.js';
import { classifyBlock } from '../src/guards.js';
import { plistXml } from '../src/launchd.js';
import { LockedError, acquireLock } from '../src/lock.js';
import { emptyState, leftToday, loadState, markStuck, recordAttempt, recordPost, saveState, shouldSkip } from '../src/state.js';
import { openTunnel, sshArgs } from '../src/tunnel.js';
import { canonicalPostUrl, newestNew, profileUrl, usernameFromHref } from '../src/urls.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mac-poster-test-'));

describe('state and the daily cap', () => {
  it('counts posts per day, caps at 10, one try per item per day, stuck items stay out', () => {
    const s = emptyState();
    expect(leftToday(s, '2026-11-23', 10)).toBe(10);
    for (let i = 0; i < 10; i++) recordPost(s, '2026-11-23');
    expect(leftToday(s, '2026-11-23', 10)).toBe(0);
    expect(leftToday(s, '2026-11-24', 10)).toBe(10);
    recordAttempt(s, 41, '2026-11-23');
    expect(shouldSkip(s, 41, '2026-11-23')).toBe(true);
    expect(shouldSkip(s, 41, '2026-11-24')).toBe(false);
    markStuck(s, 42, 'после «Поделиться» не увидел подтверждения');
    expect(shouldSkip(s, 42, '2026-12-30')).toBe(true);
  });

  it('saves atomically with mode 600, drops days older than 30, survives a broken file', () => {
    const dir = tmp();
    const file = join(dir, 'sub', 'state.json');
    const s = emptyState();
    recordPost(s, '2026-10-01');
    recordPost(s, '2026-11-23');
    recordAttempt(s, 7, '2026-10-01');
    s.username = 'firtech.pro';
    saveState(file, s, '2026-11-23');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const back = loadState(file);
    expect(back.posted).toEqual({ '2026-11-23': 1 });
    expect(back.attempts).toEqual({});
    expect(back.username).toBe('firtech.pro');
    writeFileSync(file, '{not json');
    expect(loadState(file)).toEqual(emptyState());
  });
});

describe('lock file', () => {
  it('a second instance is refused while the first lives; a dead pid is taken over; release removes it', () => {
    const file = join(tmp(), 'run.lock');
    const release = acquireLock(file, 1111, () => true);
    expect(readFileSync(file, 'utf8')).toBe('1111');
    expect(() => acquireLock(file, 2222, () => true)).toThrow(LockedError);
    const release2 = acquireLock(file, 3333, (pid) => pid !== 1111); // 1111 died
    expect(readFileSync(file, 'utf8')).toBe('3333');
    release(); // not ours any more: kept
    expect(existsSync(file)).toBe(true);
    release2();
    expect(existsSync(file)).toBe(false);
  });
});

describe('urls', () => {
  it('canonical post and reel links', () => {
    expect(canonicalPostUrl('/p/ABC_1-x/')).toBe('https://www.instagram.com/p/ABC_1-x/');
    expect(canonicalPostUrl('https://www.instagram.com/firtech.pro/reel/XyZ/?igsh=1')).toBe('https://www.instagram.com/reel/XyZ/');
    expect(canonicalPostUrl('/reels/Q1/')).toBe('https://www.instagram.com/reel/Q1/');
    expect(canonicalPostUrl('https://evil.com/p/ABC/')).toBeNull();
    expect(canonicalPostUrl('/explore/')).toBeNull();
    expect(profileUrl('@fir.tech')).toBe('https://www.instagram.com/fir.tech/');
  });
  it('usernames from profile links, system paths refused', () => {
    expect(usernameFromHref('/firtech.pro/')).toBe('firtech.pro');
    expect(usernameFromHref('https://www.instagram.com/fir_tech')).toBe('fir_tech');
    expect(usernameFromHref('/explore/')).toBeNull();
    expect(usernameFromHref('/p/ABC/')).toBeNull();
  });
  it('the new post is the first link not on the grid before (pinned ones stay)', () => {
    const before = ['/p/PIN1/', '/p/OLD1/', '/reel/OLD2/'];
    expect(newestNew(before, ['/p/PIN1/', '/reel/NEW/', '/p/OLD1/'])).toBe('https://www.instagram.com/reel/NEW/');
    expect(newestNew(before, before)).toBeNull();
  });
});

describe('blocks', () => {
  it('challenge, limits and the login page stop a run; a normal feed does not', () => {
    expect(classifyBlock('https://www.instagram.com/challenge/abc/', '')?.kind).toBe('challenge');
    expect(classifyBlock('https://www.instagram.com/', 'Подтвердите, что это вы')?.kind).toBe('challenge');
    expect(classifyBlock('https://www.instagram.com/', 'Suspicious Login Attempt')?.kind).toBe('challenge');
    expect(classifyBlock('https://www.instagram.com/', 'Повторите попытку позже. Мы ограничиваем частоту')?.kind).toBe('rate');
    expect(classifyBlock('https://www.instagram.com/', 'Action Blocked')?.kind).toBe('rate');
    expect(classifyBlock('https://www.instagram.com/accounts/login/?next=/', '')?.kind).toBe('login');
    expect(classifyBlock('https://www.instagram.com/', 'Телефон\nВойти', true)?.kind).toBe('login');
    expect(classifyBlock('https://www.instagram.com/', 'Главная\nПоиск\nВойти в другой аккаунт')).toBeNull();
  });
});

describe('config', () => {
  it('env file: comments, export, quotes; mode must be 600; process env wins', () => {
    expect(parseEnvFile('# x\nexport MP_ADMIN_TOKEN="abc"\nMP_LOCAL_PORT = 19000\nbad line')).toEqual({ MP_ADMIN_TOKEN: 'abc', MP_LOCAL_PORT: '19000' });
    const file = join(tmp(), '.env');
    writeFileSync(file, 'MP_ADMIN_TOKEN=fromfile\nMP_LIMIT=3\n');
    chmodSync(file, 0o644);
    expect(() => loadEnv(file, {})).toThrow(/600/);
    chmodSync(file, 0o600);
    expect(loadEnv(file, { MP_LIMIT: '4' })).toMatchObject({ MP_ADMIN_TOKEN: 'fromfile', MP_LIMIT: '4' });
  });
  it('defaults, ~ expansion, missing token message never shows a token', () => {
    const c = buildConfig({ MP_ADMIN_TOKEN: 't', MP_SSH_KEY: '~/.ssh/k' }, '/Users/x');
    expect(c).toMatchObject({ sshTarget: 'root@201.79.122.133', sshKey: '/Users/x/.ssh/k', localPort: 18787, remotePort: 8787, dailyCap: 10, perRunLimit: 6 });
    expect(c.profileDir).toBe('/Users/x/Library/Application Support/fir-mac-poster/instagram');
    expect(c.logsDir).toBe('/Users/x/Library/Logs/fir-mac-poster');
    expect(() => buildConfig({}, '/Users/x')).toThrow(ConfigError);
    expect(buildConfig({}, '/Users/x', { needToken: false }).adminToken).toBe('');
    expect(() => buildConfig({ MP_ADMIN_TOKEN: 't', MP_LOCAL_PORT: 'abc' }, '/Users/x')).toThrow(/MP_LOCAL_PORT/);
  });
});

describe('cli arguments', () => {
  const now = new Date(2026, 10, 23, 10, 0).getTime();
  it('instagram and run instagram, flags, defaults', () => {
    expect(parseCli(['instagram'], now)).toEqual({ command: 'instagram', date: '2026-11-23', dryRun: false, limit: null, headless: false, jitterMin: 0 });
    expect(parseCli(['run', 'instagram', '--dry-run', '--date', '2026-11-25', '--limit', '2', '--headless', '--jitter', '10'], now))
      .toEqual({ command: 'instagram', date: '2026-11-25', dryRun: true, limit: 2, headless: true, jitterMin: 10 });
    for (const bad of [['tiktok'], ['instagram', '--date', '2026-13-01'], ['instagram', '--limit', '0'], ['instagram', '--limit', '11'], ['instagram', '--jitter', '99']]) expect(() => parseCli(bad, now)).toThrow();
  });
});

describe('ssh tunnel', () => {
  const cfg = buildConfig({ MP_ADMIN_TOKEN: 't' }, '/Users/x');
  it('arguments: loopback forward, the key, batch mode, the target', () => {
    expect(sshArgs(cfg)).toEqual([
      '-N', '-L', '127.0.0.1:18787:127.0.0.1:8787', '-i', '/Users/x/.ssh/id_ed25519_firtech',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', 'root@201.79.122.133',
    ]);
  });
  it('reuses an open port; else starts ssh, waits, and kills it on close; a dead ssh is reported', async () => {
    let spawned = 0;
    const reused = await openTunnel(cfg, { probe: () => Promise.resolve(true), spawnSsh: () => { spawned++; return new EventEmitter() as ChildProcess; } });
    expect(reused.reused).toBe(true);
    expect(spawned).toBe(0);

    let calls = 0;
    const killed: string[] = [];
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: (sig: string) => killed.push(sig) }) as unknown as ChildProcess;
    const t = await openTunnel(cfg, { probe: () => Promise.resolve(++calls > 2), spawnSsh: () => child, sleep: () => Promise.resolve() });
    expect(t.reused).toBe(false);
    t.close();
    expect(killed).toEqual(['SIGTERM']);

    const dead = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => true }) as unknown as ChildProcess;
    const p = openTunnel(cfg, { probe: () => Promise.resolve(false), spawnSsh: () => { setTimeout(() => { (dead as unknown as EventEmitter & { stderr: EventEmitter }).stderr.emit('data', Buffer.from('Permission denied (publickey)')); dead.emit('exit', 255); }, 0); return dead; }, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    await expect(p).rejects.toThrow(/Permission denied/);
  });
});

describe('launchd', () => {
  it('the plist runs the CLI at 10, 14 and 19 with jitter, logs into the logs folder', () => {
    const x = plistXml({ node: '/opt/homebrew/bin/node', cli: '/repo/packages/mac-poster/src/cli.ts', cwd: '/repo/packages/mac-poster', logsDir: '/Users/x/Library/Logs/fir-mac-poster', home: '/Users/x' });
    expect(x).toContain('<string>pro.firtech.mac-poster</string>');
    expect(x).toContain('<string>/opt/homebrew/bin/node</string>\n    <string>--import</string>\n    <string>tsx</string>\n    <string>/repo/packages/mac-poster/src/cli.ts</string>\n    <string>instagram</string>\n    <string>--jitter</string>');
    for (const h of [10, 14, 19]) expect(x).toContain(`<key>Hour</key><integer>${h}</integer>`);
    expect(x).toContain('/Users/x/Library/Logs/fir-mac-poster/launchd.log');
    expect(x).not.toMatch(/TOKEN/);
  });
});
