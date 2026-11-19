import type { Db } from '@fir/core';
import { DAY_MS, MonitorStore, type CheckState, type Incident } from '@fir/worker-monitoring';

/**
 * `GET /status`: the public view of the monitoring worker's `mon_*` tables. Only fixed service ids, states, times and
 * percentages leave the process: never a check id (they carry URLs), a detail, a port or an error body.
 */
/** Studio services only: Polly and Dono are the owner's personal agents, not studio services, and are not shown. */
export const SERVICE_IDS = ['site', 'hq', 'bot', 'omniroute', 'renderer'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];
export type ServiceState = 'up' | 'degraded' | 'down' | 'unknown';

export interface PublicStatus {
  ok: true;
  generatedAt: string;
  services: { id: ServiceId; title: string; state: ServiceState; since?: string; note?: string }[];
  incidents: { startedAt: string; endedAt?: string; service: ServiceId; title: string }[];
  uptime30d: Partial<Record<ServiceId, number>>;
}

const TITLES: Record<ServiceId, string> = { site: 'Website', hq: 'Agents HQ', bot: 'Telegram bot', omniroute: 'AI gateway', renderer: 'Video renderer' };
/** The public site's host: the monitoring checks of this host are «the site». */
const SITE_HOST = /(^|\.)firtech\.pro$/i;
/** Checks older than this and HQ is serving a page: the monitoring cycle (5 min) has stalled. */
const STALE_MS = 30 * 60_000;

type Kind = 'http' | 'tls' | 'omniroute' | 'disk' | 'docker' | 'bot' | 'botsilence' | 'hqsvc' | 'renderer';
interface Mapped { service: ServiceId; kind: Kind }

/** Which public service a monitoring check stands for (null: a check that is not part of the public picture). */
export function mapCheck(checkId: string): Mapped | null {
  if (checkId === 'omniroute') return { service: 'omniroute', kind: 'omniroute' };
  if (checkId === 'disk') return { service: 'hq', kind: 'disk' };
  if (checkId === 'docker') return { service: 'hq', kind: 'docker' };
  // The compose healthchecks (or the heartbeat files) of the two long-running services.
  if (checkId === 'hq') return { service: 'hq', kind: 'hqsvc' };
  if (checkId === 'renderer') return { service: 'renderer', kind: 'renderer' };
  // The client bot (@firtech_bot): `bot` is getMe and polling, `bot:silence` is a hung poll with no error (soft, degraded only).
  if (checkId === 'bot') return { service: 'bot', kind: 'bot' };
  if (checkId === 'bot:silence') return { service: 'bot', kind: 'botsilence' };
  const host = (raw: string): string | null => {
    try {
      return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    } catch {
      return null;
    }
  };
  if (checkId.startsWith('http:')) {
    const h = host(checkId.slice(5));
    return h && SITE_HOST.test(h) ? { service: 'site', kind: 'http' } : null;
  }
  if (checkId.startsWith('tls:')) {
    const h = checkId.slice(4);
    return SITE_HOST.test(h) ? { service: 'site', kind: 'tls' } : null;
  }
  return null;
}

/** When a check fails: a dead health endpoint is `down`, a soon-expiring certificate or a full disk is `degraded`. */
const DOWN_AS: Record<Kind, ServiceState> = { http: 'down', omniroute: 'down', tls: 'degraded', disk: 'degraded', docker: 'degraded', bot: 'down', botsilence: 'degraded', hqsvc: 'down', renderer: 'degraded' };
const NOTE: Record<Kind, string> = {
  http: 'The health check is failing', omniroute: 'The health check is failing', tls: 'The certificate expires soon', disk: 'Disk space is running low', docker: 'A container is unhealthy',
  bot: 'The bot is not receiving updates', botsilence: 'The bot has been silent for a while',
  hqsvc: 'The service is not responding', renderer: 'Video rendering is not running',
};
const INCIDENT: Record<Kind, string> = {
  http: 'health check failed', omniroute: 'health check failed', tls: 'certificate problem', disk: 'low disk space', docker: 'container problem',
  bot: 'bot not responding', botsilence: 'bot silent', hqsvc: 'service not responding', renderer: 'renderer not running',
};
const RANK: Record<ServiceState, number> = { up: 0, unknown: 0, degraded: 1, down: 2 };
const iso = (ms: number): string => new Date(ms).toISOString();

export interface StatusInput {
  states: (CheckState & { checkId: string })[];
  perCheck: { checkId: string; pct: number }[];
  incidents: Incident[];
  lastSampleAt: number | null;
}

/** Pure aggregation, tested on seeded rows. */
export function aggregate(inp: StatusInput, now: number): PublicStatus {
  const services: PublicStatus['services'] = [];
  const uptime: PublicStatus['uptime30d'] = {};
  for (const id of SERVICE_IDS) {
    const mine = inp.states.map((s) => ({ s, m: mapCheck(s.checkId) })).filter((x): x is { s: CheckState & { checkId: string }; m: Mapped } => x.m?.service === id);
    // the renderer appears only when it is expected (it has a check): an install without reels shows four services as before
    if (id === 'renderer' && !mine.length) continue;
    let state: ServiceState = 'unknown';
    let since: number | undefined;
    let note: string | undefined;
    if (mine.length) {
      state = 'up';
      for (const { s, m } of mine) {
        const st: ServiceState = s.status === 'down' ? DOWN_AS[m.kind] : s.fails > 0 ? 'degraded' : 'up';
        if (RANK[st] > RANK[state]) {
          state = st;
          note = s.status === 'down' ? NOTE[m.kind] : 'Some checks fail intermittently';
          since = s.failSince || undefined;
        }
      }
    }
    if (id === 'hq') {
      // The monitoring worker runs inside HQ and this answer comes from HQ: serving it is the proof of life; stalled checks degrade it.
      if (!mine.length) state = 'up';
      if (state === 'up' && inp.lastSampleAt !== null && now - inp.lastSampleAt > STALE_MS) {
        state = 'degraded';
        note = 'Health checks are not running';
      }
    }
    services.push({ id, title: TITLES[id], state, ...(state !== 'up' && state !== 'unknown' && since ? { since: iso(since) } : {}), ...(note && state !== 'up' && state !== 'unknown' ? { note } : {}) });
    const pcts = inp.perCheck.filter((p) => { const m = mapCheck(p.checkId); return m?.service === id && m.kind !== 'tls' && m.kind !== 'botsilence'; }).map((p) => p.pct);
    if (pcts.length) uptime[id] = Math.min(...pcts);
  }
  const incidents = inp.incidents
    .map((i) => ({ i, m: mapCheck(i.checkId) }))
    .filter((x): x is { i: Incident; m: Mapped } => x.m !== null && x.i.startedAt >= now - 30 * DAY_MS)
    .sort((a, b) => b.i.startedAt - a.i.startedAt)
    .slice(0, 20)
    .map(({ i, m }) => ({ startedAt: iso(i.startedAt), ...(i.endedAt !== null ? { endedAt: iso(i.endedAt) } : {}), service: m.service, title: `${TITLES[m.service]}: ${INCIDENT[m.kind]}` }));
  return { ok: true, generatedAt: iso(now), services, incidents, uptime30d: uptime };
}

export function buildStatus(db: Db, now: number): PublicStatus {
  const store = new MonitorStore(db);
  return aggregate(
    { states: store.allStates(), perCheck: store.uptime(now - 30 * DAY_MS).perCheck, incidents: store.incidents(now - 30 * DAY_MS), lastSampleAt: store.lastSampleAt() },
    now,
  );
}

/** Cached for 60 s (the monitoring cycle is 5 min). */
export function cachedStatus(db: Db, ttlMs = 60_000, clock: () => number = Date.now): () => PublicStatus {
  let at = 0;
  let value: PublicStatus | null = null;
  return () => {
    const t = clock();
    if (!value || t - at >= ttlMs) {
      value = buildStatus(db, t);
      at = t;
    }
    return value;
  };
}
