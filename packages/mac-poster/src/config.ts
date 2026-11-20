import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything the helper needs, from `~/.fir-mac-poster.env` (mode 600) and the process environment (it wins). */
export interface Config {
  /** `user@host` of the HQ server for the SSH tunnel. */
  sshTarget: string;
  sshKey: string;
  /** Local end of the tunnel; HQ answers on `http://127.0.0.1:<localPort>/admin/*`. */
  localPort: number;
  /** HQ's port on the server's loopback. */
  remotePort: number;
  /** `x-admin-token` (never printed). */
  adminToken: string;
  /** Instagram username of the account (optional: read from the profile link after `login`). */
  igUsername: string;
  dailyCap: number;
  perRunLimit: number;
  /** `~/Library/Application Support/fir-mac-poster` */
  appDir: string;
  /** Persistent Chromium profile for instagram.com. */
  profileDir: string;
  stateFile: string;
  lockFile: string;
  /** `~/Library/Logs/fir-mac-poster`: run logs and failure screenshots. */
  logsDir: string;
  /** Agent Reach (`reach:*` commands): the CLI, one run at a time (own lock), jobs per run, hard limit per job. */
  agentReachBin: string;
  reachLockFile: string;
  reachMax: number;
  reachTimeoutS: number;
}

export const ENV_FILE = join(homedir(), '.fir-mac-poster.env');

/** `KEY=VALUE` lines; `#` comments, `export ` prefix and surrounding quotes are allowed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

export class ConfigError extends Error {}

/** Reads the env file (refuses one other users can read) and merges the process environment over it. */
export function loadEnv(file = ENV_FILE, env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  let fromFile: Record<string, string> = {};
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) throw new ConfigError(`${file}: права ${mode.toString(8)}, нужно 600 (chmod 600 ${file})`);
    fromFile = parseEnvFile(readFileSync(file, 'utf8'));
  }
  return { ...fromFile, ...env };
}

const int = (v: string | undefined, def: number, name: string): number => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name}: нужно целое число > 0`);
  return n;
};

export function buildConfig(env: Record<string, string | undefined>, home = homedir(), opts: { needToken?: boolean } = {}): Config {
  const adminToken = env.MP_ADMIN_TOKEN ?? '';
  if (opts.needToken !== false && !adminToken) throw new ConfigError(`MP_ADMIN_TOKEN не задан: положите его в ${ENV_FILE} (chmod 600)`);
  const appDir = join(home, 'Library', 'Application Support', 'fir-mac-poster');
  const expand = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
  return {
    sshTarget: env.MP_SSH_TARGET || 'root@201.79.122.133',
    sshKey: expand(env.MP_SSH_KEY || '~/.ssh/id_ed25519_firtech'),
    localPort: int(env.MP_LOCAL_PORT, 18787, 'MP_LOCAL_PORT'),
    remotePort: int(env.MP_REMOTE_PORT, 8787, 'MP_REMOTE_PORT'),
    adminToken,
    igUsername: (env.MP_IG_USERNAME ?? '').replace(/^@/, ''),
    dailyCap: int(env.MP_DAILY_CAP, 10, 'MP_DAILY_CAP'),
    perRunLimit: int(env.MP_LIMIT, 6, 'MP_LIMIT'),
    appDir,
    profileDir: join(appDir, 'instagram'),
    stateFile: join(appDir, 'state.json'),
    lockFile: join(appDir, 'run.lock'),
    logsDir: join(home, 'Library', 'Logs', 'fir-mac-poster'),
    // launchd has a short PATH: the uv install puts the CLI in ~/.local/bin
    agentReachBin: expand(env.MP_AGENT_REACH || '~/.local/bin/agent-reach'),
    reachLockFile: join(appDir, 'reach.lock'),
    reachMax: int(env.MP_REACH_MAX, 20, 'MP_REACH_MAX'),
    reachTimeoutS: int(env.MP_REACH_TIMEOUT, 120, 'MP_REACH_TIMEOUT'),
  };
}
