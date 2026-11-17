import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Lead } from './store.js';

/** Lead cards as JSON lines (one line per lead, latest state). data/ is not in git: this file holds contacts. */
export function exportLeads(file: string, leads: Lead[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = leads.map((l) =>
    JSON.stringify({
      id: l.id,
      source: l.source,
      createdAt: new Date(l.createdAt).toISOString(),
      name: l.name,
      contact: l.contact,
      niche: l.niche,
      task: l.task,
      deadline: l.deadline,
      budget: l.budget,
      temperature: l.temperature,
      lang: l.lang,
      callSlot: l.chosenSlot ? new Date(l.chosenSlot).toISOString() : null,
      priceApproved: l.priceApproved,
    }),
  );
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
}
