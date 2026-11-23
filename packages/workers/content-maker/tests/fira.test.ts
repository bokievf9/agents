import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { FIRA_ASSETS_DIR, FIRA_SIGNATURE, FIRA_OFF_NOTE, firaDataUri, firaFileFor, generateItem, loadPrompts, parseReel, pngSize, renderItem, signCaption, splitPlatforms } from '../src/index.js';
import { ALL_TOPICS } from '../src/topics.js';
import { carouselJson, clipJson, postJson, promptsDir } from './helpers.js';

const prompts = loadPrompts(promptsDir);
const gen = (type: 'clip' | 'carousel' | 'post', json: string, fira?: boolean) =>
  generateItem(new MockLlm(() => json), prompts, { type, topic: ALL_TOPICS[0]!, week: 'с 23.11', ...(fira === undefined ? {} : { fira }) });

describe('Fira voice: caption signature', () => {
  it('signCaption puts «Фира · Fir Tech» on the last line, once', () => {
    expect(FIRA_SIGNATURE).toBe('Фира · Fir Tech');
    expect(signCaption('Текст\n')).toBe(`Текст\n${FIRA_SIGNATURE}`);
    expect(signCaption(signCaption('Текст'))).toBe(`Текст\n${FIRA_SIGNATURE}`);
  });

  it('a clip: every platform caption is signed, the hashtags are unchanged', async () => {
    const g = (await gen('clip', clipJson()))!;
    const { sections } = splitPlatforms(g.text);
    for (const p of ['instagram', 'tiktok', 'shorts'] as const) expect(sections[p], p).toContain(FIRA_SIGNATURE);
    expect(sections.instagram).toBe(`ig подпись\n${FIRA_SIGNATURE}\n#fir #боты #ai`.trim());
    expect(g.text).toContain('#shorts #боты');
  });

  it('a carousel and a post carry the signature too', async () => {
    expect((await gen('carousel', carouselJson()))!.text).toContain(`ig подпись\n${FIRA_SIGNATURE}`);
    const post = (await gen('post', postJson()))!;
    expect(post.text).toContain(FIRA_SIGNATURE);
    expect(post.text.trimEnd().split('\n').at(-1)).toMatch(/^#/); // hashtags stay last
  });

  it('fira: false removes the signature and tells the model rule 13 is off', async () => {
    const llm = new MockLlm(() => clipJson());
    const g = (await generateItem(llm, prompts, { type: 'clip', topic: ALL_TOPICS[0]!, week: 'с 23.11', fira: false }))!;
    expect(g.text).not.toContain(FIRA_SIGNATURE);
    expect(llm.calls[0]!.system).toContain(FIRA_OFF_NOTE);
  });

  it('the rules block carries rule 13 (Fira in first person) and the model sees it by default', async () => {
    expect(prompts.system).toMatch(/13\. Подписи к публикациям[^\n]*Фира[^\n]*первого лица/);
    const llm = new MockLlm(() => clipJson());
    await generateItem(llm, prompts, { type: 'clip', topic: ALL_TOPICS[0]!, week: 'с 23.11' });
    expect(llm.calls[0]!.system).not.toContain(FIRA_OFF_NOTE);
  });
});

describe('Fira bubble source', () => {
  it('parseReel reads the first line of the Instagram caption', async () => {
    const g = (await gen('clip', clipJson()))!;
    expect(parseReel(g.text)!.caption).toBe('ig подпись');
    expect(parseReel('Клип, 30 с: x\n1. Голос: a\n   Субтитр: b')!.caption).toBeUndefined();
  });
});

describe('Fira sticker on post and carousel images', () => {
  const text = 'Пост: Бот отвечает ночью\nНа картинке:\n   Клиент пишет в 2:00\n\n== Instagram ==\nподпись\n#fir';
  it('the sticker is a data URI of an existing PNG; middle slides and stories have none', () => {
    expect(firaDataUri('happy-base.png', FIRA_ASSETS_DIR)).toMatch(/^data:image\/png;base64,/);
    expect(firaDataUri('nope.png')).toBeUndefined();
    expect(firaFileFor('post', 0, 1)).toBe('happy-base.png');
    expect(firaFileFor('carousel', 0, 7)).toBe('thinking-glasses.png');
    expect(firaFileFor('carousel', 3, 7)).toBeNull();
    expect(firaFileFor('carousel', 6, 7)).toBe('happy-base.png');
    expect(firaFileFor('story', 0, 3)).toBeNull();
  });

  it('renderItem draws her by default (same size, different pixels) and not with fira: false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fira-img-'));
    const [withF] = await renderItem(dir, 1, 'post', text);
    const [without] = await renderItem(dir, 2, 'post', text, { fira: false });
    const a = readFileSync(withF!);
    const b = readFileSync(without!);
    expect(pngSize(a)).toEqual({ width: 1080, height: 1350 });
    expect(pngSize(b)).toEqual({ width: 1080, height: 1350 });
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBeGreaterThan(b.length);
  });
});
