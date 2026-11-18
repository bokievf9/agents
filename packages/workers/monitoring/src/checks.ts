import { request } from 'node:http';
import { statfs } from 'node:fs/promises';
import { connect } from 'node:tls';

export const DAY_MS = 86_400_000;

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  /** Short facts for the alert and the journal: status code, days left, percent. No secrets. */
  detail: string;
}

export interface Container {
  name: string;
  state: string;
  status: string;
}

/** Everything the checks touch outside the process, so tests can replace it. */
export interface CheckDeps {
  fetch: typeof fetch;
  now(): number;
  /** The certificate's `valid_to` string for a host (port 443). */
  certValidTo(host: string): Promise<string>;
  statfs(path: string): Promise<{ blocks: number; bavail: number }>;
  listContainers(): Promise<Container[]>;
}

export interface MonitorConfig {
  /** Health URLs, each expected to answer 200 and "ok". */
  urls: string[];
  omnirouteUrl: string;
  llmApiKey?: string | undefined;
  dataDir: string;
  /** Read-only Docker socket check. Off by default: see the README for the security trade-off. */
  docker: boolean;
  dockerSocket: string;
  diskMaxPct: number;
  certMinDays: number;
  timeoutMs: number;
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

export interface Check {
  id: string;
  run(): Promise<CheckResult>;
}

/** The checks for a config. The Docker check exists only with `docker: true`. */
export function buildChecks(cfg: MonitorConfig, deps: CheckDeps): Check[] {
  const checks: Check[] = cfg.urls.map((u) => ({ id: `http:${u}`, run: () => checkHttp(deps, cfg, u) }));
  const hosts = [...new Set(cfg.urls.filter((u) => u.startsWith('https:')).map(hostOf))];
  for (const h of hosts) checks.push({ id: `tls:${h}`, run: () => checkTls(deps, cfg, h) });
  checks.push({ id: 'omniroute', run: () => checkOmniroute(deps, cfg) });
  checks.push({ id: 'disk', run: () => checkDisk(deps, cfg) });
  if (cfg.docker) checks.push({ id: 'docker', run: () => checkDocker(deps) });
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
  };
}
