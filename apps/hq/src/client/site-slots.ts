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

/** What the site said to a booking HQ asked for (`POST <site>/api/slots`). */
export type SiteBooking = 'booked' | 'taken' | 'not_accepted' | 'failed';
export interface SiteBookingRequest {
  /** The window (UTC ms), one of the site's free slots. */
  at: number;
  leadId: number;
  name: string;
  /** The client's email or handle, for the site's own booking record; never logged here. */
  contact: string;
  locale: 'ru' | 'en';
  /** Where the booking came from (`chat`, `bot`, `pult`). */
  source: string;
}

/**
 * P-04/P-18: books a window on the site (`POST <site>/api/slots`, header `x-hq-token`, body `{ slot: ISO, leadId, name, contact, locale, source }`), so the site's
 * `GET /api/slots` stops offering it. 200/201 `booked`, 409 `taken` (somebody was faster), 401/403/404/405/501 `not_accepted` (the site does not take a booking
 * from HQ yet, or only from a signed-in visitor), anything else `failed`. Without a token nothing is sent (`not_accepted`). Never throws; 5 s.
 */
export function siteBooker(siteUrl: string, token: string | undefined, fetcher: typeof fetch = fetch, timeoutMs = 5000): (b: SiteBookingRequest) => Promise<SiteBooking> {
  return async (b) => {
    if (!token) return 'not_accepted';
    try {
      const res = await fetcher(`${siteUrl.replace(/\/$/, '')}/api/slots`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-hq-token': token },
        body: JSON.stringify({ slot: new Date(b.at).toISOString(), leadId: b.leadId, name: b.name, contact: b.contact, locale: b.locale, source: b.source }),
      });
      if (res.status === 200 || res.status === 201) return 'booked';
      if (res.status === 409) return 'taken';
      if ([401, 403, 404, 405, 501].includes(res.status)) return 'not_accepted';
      log('warn', 'site booking failed', { status: res.status });
      return 'failed';
    } catch (e) {
      log('warn', 'site booking failed', { err: errMsg(e) });
      return 'failed';
    }
  };
}
