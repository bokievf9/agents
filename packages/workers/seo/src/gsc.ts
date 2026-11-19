// The Search Console call moved to `@fir/core` (`tools.google.searchConsole`, JWT on node:crypto, 2026-11-20); only the text stays here.
import type { GscReport, GscRow } from '@fir/core';

export type { GscReport, GscRow };

export function gscText(r: GscReport): string {
  const fmt = (rows: GscRow[]) => rows.slice(0, 5).map((x) => `  ${x.key}: ${x.clicks} кликов, ${x.impressions} показов, позиция ${x.position}`).join('\n') || '  данных нет';
  return `Search Console ${r.from} - ${r.to}:\nЗапросы:\n${fmt(r.queries)}\nСтраницы:\n${fmt(r.pages)}`;
}
