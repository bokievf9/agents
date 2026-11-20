import { splitPlatforms, replacePart, type ItemType } from './format.js';
import type { Tools } from '@fir/core';

/**
 * Picture backgrounds from Openverse (openly licensed, `tools.media.openverse.search`) for carousel slides and single posts, used when the item
 * has no render of its own. The picture is a darkened background under the brand frame; the credit line goes into the Instagram caption
 * automatically and is put back on approval when an edit dropped it: an Openverse picture is never used without its credit.
 */
export const BACKGROUND_TYPES: readonly ItemType[] = ['carousel', 'post'];

/** An English search phrase (Openverse is searched in English) from the direction and the words of the topic. */
export function backgroundQuery(directionId: string | null, topicText: string): string {
  const t = topicText.toLowerCase();
  const byWord: [RegExp, string][] = [
    [/барбер/, 'barbershop'], [/салон|красот|маникюр|ногт/, 'beauty salon'], [/стомат|зуб|клиник/, 'dentist office'], [/кафе|ресторан|кофейн/, 'cafe interior'],
    [/достав/, 'food delivery'], [/магазин|товар/, 'small shop'], [/фитнес|йог|тренер/, 'fitness studio'], [/авто/, 'car repair shop'],
  ];
  for (const [re, q] of byWord) if (re.test(t)) return q;
  const byDirection: Record<string, string> = {
    admin: 'barbershop', receptionist: 'customer service', automation: 'cafe counter', content: 'smartphone social media', miniapp: 'online shopping smartphone',
    agent: 'student laptop', implementation: 'team meeting office', site: 'laptop web design',
  };
  return (directionId && byDirection[directionId]) || 'small business';
}

export interface Background {
  /** The credit line for the caption. */
  credit: string;
  /** Where the picture is stored under the renders folder: `<itemId>/bg.jpg` or `.png`. */
  file: string;
  licence: string;
}

const kind = (b: Uint8Array): 'jpg' | 'png' | null => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : null);

/**
 * Looks for a picture, downloads the small copy Openverse serves itself and stores it as `<itemId>/bg.jpg`. null on any failure (no keys needed
 * but a budget exists, a network error, no result, a format the renderer cannot read): the item then goes out with the plain brand frame.
 */
export async function findBackground(tools: Tools | undefined, itemId: number, q: string): Promise<Background | null> {
  if (!tools || !tools.can('media.openverse.search') || !tools.can('web.getBytes') || !tools.can('files.put')) return null;
  const found = await tools.media.openverse.search({ q, kind: 'image', licence: 'commercial', pageSize: 5 });
  if (!found.ok) return null;
  for (const hit of found.value) {
    const got = await tools.web.getBytes(hit.thumbnail, { hosts: ['api.openverse.org'] });
    if (!got.ok) continue;
    const ext = kind(got.value.bytes);
    if (!ext) continue;
    const stored = await tools.files.put(String(itemId), `bg.${ext}`, got.value.bytes);
    if (stored.ok) return { credit: hit.attribution, file: stored.value.path, licence: hit.licence };
  }
  return null;
}

/** The Instagram caption with the credit line in it (before the hashtag line); text without an Instagram section gets the line at the end. Idempotent. */
export function withCredit(text: string, credit: string): string {
  if (!credit || text.includes(credit)) return text;
  const { sections } = splitPlatforms(text);
  const ig = sections.instagram;
  if (ig === undefined) return `${text.trimEnd()}\n\n${credit}`;
  const lines = ig.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  const tagLine = last >= 0 && lines[last]!.trim().split(/\s+/).every((w) => w.startsWith('#'));
  const out = tagLine ? [...lines.slice(0, last), '', credit, '', ...lines.slice(last)] : [...lines.slice(0, last + 1), '', credit];
  return replacePart(text, 'instagram', out.join('\n').replace(/\n{3,}/g, '\n\n')) ?? `${text.trimEnd()}\n\n${credit}`;
}
