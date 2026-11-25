import { errMsg, log, migrate, zonedParts, zonedToMs, type Db } from '@fir/core';
import type { Hq } from '@fir/hq';
import { addThreadMessage } from './cabinet.js';

/**
 * The client's weekly report and the downtime alert (owner 2026-11-25, AI-native wave, brief H1). No model call: numbers only, from the stores of the client's
 * live agents (`pg_*`).
 * - Weekly: Monday at `report.weekly.hour` (default 9) on the owner's clock, once per client per week (`client_reports`, restart-safe), for every client with a live
 *   agent. Goes to the client's `support` cabinet thread, to his Telegram when a chat id is known (a lead of his came through the client bot) and one line per client
 *   to the owner's group. `report.weekly.enabled` (default on) turns it off.
 * - Downtime: every tick looks for a visitor's message (widget or Telegram) in work hours that got no agent reply for more than `alerts.downtimeMinutes` (default 30);
 *   one alert per client per hour (`client_alerts`), to the owner (inbox and Telegram reminder), the group and the activity journal of the Shell.
 * Texts of visitors never leave the database: alerts and the group line carry counts, the agent's name and minutes only.
 */
export const REPORT_ENABLED_KEY = 'report.weekly.enabled';
export const REPORT_HOUR_KEY = 'report.weekly.hour';
export const DOWNTIME_KEY = 'alerts.downtimeMinutes';
export const DEFAULT_REPORT_HOUR = 9;
export const DEFAULT_DOWNTIME_MINUTES = 30;
/** Work hours (hours of `hq.tz`, from inclusive to exclusive) in which a silent agent counts as down. */
export const WORK_HOURS: [number, number] = [9, 21];
const MIN = 60_000;
const DAY = 86_400_000;
const FAST_MS = MIN;
/** Visitor channels of an agent (the cabinet test chat and the demo are not clients' customers). */
const REAL_CHANNELS = "('widget', 'telegram')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_reports (
  client_id INTEGER NOT NULL,
  week TEXT NOT NULL,
  at INTEGER NOT NULL,
  stats TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (client_id, week)
);
CREATE TABLE IF NOT EXISTS client_alerts (
  client_id INTEGER NOT NULL,
  hour_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (client_id, hour_key)
);
`;

export interface ReportSettings { weeklyEnabled: boolean; weeklyHour: number; downtimeMinutes: number }

/** The values in force: the stored settings, else the defaults (a bad value falls back). */
export function reportSettings(hq: Pick<Hq, 'setting'>): ReportSettings {
  const hour = hq.setting(REPORT_HOUR_KEY);
  const mins = hq.setting(DOWNTIME_KEY);
  const h = hour === '' ? NaN : Number(hour);
  const m = mins === '' ? NaN : Number(mins);
  return {
    weeklyEnabled: hq.setting(REPORT_ENABLED_KEY) !== '0',
    weeklyHour: Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_REPORT_HOUR,
    downtimeMinutes: Number.isInteger(m) && m >= 5 && m <= 1440 ? m : DEFAULT_DOWNTIME_MINUTES,
  };
}

export interface WeekStats { received: number; answeredFast: number; handedOver: number; leads: number; bookings: number; from: string; to: string }

const dayKey = (ms: number, tz: string): string => {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

/** Plain Russian text of the report: numbers only. */
export function renderReport(s: WeekStats, agents: string[]): string {
  const share = s.received ? Math.round((s.answeredFast / s.received) * 100) : 0;
  return [
    `Отчёт за неделю ${s.from} — ${s.to}${agents.length ? `, агент ${agents.map((n) => `«${n}»`).join(', ')}` : ''}.`,
    `Обращений: ${s.received}.`,
    `Ответ за минуту: ${s.answeredFast}${s.received ? ` (${share} %)` : ''}.`,
    `Передано человеку: ${s.handedOver}.`,
    `Заявок: ${s.leads}.`,
    `Записей: ${s.bookings}.`,
  ].join('\n');
}

export interface ClientReportsDeps {
  hq: Hq;
  /** One line to the owner's group (topic); resolves false when there is no group. */
  postGroup?: ((text: string) => Promise<boolean>) | undefined;
  /** The client's Telegram through the client bot. */
  sendTelegram?: ((chatId: number, text: string) => Promise<unknown>) | undefined;
}

interface AgentRef { id: number; name: string }

export class ClientReports {
  constructor(private readonly d: ClientReportsDeps) {
    migrate(d.hq.db, SCHEMA);
  }

  private get db(): Db { return this.d.hq.db; }
  private get now(): number { return this.d.hq.now(); }

  /** Clients with at least one live agent. */
  activeClients(): number[] {
    return (this.db.prepare("SELECT DISTINCT client_id FROM pg_agents WHERE state = 'live' AND client_id > 0 ORDER BY client_id").all() as { client_id: number }[]).map((r) => r.client_id);
  }

  private agentsOf(clientId: number): AgentRef[] {
    return this.db.prepare("SELECT id, name FROM pg_agents WHERE client_id = ? AND state = 'live' ORDER BY id").all(clientId) as AgentRef[];
  }

  /** The last 7 calendar days (today included) of the company's clock: counts for the live agents of the client. */
  weekStats(clientId: number, at = this.now): WeekStats {
    const tz = this.d.hq.tz;
    const start = at - 6 * DAY;
    const p = zonedParts(start, tz);
    const startMs = zonedToMs(p.y, p.mo, p.d, 0, 0, tz);
    const ids = this.agentsOf(clientId).map((a) => a.id);
    const out: WeekStats = { received: 0, answeredFast: 0, handedOver: 0, leads: 0, bookings: 0, from: dayKey(startMs, tz), to: dayKey(at, tz) };
    if (!ids.length) return out;
    const mark = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT u.at AS at, (SELECT MIN(a.at) FROM pg_messages a WHERE a.agent_id = u.agent_id AND a.conv_id = u.conv_id AND a.role = 'assistant' AND a.id > u.id) AS replied
       FROM pg_messages u JOIN pg_conversations c ON c.agent_id = u.agent_id AND c.id = u.conv_id
       WHERE u.role = 'user' AND u.agent_id IN (${mark}) AND u.at >= ? AND u.at <= ? AND c.channel IN ${REAL_CHANNELS}`,
    ).all(...ids, startMs, at) as { at: number; replied: number | null }[];
    out.received = rows.length;
    out.answeredFast = rows.filter((r) => r.replied !== null && r.replied - r.at <= FAST_MS).length;
    out.handedOver = (this.db.prepare(`SELECT COALESCE(SUM(n), 0) n FROM pg_journal WHERE kind = 'handoff' AND day >= ? AND day <= ? AND agent_id IN (${mark})`).get(dayKey(startMs, tz), out.to, ...ids) as { n: number }).n;
    out.leads = (this.db.prepare(`SELECT COUNT(*) n FROM pg_leads WHERE agent_id IN (${mark}) AND at >= ? AND at <= ?`).get(...ids, startMs, at) as { n: number }).n;
    out.bookings = (this.db.prepare(`SELECT COUNT(*) n FROM pg_bookings WHERE agent_id IN (${mark}) AND at >= ? AND at <= ?`).get(...ids, startMs, at) as { n: number }).n;
    return out;
  }

  /** The client's Telegram chat id: the client bot's chat of his latest lead, when there is one. */
  private chatIdOf(clientId: number): number | null {
    const leads = this.db.prepare('SELECT task_id FROM li_leads WHERE client_id = ? ORDER BY id DESC LIMIT 5').all(clientId) as { task_id: number }[];
    for (const l of leads) {
      const meta = (this.d.hq.task(l.task_id)?.meta.lead ?? {}) as { chatId?: unknown };
      if (typeof meta.chatId === 'number') return meta.chatId;
    }
    return null;
  }

  private clientName(clientId: number): string {
    const c = this.db.prepare('SELECT name, email FROM cab_clients WHERE id = ?').get(clientId) as { name: string; email: string } | undefined;
    return c?.name || c?.email.split('@')[0] || `клиент #${clientId}`;
  }

  /** Monday key of the owner's clock (`YYYY-MM-DD`) of the week `at` falls in. */
  private weekKey(at: number): string {
    const tz = this.d.hq.ownerTz;
    const p = zonedParts(at, tz);
    return dayKey(at - ((p.dow + 6) % 7) * DAY, tz);
  }

  /** Is it Monday at or after the report hour on the owner's clock? */
  due(at = this.now): boolean {
    const s = reportSettings(this.d.hq);
    if (!s.weeklyEnabled) return false;
    const p = zonedParts(at, this.d.hq.ownerTz);
    return p.dow === 1 && p.h >= s.weeklyHour;
  }

  /** Sends this week's report to every active client that has not got it yet. Returns the number of reports made. */
  async weeklyTick(): Promise<number> {
    if (!this.due()) return 0;
    const week = this.weekKey(this.now);
    let n = 0;
    const lines: string[] = [];
    for (const clientId of this.activeClients()) {
      const have = this.db.prepare('SELECT 1 FROM client_reports WHERE client_id = ? AND week = ?').get(clientId, week);
      if (have) continue;
      try {
        const stats = this.weekStats(clientId);
        const text = renderReport(stats, this.agentsOf(clientId).map((a) => a.name));
        // the mark first: a retry or a restart never doubles the report
        this.db.prepare('INSERT INTO client_reports (client_id, week, at, stats, text) VALUES (?, ?, ?, ?, ?)').run(clientId, week, this.now, JSON.stringify(stats), text);
        addThreadMessage(this.db, this.now, { clientId, thread: 'support', from: 'manager', text });
        const chat = this.chatIdOf(clientId);
        if (chat !== null && this.d.sendTelegram) await this.d.sendTelegram(chat, text).catch((e) => log('warn', 'weekly report to telegram failed', { client: clientId, err: errMsg(e) }));
        this.d.hq.log('hq', 'client_weekly_report', 'client', String(clientId), `${stats.received}/${stats.answeredFast}/${stats.handedOver}/${stats.leads}`);
        lines.push(`${this.clientName(clientId)}: обращений ${stats.received}, за минуту ${stats.answeredFast}, человеку ${stats.handedOver}, заявок ${stats.leads}, записей ${stats.bookings}`);
        n++;
      } catch (e) {
        log('warn', 'weekly report failed', { client: clientId, err: errMsg(e) });
      }
    }
    if (lines.length && this.d.postGroup) await this.d.postGroup(`Недельные отчёты клиентам:\n${lines.join('\n')}`).catch((e) => log('warn', 'weekly report group line failed', { err: errMsg(e) }));
    return n;
  }

  /** Visitor messages without an agent reply for longer than the threshold, in work hours, not older than a day: per client the oldest one. */
  silent(at = this.now): { clientId: number; agentId: number; agentName: string; minutes: number }[] {
    const limit = reportSettings(this.d.hq).downtimeMinutes;
    const rows = this.db.prepare(
      `SELECT a.client_id AS clientId, a.id AS agentId, a.name AS agentName, u.at AS at
       FROM pg_messages u JOIN pg_agents a ON a.id = u.agent_id JOIN pg_conversations c ON c.agent_id = u.agent_id AND c.id = u.conv_id
       WHERE u.role = 'user' AND a.state = 'live' AND a.client_id > 0 AND c.channel IN ${REAL_CHANNELS} AND u.at <= ? AND u.at >= ?
         AND NOT EXISTS (SELECT 1 FROM pg_messages r WHERE r.agent_id = u.agent_id AND r.conv_id = u.conv_id AND r.role = 'assistant' AND r.id > u.id)
       ORDER BY u.at`,
    ).all(at - limit * MIN, at - DAY) as { clientId: number; agentId: number; agentName: string; at: number }[];
    const out = new Map<number, { clientId: number; agentId: number; agentName: string; minutes: number }>();
    for (const r of rows) {
      const h = zonedParts(r.at, this.d.hq.tz).h;
      if (h < WORK_HOURS[0] || h >= WORK_HOURS[1]) continue;
      if (!out.has(r.clientId)) out.set(r.clientId, { clientId: r.clientId, agentId: r.agentId, agentName: r.agentName, minutes: Math.floor((at - r.at) / MIN) });
    }
    return [...out.values()];
  }

  /** One alert per client per hour. Returns how many alerts went out. */
  async downtimeTick(): Promise<number> {
    let n = 0;
    const hourKey = `${Math.floor(this.now / (DAY / 24))}`;
    for (const s of this.silent()) {
      const first = this.db.prepare('INSERT OR IGNORE INTO client_alerts (client_id, hour_key, at, agent_id, minutes) VALUES (?, ?, ?, ?, ?)').run(s.clientId, hourKey, this.now, s.agentId, s.minutes).changes > 0;
      if (!first) continue;
      const who = this.clientName(s.clientId);
      const text = `Агент «${s.agentName}» клиента ${who} не отвечает ${s.minutes} мин: сообщение посетителя без ответа в рабочее время.`;
      this.d.hq.log('hq', 'client_downtime', 'client', String(s.clientId), `agent ${s.agentId}, ${s.minutes} min`);
      await this.d.hq.alert(text, { kind: 'service', short: text });
      if (this.d.postGroup) await this.d.postGroup(text).catch((e) => log('warn', 'downtime group line failed', { err: errMsg(e) }));
      n++;
    }
    return n;
  }
}

const has = (db: Db, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;

/** The last weekly report of a client for the Shell (client 360), or null. */
export function lastWeeklyReport(db: Db, clientId: number): { week: string; at: string; stats: WeekStats; text: string } | null {
  if (!has(db, 'client_reports')) return null;
  const r = db.prepare('SELECT week, at, stats, text FROM client_reports WHERE client_id = ? ORDER BY at DESC LIMIT 1').get(clientId) as { week: string; at: number; stats: string; text: string } | undefined;
  return r ? { week: r.week, at: new Date(r.at).toISOString(), stats: JSON.parse(r.stats) as WeekStats, text: r.text } : null;
}

/** The last downtime alerts of a client (newest first) for the Shell journal. */
export function recentDowntime(db: Db, clientId: number, limit = 5): { at: string; agentId: number; minutes: number }[] {
  if (!has(db, 'client_alerts')) return [];
  return (db.prepare('SELECT at, agent_id, minutes FROM client_alerts WHERE client_id = ? ORDER BY at DESC LIMIT ?').all(clientId, limit) as { at: number; agent_id: number; minutes: number }[])
    .map((r) => ({ at: new Date(r.at).toISOString(), agentId: r.agent_id, minutes: r.minutes }));
}
