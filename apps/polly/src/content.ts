import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const Example = z.object({ h: z.string().min(1), p: z.string().min(1), r: z.string().min(1) });
const WordSchema = z.object({
  h: z.string().min(1),
  p: z.string().min(1),
  r: z.string().min(1),
  n: z.string().optional(),
  e: Example.optional(),
});
const WordsFile = z.object({ topic: z.string().min(1), title: z.string().min(1), words: z.array(WordSchema).min(1) });

const Quiz = z
  .object({ q: z.string().min(1), o: z.array(z.string().min(1)).min(2).max(4), a: z.number().int().nonnegative(), why: z.string().optional() })
  .refine((x) => x.a < x.o.length, 'answer index out of range');
const Line = z.object({ who: z.string().min(1), h: z.string().min(1), p: z.string().min(1), r: z.string().min(1), card: z.boolean().optional() });
export const SITUATIONS = ['acquaintance', 'cafe', 'taxi', 'shop', 'hotel', 'road', 'polite'] as const;
const LessonSchema = z.object({
  day: z.number().int().positive(),
  title: z.string().min(1),
  situation: z.enum(SITUATIONS),
  intro: z.string().min(1),
  tone_tip: z.string().min(1),
  words: z.array(z.string()).length(3),
  dialog: z.object({ title: z.string().min(1), note: z.string().min(1), lines: z.array(Line).min(3) }),
  quiz: z.array(Quiz).length(3),
});
const ToneSet = z.object({
  forms: z.array(z.string()).length(4),
  items: z.array(z.object({ h: z.string(), r: z.string(), tone: z.number().int().min(1).max(4) })).min(2),
});
const PlacementSchema = z.object({
  pinyin: z.array(Quiz).min(1),
  words: z.array(z.string()).min(1),
  phrases: z.array(z.object({ h: z.string(), p: z.string(), o: z.array(z.string()).min(2), a: z.number().int().nonnegative() })).min(1),
});

export type Word = z.infer<typeof WordSchema> & { topic: string };
export type Lesson = z.infer<typeof LessonSchema>;
export type QuizQuestion = z.infer<typeof Quiz>;
export type ToneSetData = z.infer<typeof ToneSet>;
export type Placement = z.infer<typeof PlacementSchema>;

export interface Content {
  language: 'zh';
  /** Every word by hanzi. */
  words: Map<string, Word>;
  topics: { topic: string; title: string; count: number }[];
  lessons: Lesson[];
  tones: ToneSetData[];
  placement: Placement;
}

const read = (file: string): unknown => parse(readFileSync(file, 'utf8'));

/** Loads and validates `content/<lang>/*.yaml`. Throws with the file and the problem on any inconsistency. */
export function loadContent(dir: string, language: 'zh' = 'zh'): Content {
  const base = join(dir, language);
  const words = new Map<string, Word>();
  const topics: Content['topics'] = [];
  for (const f of readdirSync(base).filter((x) => /^words-.*\.yaml$/.test(x)).sort()) {
    const data = WordsFile.parse(read(join(base, f)));
    for (const w of data.words) {
      if (words.has(w.h)) throw new Error(`${f}: duplicate word ${w.h}`);
      words.set(w.h, { ...w, topic: data.topic });
    }
    topics.push({ topic: data.topic, title: data.title, count: data.words.length });
  }
  const lessons = z.array(LessonSchema).parse(read(join(base, 'lessons.yaml'))).sort((a, b) => a.day - b.day);
  lessons.forEach((l, i) => {
    if (l.day !== i + 1) throw new Error(`lessons.yaml: days must run 1..N without gaps (found ${l.day} at position ${i + 1})`);
    for (const h of l.words) {
      const w = words.get(h);
      if (!w) throw new Error(`lessons.yaml day ${l.day}: word ${h} is not in the vocabulary`);
      if (!w.e || !w.n) throw new Error(`word ${h} (lesson day ${l.day}) needs an example (e) and a note (n)`);
    }
  });
  const tones = z.array(ToneSet).parse((read(join(base, 'tones.yaml')) as { sets: unknown }).sets);
  const placement = PlacementSchema.parse(read(join(base, 'placement.yaml')));
  for (const h of placement.words) if (!words.has(h)) throw new Error(`placement.yaml: word ${h} is not in the vocabulary`);
  for (const p of [...placement.pinyin, ...placement.phrases]) if (p.a >= p.o.length) throw new Error('placement.yaml: answer index out of range');
  return { language, words, topics, lessons, tones, placement };
}
