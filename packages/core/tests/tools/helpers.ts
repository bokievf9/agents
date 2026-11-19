import { readFileSync } from 'node:fs';
import { createTools, HostQueue, type ToolDeps, type ToolJournal } from '../../src/index.js';

export const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** The HQ journal in memory: activity lines and settings. */
export class FakeJournal implements ToolJournal {
  readonly lines: { agentId: string | null; action: string; objectType?: string | undefined; objectId?: string | undefined; detail?: string | undefined }[] = [];
  readonly settings = new Map<string, string>();
  log(agentId: string | null, action: string, objectType?: string, objectId?: string, detail?: string): void {
    this.lines.push({ agentId, action, objectType, objectId, detail });
  }
  setting(key: string): string {
    return this.settings.get(key) ?? '';
  }
  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }
}

export type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fake network: the first route whose prefix matches answers; calls are recorded. Unknown URLs: 404. */
export function fakeNet(routes: Record<string, Route | Response | string>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const key = Object.keys(routes).filter((p) => url.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response('nf', { status: 404 });
    const r = routes[key]!;
    if (typeof r === 'string') return new Response(r, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (r instanceof Response) return r.clone();
    return r(url, init);
  };
  return { fetch, calls };
}

export const NOW = Date.UTC(2026, 10, 20, 6, 0); // Fri 2026-11-20 11:00 Dushanbe

export function tools(over: Partial<ToolDeps> = {}) {
  const journal = new FakeJournal();
  const clock = { t: NOW };
  const sleeps: number[] = [];
  const t = createTools({
    agentId: 'trend-scout', dept: 'marketing', taskId: 7, journal, now: () => clock.t, tz: 'Asia/Dushanbe',
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    queue: new HostQueue(() => clock.t, () => Promise.resolve()),
    lookup: () => Promise.resolve(['104.16.1.1']),
    ...over,
  });
  return { t, journal, clock, sleeps };
}
