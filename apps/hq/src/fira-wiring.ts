import { errMsg, log, schedule, type Db } from '@fir/core';
import { escalationModeOf } from '@fir/fira';
import type { Hq } from '@fir/hq';
import { ensureCabinetTables } from './cabinet.js';
import { createFiraLead, registerFiraLead, type FiraLead, type FiraLeadOptions } from './client/fira-lead.js';

/**
 * `FIRA_LEAD_MANAGER=on`: the lead manager of the web chat and the client bot answers through Fira (`client/fira-lead.ts`). Escalations go to the owner as
 * `hq.alert(kind: 'human')` (the Пульт; Telegram once `notices.ts` lets the kind through), the mode is the setting `autopilot.leadManager`
 * (`ask_me | policy | autopilot`, default `policy`), the leak guard knows the names of the cabinet's clients, the company pack is loaded again every night.
 */
export function startFiraLeadManager(o: { hq: Hq; db: Db; lessons?: FiraLeadOptions['lessons'] }): FiraLead {
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
  const fira = createFiraLead({
    now: hq.now,
    mode: () => escalationModeOf(hq.setting('autopilot.leadManager')),
    escalate: (e) => hq.alert(e.line, { kind: 'human', short: e.short }),
    clientNames,
    ...(o.lessons ? { lessons: o.lessons } : {}),
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
