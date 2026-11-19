import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, buildConfig, loadEnv, type Config } from './config.js';
import { HqClient } from './hq.js';
import { InstagramWeb, loginFlow } from './instagram/web.js';
import { installLaunchd, uninstallLaunchd } from './launchd.js';
import { LockedError, acquireLock } from './lock.js';
import { runInstagram } from './run.js';
import { loadState, saveState } from './state.js';
import { openTunnel } from './tunnel.js';
import { isDate, localDate } from './week.js';

export type Command = 'login' | 'instagram' | 'install-launchd' | 'uninstall-launchd';
export interface CliArgs {
  command: Command;
  date: string;
  dryRun: boolean;
  limit: number | null;
  headless: boolean;
  jitterMin: number;
}

const COMMANDS: Command[] = ['login', 'instagram', 'install-launchd', 'uninstall-launchd'];

/** `instagram [--date YYYY-MM-DD] [--dry-run] [--limit N] [--headless] [--jitter MIN]`; `run instagram` is accepted too. */
export function parseCli(argv: string[], now: number): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { date: { type: 'string' }, 'dry-run': { type: 'boolean' }, limit: { type: 'string' }, headless: { type: 'boolean' }, jitter: { type: 'string' } },
  });
  const pos = positionals[0] === 'run' ? positionals.slice(1) : positionals;
  const command = pos[0] as Command;
  if (!COMMANDS.includes(command)) throw new ConfigError(`команда: ${COMMANDS.join(' | ')}`);
  const date = values.date ?? localDate(now);
  if (!isDate(date)) throw new ConfigError('--date: YYYY-MM-DD');
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10)) throw new ConfigError('--limit: 1..10');
  const jitterMin = values.jitter === undefined ? 0 : Number(values.jitter);
  if (!Number.isFinite(jitterMin) || jitterMin < 0 || jitterMin > 60) throw new ConfigError('--jitter: 0..60 минут');
  return { command, date, dryRun: values['dry-run'] === true, limit, headless: values.headless === true, jitterMin };
}

function logger(c: Config, date: string): (line: string) => void {
  mkdirSync(c.logsDir, { recursive: true });
  const file = join(c.logsDir, `run-${date}.log`);
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(line);
    try {
      appendFileSync(file, `${stamped}\n`);
    } catch {
      /* the console still has it */
    }
  };
}

/** A macOS notification (best effort, no shell). */
function notify(title: string, text: string): void {
  const s = (v: string) => JSON.stringify(v.slice(0, 200));
  execFile('osascript', ['-e', `display notification ${s(text)} with title ${s(title)}`], () => undefined);
}

async function main(): Promise<number> {
  const args = parseCli(process.argv.slice(2), Date.now());
  const here = dirname(fileURLToPath(import.meta.url));
  if (args.command === 'uninstall-launchd') {
    const f = uninstallLaunchd();
    console.log(f ? `Удалил ${f}` : 'Расписания не было.');
    return 0;
  }
  const cfg = buildConfig(loadEnv(), homedir(), { needToken: args.command === 'instagram' || args.command === 'install-launchd' });
  if (args.command === 'install-launchd') {
    const f = installLaunchd({ node: process.execPath, cli: resolve(here, 'cli.ts'), cwd: resolve(here, '..'), logsDir: cfg.logsDir, home: homedir() });
    console.log(`Расписание: ${f} (10:00, 14:00, 19:00 по часам Мака). Логи: ${cfg.logsDir}. Мак должен не спать в это время.`);
    return 0;
  }
  const release = acquireLock(cfg.lockFile);
  try {
    if (args.command === 'login') {
      const user = await loginFlow({ profileDir: cfg.profileDir });
      const st = loadState(cfg.stateFile);
      if (user) st.username = user;
      saveState(cfg.stateFile, st, localDate(Date.now()));
      console.log('Дальше: pnpm --filter mac-poster ig:run --dry-run');
      return 0;
    }
    const log = logger(cfg, args.date);
    if (args.jitterMin > 0) {
      const ms = Math.round(Math.random() * args.jitterMin * 60_000);
      log(`Пауза ${Math.round(ms / 1000)} с перед стартом (jitter).`);
      await new Promise((r) => setTimeout(r, ms));
    }
    const tunnel = await openTunnel(cfg);
    log(tunnel.reused ? `Туннель на 127.0.0.1:${cfg.localPort} уже есть, использую его.` : `Туннель к HQ поднят (127.0.0.1:${cfg.localPort}).`);
    try {
      const state = loadState(cfg.stateFile);
      const client = new HqClient(`http://127.0.0.1:${cfg.localPort}`, cfg.adminToken);
      const r = await runInstagram({
        client, state, saveState: (s) => saveState(cfg.stateFile, s, args.date), date: args.date, dryRun: args.dryRun,
        limit: args.limit ?? cfg.perRunLimit, dailyCap: cfg.dailyCap, log,
        openSite: () => new InstagramWeb({ profileDir: cfg.profileDir, logsDir: cfg.logsDir, headless: args.headless, username: cfg.igUsername || state.username || '', log }),
      });
      if (!args.dryRun && (r.posted.length || r.failed.length || r.stopped)) {
        notify('Fir Tech: Instagram с Мака', r.stopped ? `Остановился: ${r.stopped}` : `Опубликовано ${r.posted.length}, ошибок ${r.failed.length}`);
      }
      return r.stopped ? 2 : r.failed.length ? 1 : 0;
    } finally {
      tunnel.close();
    }
  } finally {
    release();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      const msg = e instanceof ConfigError || e instanceof LockedError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`mac-poster: ${msg}`);
      process.exit(3);
    },
  );
}
