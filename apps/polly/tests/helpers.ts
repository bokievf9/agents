import { MemoryMessenger, OffLlm, openDb, type LlmClient } from '@fir/core';
import { fileURLToPath } from 'node:url';
import { loadContent } from '../src/content.js';
import { PollyStore } from '../src/store.js';
import { Teacher } from '../src/teacher.js';

export const OWNER = 100;
// Wed 2026-11-18 14:00 UTC = 19:00 in Tashkent (UTC+5)
export const NOW = Date.UTC(2026, 10, 18, 14, 0);
export const content = loadContent(fileURLToPath(new URL('../content', import.meta.url)));

/** A seeded generator so shuffles are repeatable. */
export function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export function setup(opts: { llm?: LlmClient; tz?: string; lessonTime?: string } = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const messenger = new MemoryMessenger();
  const db = openDb(':memory:');
  const store = new PollyStore(db, now);
  const cfg = { ownerId: OWNER, tz: opts.tz ?? 'Asia/Tashkent', lessonTime: opts.lessonTime ?? '19:00', weeklyAt: '19:00', reviewLimit: 15 };
  const teacher = new Teacher({ store, messenger, llm: opts.llm ?? new OffLlm(), content, cfg, now, rng: seeded() });
  const lastButtons = () => (messenger.last()?.buttons ?? []).flat();
  /** Presses the button with this label in the last message. */
  const press = async (label: string) => {
    const btn = lastButtons().find((x) => x.text === label || x.text.startsWith(label));
    if (!btn) throw new Error(`no button "${label}" in: ${messenger.last()?.text}`);
    await teacher.onAction(btn.data);
  };
  /** Presses the correct answer button of a quiz-like message: finds it by the stored correct text. */
  return { teacher, store, messenger, clock, press, lastButtons, db };
}
