import { errMsg, log, schedule, type Db } from '@fir/core';
import { escalationModeOf } from '@fir/fira';
import type { Hq } from '@fir/hq';
import { ensureCabinetTables } from './cabinet.js';
import { createFiraLead, registerFiraLead, type FiraLead } from './client/fira-lead.js';
import { ownerChunks } from './shell-knowledge.js';
import { harvestLessons, SqliteLessons } from './fira-lessons.js';

/**
 * `FIRA_LEAD_MANAGER=on`: the lead manager of the web chat and the client bot answers through Fira (`client/fira-lead.ts`). Escalations go to the owner as
 * `hq.alert(kind: 'human')` (the Shell; Telegram once `notices.ts` lets the kind through), the mode is the setting `autopilot.leadManager`
 * (`ask_me | policy | autopilot`, default `policy`), the leak guard knows the names of the cabinet's clients, the company pack is loaded again every night, the owner's corrections become lessons every hour (`fira-lessons.ts`).
 */
export function startFiraLeadManager(o: { hq: Hq; db: Db }): FiraLead {
  const { hq, db } = o;
  ensureCabinetTables(db);
  let names: { at: number; list: string[] } = { at: 0, list: [] };
  const clientNames = (): string[] => {
    if (hq.now() - names.at > 10 * 60_000) {
      try {
        const rows = db.prepare("SELECT name FROM cab_clients WHERE length(name) >= 4").all() as { name: string }[];
        names = { at: hq.now(), list: rows.map((r) => r.name.trim()).filter(Boolean) };
      } catch {
        names = { at: hq.now(), list: [] };
      }
    }
    return names.list;
  };
  // the owner's corrections (review center, thread answers) become lessons: now and every hour
  const lessons = new SqliteLessons(db);
  const harvest = async (): Promise<void> => {
    try {
      const n = await harvestLessons(db, lessons, hq.now());
      if (n) log('info', 'fira lessons harvested', { added: n });
    } catch (e) {
      log('warn', 'fira lessons harvest failed', { err: errMsg(e) });
    }
  };
  void harvest();
  schedule('fira-lessons', '5 * * * *', hq.tz, harvest);
  const fira = createFiraLead({
    now: hq.now,
    mode: () => escalationModeOf(hq.setting('autopilot.leadManager')),
    escalate: (e) => hq.alert(e.line, { kind: 'human', short: e.short }),
    clientNames,
    lessons,
    extraChunks: () => ownerChunks(db, hq.now()),
  });
  registerFiraLead(fira);
  schedule('fira-knowledge', '30 3 * * *', hq.tz, async () => {
    try {
      const n = await fira.reload();
      log('info', 'fira company pack reloaded', { chunks: n });
    } catch (e) {
      log('warn', 'fira company pack reload failed', { err: errMsg(e) });
    }
  });
  log('info', 'fira lead manager on');
  return fira;
}
