import { reachChannels, type Tools } from '@fir/core';

export const MIN_PAGE_CHARS = 400;

export interface SourcePage {
  text: string;
  via: 'own' | 'jina' | 'reach';
}

/**
 * The text of a source page the owner named (`meta.sourceUrl`). `web.readable` first (its own parse, then Jina Reader inside it); when both give
 * under 400 characters the Mac's Agent Reach is asked (`reach.web.read`, only when the Mac reported the `web` channel). Never waits for the Mac:
 * a queued job answers null now and the cached answer serves the next run. Returns null when there is nothing usable.
 */
export async function readSourcePage(tools: Tools, db: Parameters<typeof reachChannels>[0], url: string): Promise<SourcePage | null> {
  if (!/^https:\/\//i.test(url)) return null;
  const own = await tools.web.readable(url, { hosts: 'public', maxChars: 6000 });
  const ownText = own.ok ? own.value.text.trim() : '';
  if (own.ok && ownText.length >= MIN_PAGE_CHARS) return { text: ownText, via: own.value.via === 'jina' ? 'jina' : 'own' };
  if (!reachChannels(db).includes('web')) return ownText ? { text: ownText, via: own.ok && own.value.via === 'jina' ? 'jina' : 'own' } : null;
  const r = await tools.reach.web.read({ target: url });
  if (r.ok && r.value.state === 'done' && r.value.result.ok) {
    const text = r.value.result.items.map((i) => (typeof i.text === 'string' ? i.text : '')).join('\n').trim().slice(0, 6000);
    if (text.length > ownText.length) return { text, via: 'reach' };
  }
  return ownText ? { text: ownText, via: 'own' } : null;
}
