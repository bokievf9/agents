import { errMsg, log } from '@fir/core';

/**
 * The free call slots of the site (`GET <site>/api/slots` → `{ timeZone, days: [{ date, slots: [UTC ISO] }] }`, Mon-Fri, booked ones already removed): what the
 * receptionist offers for a call. Fail-soft by design: a slow or unreachable site is an empty list and the receptionist says «предложу время». One request a minute at most.
 */
export function siteSlots(siteUrl: string, fetcher: typeof fetch = fetch, now: () => number = Date.now, timeoutMs = 3000): () => Promise<number[]> {
  let cache: { at: number; slots: number[] } | null = null;
  return async () => {
    if (cache && now() - cache.at < 60_000) return cache.slots;
    try {
      const res = await fetcher(`${siteUrl.replace(/\/$/, '')}/api/slots`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { days?: { slots?: unknown }[] };
      const slots = (body.days ?? [])
        .flatMap((d) => (Array.isArray(d.slots) ? d.slots : []))
        .map((s) => Date.parse(String(s)))
        .filter((t) => Number.isFinite(t) && t > now())
        .sort((a, b) => a - b)
        .slice(0, 6);
      cache = { at: now(), slots };
      return slots;
    } catch (e) {
      log('warn', 'site slots unavailable', { err: errMsg(e) });
      cache = { at: now(), slots: [] };
      return [];
    }
  };
}
