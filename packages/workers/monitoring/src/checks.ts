import { request } from 'node:http';
import { stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:tls';
import type { Web } from '@fir/core';

export const DAY_MS = 86_400_000;

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  /** Short facts for the alert and the journal: status code, days left, percent. No secrets. */
  detail: string;
  /**
   * A soft check only colours the public status (a failure is `degraded`): no sample in the uptime line, no incident,
   * no alert to the owner. Used for «silence», which is often just a quiet hour.
   */
  soft?: boolean;
  /** The check could not run (no data to judge by): it is logged as skipped and counts neither as passed nor as failed. */
  skipped?: boolean;
}

export interface Container {
  name: string;
  state: string;
  status: string;
}

/** Everything the checks touch outside the process, so tests can replace it. */
export interface CheckDeps {
  fetch: typeof fetch;
  /**
   * The toolbox of the Support department (`ctx.tools.web`): when present every HTTP probe goes through `web.getText`, internal `http://`
   * hosts with the `internal: true` policy flag. Without it (a bare worker, old tests) the probes use `fetch` directly.
   */
  web?: Pick<Web, 'getText'>;
  now(): number;
  /** The certificate's `valid_to` string for a host (port 443). */
  certValidTo(host: string): Promise<string>;
  statfs(path: string): Promise<{ blocks: number; bavail: number }>;
  listContainers(): Promise<Container[]>;
  /** Epoch ms of a file's last modification (heartbeat files of the services); null when the file is missing. Optional: tests may omit it. */
  fileMtime?(path: string): Promise<number | null>;
}

export interface MonitorConfig {
  /** Health URLs, each expected to answer 200 and "ok". */
  urls: string[];
  omnirouteUrl: string;
  llmApiKey?: string | undefined;
  /** Direct Anthropic mode: the OmniRoute check is skipped (the gateway is not in the path of any call). */
  llmDirect?: boolean;
  dataDir: string;
  /** Read-only Docker socket check. Off by default: see the README for the security trade-off. */
  docker: boolean;
  dockerSocket: string;
  diskMaxPct: number;
  certMinDays: number;
  timeoutMs: number;
  /** Is the renderer service expected (REELS_RENDER on)? Then its heartbeat file / container health is checked. */
  renderer?: boolean;
  /** A heartbeat file older than this means the service is stuck or down (default 3 minutes; services touch it every 30 s). */
  heartbeatStaleMs?: number;
}

export const DEFAULT_URLS = ['https://firtech.pro/api/health'];
export const DEFAULT_OMNIROUTE_URL = 'http://omniroute:20128/healthz';

/** JSON list of http(s) URLs; empty or missing gives the default. */
export function parseMonitorUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return DEFAULT_URLS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('MONITOR_URLS must be a JSON list of URLs');
  }
  if (!Array.isArray(v) || v.some((u) => typeof u !== 'string' || !/^https?:\/\/[^\s]+$/i.test(u))) {
    throw new Error('MONITOR_URLS must be a JSON list of http(s) URLs');
  }
  return v as string[];
}

/** "https://x.com/a" -> "x.com/a": a short name for messages. */
export const shortUrl = (u: string): string => u.replace(/^https?:\/\//i, '').replace(/\/$/, '');

export function hostOf(u: string): string {
  return new URL(u).hostname;
}

/** A health answer is fine when the status is 200 and the body says ok (JSON `ok: true` / `status: "ok"`, or the word ok). */
export function isHealthy(status: number, body: string): boolean {
  if (status !== 200) return false;
  try {
    const j = JSON.parse(body) as unknown;
    if (j && typeof j === 'object') {
      const o = j as { ok?: unknown; status?: unknown };
      if (o.ok === true) return true;
      if (typeof o.status === 'string') return /^(ok|healthy|up)$/i.test(o.status);
      return false;
    }
  } catch {
    // not JSON: fall through to the plain-text check
  }
  return /\bok\b/i.test(body);
}

async function get(deps: CheckDeps, url: string, timeoutMs: number, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  if (deps.web) {
    const u = new URL(url);
    const r = await deps.web.getText(url, { hosts: [u.hostname], timeoutMs, maxBytes: 4000, ...(headers ? { headers } : {}), ...(u.protocol === 'http:' ? { internal: true } : {}) });
    if (r.ok) return { status: r.value.status, body: r.value.text.slice(0, 2000) };
    // an answer that is not 2xx (or not text) still has a status to judge by; no answer at all is an error
    if (r.status !== undefined) return { status: r.status, body: '' };
    throw new Error(r.message);
  }
  const res = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...(headers ? { headers } : {}) });
  return { status: res.status, body: (await res.text()).slice(0, 2000) };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);

export async function checkHttp(deps: CheckDeps, cfg: MonitorConfig, url: string): Promise<CheckResult> {
  const base = { id: `http:${url}`, label: shortUrl(url) };
  try {
    const r = await get(deps, url, cfg.timeoutMs);
    return { ...base, ok: isHealthy(r.status, r.body), detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ...base, ok: false, detail: errText(e) };
  }
}

/** Whole days from `now` to the certificate's end (negative: expired). Null when the date does not parse. */
export function parseCertDays(validTo: string, now: number): number | null {
  const end = Date.parse(validTo);
  if (!Number.isFinite(end)) return null;
  return Math.floor((end - now) / DAY_MS);
}

export async function checkTls(deps: CheckDeps, cfg: MonitorConfig, host: string): Promise<CheckResult> {
  const base = { id: `tls:${host}`, label: `сертификат ${host}` };
  try {
    const days = parseCertDays(await deps.certValidTo(host), deps.now());
    if (days === null) return { ...base, ok: false, detail: 'не удалось прочитать срок' };
    return { ...base, ok: days >= cfg.certMinDays, detail: days < 0 ? `истёк ${-days} дн. назад` : `осталось ${days} дн.` };
  } catch (e) {
    return { ...base, ok: false, detail: errText(e) };
  }
}

export async function checkOmniroute(deps: CheckDeps, cfg: MonitorConfig): Promise<CheckResult> {
  const base = { id: 'omniroute', label: 'OmniRoute' };
  try {
    // The key goes only to the models endpoint (it needs auth); /healthz is open (OmniRoute has no /health: 404).
    const auth = cfg.llmApiKey && /\/v1\/models\/?$/.test(cfg.omnirouteUrl) ? { authorization: `Bearer ${cfg.llmApiKey}` } : undefined;
    const r = await get(deps, cfg.omnirouteUrl, cfg.timeoutMs, auth);
    return { ...base, ok: r.status >= 200 && r.status < 300, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ...base, ok: false, detail: errText(e) };
  }
}

export async function checkDisk(deps: CheckDeps, cfg: MonitorConfig): Promise<CheckResult> {
  const base = { id: 'disk', label: 'диск данных' };
  try {
    const s = await deps.statfs(cfg.dataDir);
    if (s.blocks <= 0) return { ...base, ok: false, detail: 'нет данных о диске' };
    const used = Math.round(((s.blocks - s.bavail) / s.blocks) * 1000) / 10;
    return { ...base, ok: used <= cfg.diskMaxPct, detail: `занято ${used}%` };
  } catch (e) {
    return { ...base, ok: false, detail: errText(e) };
  }
}

/** Containers that are down: exited with an error, dead, restarting, paused or unhealthy. A clean exit (0) is fine. */
export function containerProblems(list: Container[]): string[] {
  return list
    .filter((c) => {
      if (/unhealthy/i.test(c.status)) return true;
      if (c.state === 'exited') return !/Exited \(0\)/.test(c.status);
      return ['dead', 'restarting', 'paused'].includes(c.state);
    })
    .map((c) => `${c.name} (${c.state})`);
}

export async function checkDocker(deps: CheckDeps): Promise<CheckResult> {
  const base = { id: 'docker', label: 'контейнеры' };
  try {
    const list = await deps.listContainers();
    const bad = containerProblems(list);
    return { ...base, ok: bad.length === 0, detail: bad.length ? bad.join(', ') : `работают ${list.length}` };
  } catch (e) {
    return { ...base, ok: false, detail: errText(e) };
  }
}

/** Heartbeat files the services touch in the shared data dir. */
export const HEARTBEAT_FILES = { hq: 'hq.heartbeat', renderer: 'renderer.heartbeat' } as const;
export const HEARTBEAT_STALE_MS = 180_000;

/** The compose container of a service by name (`fir-agents-hq-1`, `hq`): its health word from the Docker status, or null without a healthcheck. */
export function containerHealth(list: Container[], service: string): 'healthy' | 'unhealthy' | 'starting' | 'nohealth' | 'stopped' | 'missing' {
  const c = list.find((x) => new RegExp(`(^|[-_/])${service}([-_]\\d+)?$`).test(x.name));
  if (!c) return 'missing';
  if (c.state !== 'running') return 'stopped';
  const m = /\((healthy|unhealthy|health: starting)\)/i.exec(c.status);
  if (!m) return 'nohealth';
  return m[1]!.toLowerCase() === 'healthy' ? 'healthy' : m[1]!.toLowerCase() === 'unhealthy' ? 'unhealthy' : 'starting';
}

/**
 * `hq` and `renderer` as services. With Docker access (MONITOR_DOCKER) the state is the container's own health (the compose
 * healthchecks); without it, or when the container has no healthcheck yet, the service's heartbeat file in the shared volume:
 * fresh means alive. A service that cannot be judged (no Docker, no file API) is `skipped`, never reported as fine.
 */
export async function checkServices(deps: CheckDeps, cfg: Pick<MonitorConfig, 'dataDir' | 'docker' | 'renderer' | 'heartbeatStaleMs'>): Promise<CheckResult[]> {
  const stale = cfg.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
  const services = ['hq', ...(cfg.renderer ? ['renderer'] : [])] as ('hq' | 'renderer')[];
  let list: Container[] | null = null;
  if (cfg.docker) list = await deps.listContainers().catch(() => null);
  const out: CheckResult[] = [];
  for (const s of services) {
    const base = { id: s, label: s === 'hq' ? 'HQ' : 'рендерер' };
    const h = list ? containerHealth(list, s) : null;
    if (h === 'healthy') { out.push({ ...base, ok: true, detail: 'контейнер healthy' }); continue; }
    if (h === 'unhealthy') { out.push({ ...base, ok: false, detail: 'контейнер unhealthy' }); continue; }
    if (h === 'stopped') { out.push({ ...base, ok: false, detail: 'контейнер остановлен' }); continue; }
    if (h === 'starting') { out.push({ ...base, ok: true, detail: 'контейнер запускается' }); continue; }
    // no Docker answer, no healthcheck or the container is not listed: the heartbeat file decides
    if (!deps.fileMtime) { out.push({ ...base, ok: true, skipped: true, detail: 'нечем проверить' }); continue; }
    try {
      const at = await deps.fileMtime(join(cfg.dataDir, HEARTBEAT_FILES[s]));
      if (at === null) out.push({ ...base, ok: false, detail: 'файла сигнала нет' });
      else {
        const age = deps.now() - at;
        out.push({ ...base, ok: age <= stale, detail: age <= stale ? 'сигнал свежий' : `сигнала нет ${Math.round(age / 60_000)} мин` });
      }
    } catch (e) {
      out.push({ ...base, ok: false, detail: errText(e) });
    }
  }
  return out;
}

/** Silence of the client bot longer than this, with no polling error, makes it `degraded`. */
export const BOT_SILENCE_MS = 10 * 60_000;

/**
 * What the monitoring needs to know about the public client bot (@firtech_bot). HQ implements it on the real bot
 * (`ClientBot.probe()`); tests use fakes.
 */
export interface BotProbe {
  /** Epoch ms of the latest sign of life: a message from a person (the client bot store) or a completed getUpdates. Null: none yet. */
  lastUpdateAt(): number | null;
  /** Epoch ms when polling started; null when it has not started (the bot is not checked then). */
  startedAt(): number | null;
  /** `getMe` through the bot API; rejects when Telegram does not answer. */
  getMe(): Promise<unknown>;
  /** Why polling stopped or failed (a crashed `start()`), null while it is fine. */
  pollingError(): string | null;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))));
  });

/**
 * The client bot: `bot` fails (`down`) when polling has failed or `getMe` does not answer; `bot:silence` (soft, `degraded`)
 * when polling raised no error but nothing has been heard for 10 minutes: a hung long poll. Skipped until polling starts.
 */
export async function checkBot(deps: CheckDeps, cfg: Pick<MonitorConfig, 'timeoutMs'>, probe: BotProbe): Promise<CheckResult[]> {
  const base = { id: 'bot', label: 'Telegram-бот' };
  const started = probe.startedAt();
  const err = probe.pollingError();
  if (started === null && !err) return [{ ...base, ok: true, skipped: true, detail: 'ещё не запущен' }];
  if (err) return [{ ...base, ok: false, detail: `поллинг остановлен: ${err.slice(0, 100)}` }];
  try {
    await withTimeout(probe.getMe(), cfg.timeoutMs);
  } catch (e) {
    return [{ ...base, ok: false, detail: `getMe: ${errText(e)}` }];
  }
  const last = Math.max(probe.lastUpdateAt() ?? 0, started ?? 0);
  const quietMin = Math.floor((deps.now() - last) / 60_000);
  const silent = deps.now() - last > BOT_SILENCE_MS;
  return [
    { ...base, ok: true, detail: 'getMe ответил' },
    { id: 'bot:silence', label: 'Telegram-бот: тишина', ok: !silent, detail: silent ? `нет апдейтов ${quietMin} мин, ошибок поллинга нет` : 'апдейты идут', soft: true },
  ];
}

export interface Check {
  id: string;
  run(): Promise<CheckResult>;
  /** Checks that report several results at once (the bot). */
  runMany?(): Promise<CheckResult[]>;
}

/** The checks for a config. The Docker check exists only with `docker: true`, the bot check only with a probe. */
export function buildChecks(cfg: MonitorConfig, deps: CheckDeps, bot?: BotProbe): Check[] {
  const checks: Check[] = cfg.urls.map((u) => ({ id: `http:${u}`, run: () => checkHttp(deps, cfg, u) }));
  const hosts = [...new Set(cfg.urls.filter((u) => u.startsWith('https:')).map(hostOf))];
  for (const h of hosts) checks.push({ id: `tls:${h}`, run: () => checkTls(deps, cfg, h) });
  if (!cfg.llmDirect) checks.push({ id: 'omniroute', run: () => checkOmniroute(deps, cfg) });
  checks.push({ id: 'disk', run: () => checkDisk(deps, cfg) });
  if (cfg.docker) checks.push({ id: 'docker', run: () => checkDocker(deps) });
  checks.push({ id: 'services', run: async () => (await checkServices(deps, cfg))[0]!, runMany: () => checkServices(deps, cfg) });
  if (bot) checks.push({ id: 'bot', run: async () => (await checkBot(deps, cfg, bot))[0]!, runMany: () => checkBot(deps, cfg, bot) });
  return checks;
}

// ---- real implementations of the outside world ----
function certValidTo(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // rejectUnauthorized is off on purpose: an expired or broken certificate must still be readable to count days.
    // Nothing is sent over this connection.
    const sock = connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (cert && typeof cert.valid_to === 'string') resolve(cert.valid_to);
      else reject(new Error('no certificate'));
    });
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error('TLS timeout'));
    });
    sock.on('error', reject);
  });
}

function listContainers(socketPath: string, timeoutMs: number): Promise<Container[]> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/containers/json?all=true', method: 'GET', timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (data += c));
      res.on('end', () => {
        try {
          const arr = JSON.parse(data) as { Names?: string[]; State?: string; Status?: string }[];
          resolve(arr.map((c) => ({ name: (c.Names?.[0] ?? '?').replace(/^\//, ''), state: c.State ?? '', status: c.Status ?? '' })));
        } catch {
          reject(new Error(`Docker API HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timeout')));
    req.on('error', reject);
    req.end();
  });
}

export function realDeps(cfg: Pick<MonitorConfig, 'dockerSocket' | 'timeoutMs'>): CheckDeps {
  return {
    fetch: (...a) => fetch(...a),
    now: Date.now,
    certValidTo,
    statfs: async (p) => {
      const s = await statfs(p);
      return { blocks: Number(s.blocks), bavail: Number(s.bavail) };
    },
    listContainers: () => listContainers(cfg.dockerSocket, cfg.timeoutMs),
    fileMtime: async (p) => {
      try {
        return (await stat(p)).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}
