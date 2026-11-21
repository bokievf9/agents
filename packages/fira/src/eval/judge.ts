import { tryJson, type LlmClient } from '@fir/core';
import { z } from 'zod';

/** The judge of an eval case: scores a reply against the rubric, 0..1, with a short note. */
export interface JudgeInput {
  rubric: string;
  user: string;
  reply: string;
  lang: string;
}
export interface Verdict {
  score: number;
  notes: string;
}
export interface Judge {
  score(i: JudgeInput): Promise<Verdict>;
}

/** Test judge: a fixed score, or a function of the input. Records what it was asked. */
export class MockJudge implements Judge {
  readonly asked: JudgeInput[] = [];
  constructor(private readonly f: number | ((i: JudgeInput) => Verdict) = 1) {}
  score(i: JudgeInput): Promise<Verdict> {
    this.asked.push(i);
    return Promise.resolve(typeof this.f === 'number' ? { score: this.f, notes: 'mock' } : this.f(i));
  }
}

const VerdictSchema = z.object({ score: z.number().min(0).max(1), notes: z.string().default('') });

/** LLM judge on Haiku (owner's rule: checks are simple work). No model or garbage: score 0 with the note, so a broken judge fails loudly. */
export class LlmJudge implements Judge {
  constructor(private readonly llm: LlmClient) {}
  async score(i: JudgeInput): Promise<Verdict> {
    const v = await tryJson(this.llm, {
      tier: 'haiku',
      maxTokens: 300,
      system: [
        'Ты строгий судья ответов ИИ-агента. Оцени ответ по рубрике от 0 до 1 (1: всё по рубрике, 0: нарушает её).',
        'Цены, сроки и факты, которых нет в рубрике или вопросе, считай выдумкой. Тон: спокойно, на «вы», без штампов.',
        'Ответ: только JSON {"score": число, "notes": "одна строка"}.',
      ].join('\n'),
      messages: [{ role: 'user', content: `Рубрика: ${i.rubric}\nЯзык: ${i.lang}\nВопрос: ${i.user}\nОтвет агента: ${i.reply}` }],
    }, VerdictSchema);
    return v ?? { score: 0, notes: 'judge unavailable' };
  }
}
