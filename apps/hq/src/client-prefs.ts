import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '@fir/core';

/**
 * The cabinet client's profile v2 (2026-11-23): what `POST /admin/clients/:id` accepts, how consents and the channel decide what is sent, and the
 * unsubscribe token the site and HQ share (`UNSUBSCRIBE_SECRET`, formula of `firtech/src/lib/unsubscribe.ts`).
 */

export const NOTIFY_CHANNELS = ['email', 'telegram', 'both'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** A free-text profile field: trimmed, capped, no control characters (a field sent empty clears it). */
const text = (max: number) => z.string().trim().max(max).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'control');
const url = z.string().trim().max(200).refine((v) => v === '' || /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(v), 'url');

/** The new profile fields (all optional; the first group is also accepted by the registration). */
export const profileExtras = {
  marketingConsent: z.boolean().optional(),
  recommendationsConsent: z.boolean().optional(),
  notifyChannel: z.enum(NOTIFY_CHANNELS).optional(),
  niche: text(40).optional(),
  website: url.optional(),
  city: text(80).optional(),
  legalName: text(160).optional(),
  legalAddress: text(300).optional(),
  refundWallet: text(120).optional(),
};

/** Request field -> `cab_clients` column. */
export const EXTRA_COLUMNS = {
  marketingConsent: 'marketing_consent',
  recommendationsConsent: 'recommendations_consent',
  notifyChannel: 'notify_channel',
  niche: 'niche',
  website: 'website',
  city: 'city',
  legalName: 'legal_name',
  legalAddress: 'legal_address',
  refundWallet: 'refund_wallet',
} as const;

export interface ProfileRow {
  email: string;
  name: string;
  telegram: string;
  phone?: string;
  company?: string;
  locale: string;
  marketing_consent?: number;
  recommendations_consent?: number;
  notify_channel?: string;
  niche?: string;
  website?: string;
  city?: string;
  legal_name?: string;
  legal_address?: string;
  refund_wallet?: string;
}

/** The profile as the site reads it back (`client` in the answer of `POST /admin/clients/:id`). */
export function profileView(c: ProfileRow & { id: number }) {
  return {
    id: c.id, email: c.email, name: c.name, telegram: c.telegram, phone: c.phone ?? '', company: c.company ?? '', locale: c.locale,
    marketingConsent: c.marketing_consent === 1, recommendationsConsent: c.recommendations_consent === 1,
    notifyChannel: (NOTIFY_CHANNELS as readonly string[]).includes(c.notify_channel ?? '') ? (c.notify_channel as NotifyChannel) : 'email',
    niche: c.niche ?? '', website: c.website ?? '', city: c.city ?? '', legalName: c.legal_name ?? '', legalAddress: c.legal_address ?? '', refundWallet: c.refund_wallet ?? '',
  };
}

// ---- who may be written to, and where ----

export type MailKind = 'project' | 'news' | 'recommendation';

/** News and offers need `marketingConsent`, recommendations `recommendationsConsent`; the letters about the client's own project always go. */
export function consentFor(db: Db, clientId: number, kind: MailKind): boolean {
  if (kind === 'project') return true;
  const col = kind === 'news' ? 'marketing_consent' : 'recommendations_consent';
  const r = db.prepare(`SELECT ${col} AS v FROM cab_clients WHERE id = ?`).get(clientId) as { v: number } | undefined;
  return r?.v === 1;
}

/**
 * Where a letter about the project goes: `notify_channel` says email, Telegram or both; Telegram only for a client linked to the bot (`tg_chat_id`), else the
 * letter goes by email (never silence). News and recommendations are always email: they carry the unsubscribe link.
 */
export function channelsFor(db: Db, clientId: number, kind: MailKind): { email: boolean; telegram: boolean } {
  const r = db.prepare('SELECT notify_channel AS ch, tg_chat_id AS tg FROM cab_clients WHERE id = ?').get(clientId) as { ch: string; tg: number | null } | undefined;
  if (!r) return { email: false, telegram: false };
  if (kind !== 'project') return { email: true, telegram: false };
  const linked = typeof r.tg === 'number' && r.tg !== 0;
  if (r.ch === 'telegram') return linked ? { email: false, telegram: true } : { email: true, telegram: false };
  if (r.ch === 'both') return { email: true, telegram: linked };
  return { email: true, telegram: false };
}

// ---- unsubscribe token (same formula as the site) ----

export type UnsubField = 'marketing' | 'recommendations';
const sign = (secret: string, userId: string, field: UnsubField) => createHmac('sha256', secret).update(`unsub:v1:${userId}:${field}`).digest('base64url');

export function unsubscribeToken(userId: string, field: UnsubField, secret: string): string {
  return `${Buffer.from(userId).toString('base64url')}.${field}.${sign(secret, userId, field)}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): { userId: string; field: UnsubField } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawId, field, sig] = parts as [string, string, string];
  if (field !== 'marketing' && field !== 'recommendations') return null;
  const userId = Buffer.from(rawId, 'base64url').toString('utf8');
  const want = Buffer.from(sign(secret, userId, field));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? { userId, field } : null;
}

export const MIN_SECRET = 16;
