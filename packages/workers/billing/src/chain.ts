import type { ChainMethod } from './store.js';

/**
 * Reading incoming USDT transfers from the two public indexers (2026-11-19). Everything here is pure: the HTTP call is injected
 * (`ChainGet`), so tests never touch the network. A transfer is accepted only when every field checks out; anything odd is dropped,
 * never "probably fine": money is marked paid from these rows.
 */

/** USDT on TRON (TRC20) contract. */
export const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
/** USDT jetton master on TON (user-friendly form; compared in raw form). */
export const USDT_TON_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
export const TRONGRID_HOST = 'api.trongrid.io';
export const TONCENTER_HOST = 'toncenter.com';
export const CHAIN_HOSTS = [TRONGRID_HOST, TONCENTER_HOST] as const;
export const PAGE_LIMIT = 50;

export interface ChainTransfer {
  method: ChainMethod;
  txId: string;
  /** Integer amount in USDT micro-units (6 decimals). */
  amountMicro: bigint;
  /** Block time, ms. */
  txTime: number;
}

/** The injected GET: status and parsed JSON (null body on non-2xx), or a transport failure. */
export type ChainGet = (url: string, headers: Record<string, string>) => Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; error: string }>;

export type FetchOutcome = { ok: true; transfers: ChainTransfer[] } | { ok: false; retryable: boolean; reason: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const MICRO = /^\d{1,30}$/;

// ---- TON addresses without @ton/core: user-friendly (base64/base64url, 36 bytes with CRC16) or raw `wc:hex` -> raw lowercase ----
function crc16xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * A TON address in the canonical raw form `wc:hex64` (lowercase), or null when it is not a valid address. User-friendly forms
 * (bounceable `EQ…`, non-bounceable `UQ…`, test-only flags, base64 or base64url) must carry a correct CRC16, so a typo never matches.
 */
export function tonRaw(addr: string): string | null {
  const a = addr.trim();
  const raw = /^(-?\d{1,3}):([0-9a-fA-F]{64})$/.exec(a);
  if (raw) return `${Number(raw[1])}:${raw[2]!.toLowerCase()}`;
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(a)) return null;
  const bytes = Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 36) return null;
  if (crc16xmodem(bytes.subarray(0, 34)) !== bytes.readUInt16BE(34)) return null;
  const tag = bytes[0]! & ~0x80; // 0x80 = test-only flag
  if (tag !== 0x11 && tag !== 0x51) return null; // bounceable, non-bounceable
  const wc = bytes.readInt8(1);
  return `${wc}:${bytes.subarray(2, 34).toString('hex')}`;
}

/** The user-friendly form (base64url, bounceable `EQ…` or non-bounceable `UQ…`) of a raw `wc:hex64` address; null when it is not one. */
export function tonFriendly(raw: string, bounceable = true): string | null {
  const m = /^(-?\d{1,3}):([0-9a-fA-F]{64})$/.exec(raw.trim());
  if (!m) return null;
  const b = Buffer.alloc(36);
  b[0] = bounceable ? 0x11 : 0x51;
  b.writeInt8(Number(m[1]), 1);
  Buffer.from(m[2]!, 'hex').copy(b, 2);
  b.writeUInt16BE(crc16xmodem(b.subarray(0, 34)), 34);
  return b.toString('base64url');
}

/** Same TON account, whatever form each side is written in. */
export function sameTonAddress(a: string, b: string): boolean {
  const x = tonRaw(a);
  return x !== null && x === tonRaw(b);
}

// ---- TRC20 (TronGrid) ----
export function trc20Url(address: string, sinceMs: number): string {
  const q = new URLSearchParams({
    only_to: 'true', only_confirmed: 'true', limit: String(PAGE_LIMIT), contract_address: USDT_TRC20_CONTRACT, min_timestamp: String(Math.max(0, Math.floor(sinceMs))),
  });
  return `https://${TRONGRID_HOST}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${q.toString()}`;
}

/** Valid incoming USDT transfers to `address` from a TronGrid answer; null when the answer itself is not the expected shape. */
export function parseTrc20(body: unknown, address: string): ChainTransfer[] | null {
  if (!isObj(body) || body.success === false || !Array.isArray(body.data)) return null;
  const out: ChainTransfer[] = [];
  for (const t of body.data) {
    if (!isObj(t) || !isObj(t.token_info)) continue;
    const ti = t.token_info;
    if (ti.address !== USDT_TRC20_CONTRACT) continue;
    if (ti.decimals !== undefined && Number(ti.decimals) !== 6) continue;
    if (t.to !== address) continue;
    if (t.type !== undefined && t.type !== 'Transfer' && t.type !== 'TransferFrom') continue;
    if (typeof t.transaction_id !== 'string' || !/^[0-9a-fA-F]{64}$/.test(t.transaction_id)) continue;
    if (typeof t.value !== 'string' || !MICRO.test(t.value)) continue;
    if (typeof t.block_timestamp !== 'number' || !Number.isFinite(t.block_timestamp)) continue;
    out.push({ method: 'usdt_trc20', txId: t.transaction_id.toLowerCase(), amountMicro: BigInt(t.value), txTime: t.block_timestamp });
  }
  return out;
}

// ---- TON (toncenter v3) ----
export function tonUrl(address: string, sinceMs: number): string {
  const q = new URLSearchParams({
    owner_address: address, jetton_address: USDT_TON_MASTER, direction: 'in', limit: String(PAGE_LIMIT), start_utime: String(Math.max(0, Math.floor(sinceMs / 1000))), sort: 'desc',
  });
  return `https://${TONCENTER_HOST}/api/v3/jetton/transfers?${q.toString()}`;
}

/**
 * Valid incoming USDT transfers to `address` from a toncenter v3 answer. The jetton master and the destination owner are compared as
 * raw addresses (user-friendly forms are decoded with their CRC checked), aborted transactions are dropped.
 */
export function parseTon(body: unknown, address: string): ChainTransfer[] | null {
  if (!isObj(body) || !Array.isArray(body.jetton_transfers)) return null;
  const out: ChainTransfer[] = [];
  for (const t of body.jetton_transfers) {
    if (!isObj(t)) continue;
    if (typeof t.jetton_master !== 'string' || !sameTonAddress(t.jetton_master, USDT_TON_MASTER)) continue;
    if (typeof t.destination !== 'string' || !sameTonAddress(t.destination, address)) continue;
    if (t.transaction_aborted !== false) continue;
    if (typeof t.transaction_hash !== 'string' || !/^[A-Za-z0-9+/=_-]{20,100}$/.test(t.transaction_hash)) continue;
    if (typeof t.amount !== 'string' || !MICRO.test(t.amount)) continue;
    if (typeof t.transaction_now !== 'number' || !Number.isFinite(t.transaction_now)) continue;
    out.push({ method: 'usdt_ton', txId: t.transaction_hash, amountMicro: BigInt(t.amount), txTime: t.transaction_now * 1000 });
  }
  return out;
}

/** One call per method and cycle. 429 and 5xx (and transport errors) are retryable; other statuses and odd bodies are not, but still count as a failure. */
export async function fetchTransfers(get: ChainGet, method: ChainMethod, address: string, sinceMs: number, apiKey?: string): Promise<FetchOutcome> {
  const url = method === 'usdt_trc20' ? trc20Url(address, sinceMs) : tonUrl(address, sinceMs);
  const headers: Record<string, string> = {};
  if (apiKey) headers[method === 'usdt_trc20' ? 'TRON-PRO-API-KEY' : 'X-API-Key'] = apiKey;
  const r = await get(url, headers);
  if (!r.ok) return { ok: false, retryable: true, reason: r.error };
  if (r.status === 429 || r.status >= 500) return { ok: false, retryable: true, reason: `http ${r.status}` };
  if (r.status < 200 || r.status >= 300) return { ok: false, retryable: false, reason: `http ${r.status}` };
  const transfers = method === 'usdt_trc20' ? parseTrc20(r.body, address) : parseTon(r.body, address);
  if (!transfers) return { ok: false, retryable: false, reason: 'unexpected answer' };
  return { ok: true, transfers };
}

/** Micro-units rounded half-up to whole cents. */
export const microToCents = (micro: bigint): number => Number((micro + 5000n) / 10000n);
