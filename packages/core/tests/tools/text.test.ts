import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beatSheet, classifyHook, detectText, humanizeText, lexiconSize, lintCaption, loadHooks, rankSwipe, scoreHook, scoreHooks, TOOL_POLICY } from '../../src/index.js';
import { tools } from './helpers.js';

describe('text.hookScore', () => {
  it('ranks hooks, names the weakest property and flags the dealbreakers (EN)', () => {
    const r = scoreHooks(['I lost $18,000 on one missing contract.', 'Hey guys, welcome to my channel, today I want to talk about contracts', "Stop scrolling, in this video I'm going to show you something"], 'en');
    expect(r.ranked[0]!.hook).toContain('$18,000');
    expect(r.ranked[0]!.verdict).toBe('strong');
    expect(Object.keys(r.ranked[0]!.checks).sort()).toEqual(['address', 'frontload', 'length', 'specificity', 'stakes']);
    const bad = r.ranked.find((x) => x.hook.startsWith('Stop'))!;
    expect(bad.dealbreakers.length).toBeGreaterThanOrEqual(2); // «stop scrolling» and the preamble
    expect(bad.verdict).toBe('weak');
    expect(r.ranked.find((x) => x.hook.startsWith('Hey'))!.dealbreakers.join(' ')).toContain('Greeting');
    expect(r.best).toBe(r.ranked[0]);
  });

  it('knows the Russian dealbreakers: «стоп скролл», «привет всем», «сегодня я расскажу»', () => {
    for (const hook of ['Стоп скролл! Это важно для вашего бизнеса', 'Привет всем, это мой новый ролик про ботов', 'Сегодня я расскажу вам про автоматизацию записи']) {
      const h = scoreHook(hook, 'ru');
      expect(h.dealbreakers.length, hook).toBeGreaterThanOrEqual(1);
      expect(h.verdict, hook).not.toBe('strong');
    }
  });

  it('counts a spoken Russian number as concrete', () => {
    const spoken = scoreHook('Я потерял три заявки за одну ночь', 'ru');
    const vague = scoreHook('Я потерял очень много заявок за одну ночь', 'ru');
    expect(spoken.checks.specificity.score).toBeGreaterThan(vague.checks.specificity.score);
    expect(scoreHook('Ноль рублей на рекламу и десять заявок', 'ru').checks.specificity.score).toBeGreaterThanOrEqual(75);
    expect(scoreHook('Бот записал клиента ночью', 'ru').checks.specificity.score).toBe(15);
  });

  it('a payoff at the front scores higher than the same words buried at the end', () => {
    const front = scoreHook('Никогда не отвечайте клиенту через час', 'ru');
    const back = scoreHook('Давайте поговорим сегодня о том, как часто мы все отвечаем клиентам через час и теряем их', 'ru');
    expect(front.score).toBeGreaterThan(back.score);
  });

  it('the language is detected when it is not given', () => {
    expect(scoreHook('Никто не говорит, что бот теряет заявки').checks.stakes.detail).toMatch(/маркеров/);
    expect(scoreHook('Nobody tells you the first 30 flop').checks.stakes.detail).toMatch(/tension/);
  });

  it('through the tool: invalid input is `invalid`, a good call is ok', async () => {
    const { t } = tools({ dept: 'marketing' });
    expect(await t.text.hookScore([])).toMatchObject({ ok: false, error: 'invalid' });
    expect(await t.text.hookScore([' '])).toMatchObject({ ok: false, error: 'invalid' });
    const ok = await t.text.hookScore(['Я потерял три заявки за ночь'], 'ru');
    expect(ok.ok && ok.value.ranked).toHaveLength(1);
  });
});

describe('text.beats', () => {
  const SCRIPT = [
    'Клиент пишет в Instagram в 23:40. Кто ему ответит?',
    'Бот отвечает за две секунды.',
    'Он записывает клиента на завтра.',
    'Мастер приходит утром и видит запись.',
    'Клиент пришёл, и бот уже знает его имя.',
  ].join('\n');

  it('times lines with the Russian rate of 150 wpm and the English one of 165', () => {
    const ru = beatSheet(SCRIPT)!;
    expect(ru.wpm).toBe(150);
    expect(ru.beats[0]!.dur).toBeCloseTo(4, 1); // 10 words at 2.5 words a second
    expect(ru.beats[1]!.start).toBeCloseTo(4, 1);
    const en = beatSheet('I lost $18,000 on one missing contract.\nNow I add one line to every contract.', { lang: 'en' })!;
    expect(en.wpm).toBe(165);
    expect(beatSheet(SCRIPT, { wpm: 200 })!.wpm).toBe(200);
  });

  it('flags a hook past 3 seconds and a long beat', () => {
    expect(beatSheet(SCRIPT)!.flags).toContain('hook_long');
    const oneLong = beatSheet('Один длинный абзац без точки который просто тянется и тянется и тянется и никак не заканчивается потому что автор не умеет вовремя остановиться вообще', { lang: 'ru' })!;
    expect(oneLong.flags).toContain('beat_long');
  });

  it('flags a run of three lines with nothing concrete and a missing loop', () => {
    const s = beatSheet('Три заявки за ночь.\nКлиент пишет поздно.\nМастер уже спит.\nБот работает всегда.\nНапишите нам.')!;
    expect(s.flags).toContain('abstract_run');
    expect(beatSheet('Бот записал клиента ночью.\nМастер увидел запись утром.\nНапишите нам.')!.flags).toContain('no_loop');
    expect(s.notes.join(' ')).toMatch(/конкретного/);
  });

  it('a loop back to the hook is recognised', () => {
    const s = beatSheet('Бот записал клиента ночью.\nМастер увидел запись в 9:00.\nЗапись пришла от бота: ночью.')!;
    expect(s.flags).not.toContain('no_loop');
    expect(s.notes.join(' ')).toMatch(/Петля/);
  });

  it('compares the length with the target', () => {
    expect(beatSheet(SCRIPT, { targetS: 10 })!.flags).toContain('over_target');
    expect(beatSheet(SCRIPT, { targetS: 60 })!.flags).toContain('under_target');
    expect(beatSheet('   \n  ')).toBeNull();
  });
});

describe('text.captionLint', () => {
  const GOOD = 'Бот записал клиента за 2 секунды в 23:40.\n\nБот для записи отвечает в Instagram, пока мастер работает.\n\nНапишите нам: @firtech_bot\n\n#боты #автоматизация';

  it('a good Russian caption is ready and shows the 125-character window', () => {
    const r = lintCaption(GOOD, { keywords: ['бот для записи'] });
    expect(r.verdict).toBe('ready');
    expect([...r.visible].length).toBeLessThanOrEqual(125);
    expect(r.truncated).toBe(true);
    expect(r.asks).toHaveLength(1);
  });

  it('fails length over 2200, more than five hashtags, a hashtag opener and absent search terms', () => {
    expect(lintCaption('Слово '.repeat(400)).checks.find((c) => c.check === 'length')!.status).toBe('fail');
    const tags = lintCaption('Бот за 2 секунды.\n\n#а1 #б2 #в3 #г4 #д5 #е6');
    expect(tags.checks.find((c) => c.check === 'hashtags')!.status).toBe('fail');
    expect(tags.verdict).toBe('fix');
    expect(lintCaption('#боты Бот за 2 секунды').checks.find((c) => c.check === 'first_line')!.status).toBe('fail');
    expect(lintCaption(GOOD, { keywords: ['сайт для барбершопа'] }).checks.find((c) => c.check === 'search_terms')!.status).toBe('fail');
  });

  it('warns on no concrete hook in the window, no ask, two asks, filler tags and links', () => {
    const vague = lintCaption('Автоматизация делает бизнес лучше и проще для всех.\n\nПодробности скоро.');
    expect(vague.checks.find((c) => c.check === 'hook_concrete')!.status).toBe('warn');
    expect(vague.checks.find((c) => c.check === 'one_ask')!.status).toBe('warn');
    const two = lintCaption('Бот за 2 секунды.\n\nСохраните это и напишите нам, подписывайтесь тоже.');
    expect(two.asks.length).toBeGreaterThanOrEqual(2);
    expect(two.checks.find((c) => c.check === 'one_ask')!.detail).toMatch(/Два призыва/);
    expect(lintCaption('Бот за 2 секунды. Напишите нам.\n\n#fyp #рилс').checks.find((c) => c.check === 'hashtags')!.status).toBe('warn');
    expect(lintCaption('Бот за 2 секунды. Напишите нам: https://example.com/x').checks.find((c) => c.check === 'links')!.status).toBe('warn');
    expect(lintCaption('Бот за 2 секунды. Напишите нам: firtech.pro').checks.find((c) => c.check === 'links')!.status).toBe('pass');
  });

  it('English captions work too', () => {
    const r = lintCaption('I billed 4 hours a week for formatting.\n\nComment CONTRACT and I will send it.\n\n#proposals', { lang: 'en' });
    expect(r.verdict).toBe('ready');
    expect(r.asks).toEqual(['comment a keyword']);
  });
});

describe('text.humanize and text.detect', () => {
  it('the Russian lexicon has at least 80 terms with plain replacements (and the English one is ported whole)', () => {
    expect(lexiconSize('en')).toBe(154);
    expect(lexiconSize('ru')).toBeGreaterThanOrEqual(150);
    const src = readFileSync(new URL('../../src/tools/text-lexicon-ru.ts', import.meta.url), 'utf8');
    const withReplacement = [...src.matchAll(/p\('([^']+)', '([^']*)'/g)].length;
    expect(withReplacement).toBeGreaterThanOrEqual(80);
    for (const phrase of ['в современном мире', 'не секрет, что', 'важно отметить', 'давайте разберёмся', 'погрузиться', 'раскрыть потенциал', 'ключевой', 'эффективный и надёжный', 'в заключение', 'итак', 'безусловно', 'стоит отметить', 'на сегодняшний день', 'как известно', 'уникальный', 'инновационный', 'комплексный подход', 'индивидуальный подход', 'широкий спектр', 'высокое качество', 'оптимальное решение', 'не упустите', 'спешите', 'ваш надёжный партнёр']) {
      expect(detectText(`Мы делаем сайты. ${phrase}.`, 'ru').slop.length, phrase).toBeGreaterThan(0);
    }
  });

  it('strips invisible characters, dashes and curly quotes', () => {
    const r = humanizeText('Привет​ мир⁠ — это “тест” и ‘кавычки’… 5–10 дней ок', 'ru');
    expect(r.text).toBe('Привет мир - это "тест" и \'кавычки\'... 5-10 дней ок');
    expect(r.report.invisible.map((x) => x.name).join(' ')).toContain('ZERO WIDTH SPACE');
    expect(r.artefacts).toBeGreaterThanOrEqual(7);
    expect(humanizeText('a\u{E0041}b­c', 'en').text).toBe('abc');
  });

  it('replaces Russian stock phrases with plain words and keeps capitals', () => {
    const r = humanizeText('В современном мире важно отметить, что наше уникальное решение даёт широкий спектр услуг. Свяжитесь с нами!', 'ru');
    expect(r.text).toBe('Сейчас наше особенное решение даёт много услуг. Напишите нам!');
    expect(r.report.lexical.length).toBeGreaterThanOrEqual(4);
    expect(humanizeText('Давайте разберёмся, как это работает.', 'ru').text).toBe('Как это работает.');
  });

  it('English: lexicon, capitals, and URLs left alone', () => {
    const r = humanizeText("Let's delve into this. We leverage a robust tool: https://example.com/leverage-robust", 'en');
    expect(r.text).toContain('https://example.com/leverage-robust');
    expect(r.text).toContain('look');
    expect(r.text).not.toMatch(/delve|robust tool/);
  });

  it('structures are reported, never rewritten', () => {
    const r = humanizeText('Это не просто сайт, это партнёр. Мы работаем быстро, чётко и честно.', 'ru');
    expect(r.text).toContain('Это не просто сайт, это партнёр');
    expect(r.report.structures.map((s) => s.id)).toContain('ru-not-just');
    expect(r.report.structures.map((s) => s.id)).toContain('ru-triad');
  });

  it('words with no safe replacement are only flagged', () => {
    const r = humanizeText('Мы даём бесшовный опыт.', 'ru');
    expect(r.text).toBe('Мы даём бесшовный опыт.');
    expect(r.report.flagged.map((f) => f.find)).toContain('бесшовн*');
  });

  it('detect: a stock-word text scores far below a concrete one, with the five checks', () => {
    const slop = detectText('В современном мире важно отметить, что наше уникальное и инновационное решение является ключевым. Мы предлагаем комплексный подход и широкий спектр услуг. Не упустите возможность! Это не просто бот, это ваш надёжный партнёр. Давайте разберёмся, как раскрыть потенциал бизнеса.');
    const human = detectText('Вчера бот записал 14 человек в Ташкенте. Один отменил. Я сам не поверил, пока не проверил журнал. Ну вот, честно: мастер Азиз ответил на три сообщения за весь день. Остальное сделал бот. Мы не просили его об этом, но он справился.');
    expect(slop.verdict).toBe('flagged');
    expect(slop.checks.slop_density.score).toBeLessThan(20);
    expect(human.score).toBeGreaterThan(slop.score + 25);
    expect(Object.keys(human.checks)).toEqual(['burstiness', 'specificity', 'slop_density', 'fingerprint', 'voice']);
    expect(slop.structures.map((s) => s.id)).toContain('ru-not-just');
  });

  it('detect: an em dash and invisible characters hit the fingerprint check; humanize fixes it', () => {
    const dirty = 'Бот отвечает — быстро​ и точно — всегда. Клиент пишет — бот отвечает — мастер видит запись. Это работает — проверено.';
    expect(detectText(dirty, 'ru').checks.fingerprint.score).toBeLessThan(60);
    expect(detectText(humanizeText(dirty, 'ru').text, 'ru').checks.fingerprint.score).toBe(100);
  });

  it('through the tools: allowed for marketing, sales, support only', async () => {
    for (const dept of ['marketing', 'sales', 'support']) {
      const { t } = tools({ dept });
      expect((await t.text.detect('Вчера бот записал 14 человек.')).ok).toBe(true);
    }
    const { t } = tools({ dept: 'production', agentId: 'pm' });
    expect(await t.text.humanize('Привет')).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await tools({ dept: 'marketing' }).t.text.humanize('')).toMatchObject({ ok: false, error: 'invalid' });
    expect(TOOL_POLICY.filter((p) => p.name.startsWith('text.')).every((p) => p.quiet && p.env.length === 0)).toBe(true);
  });
});

describe('text.swipeRank and the 26 hooks', () => {
  const data = loadHooks();

  it('knowledge/hooks.json has 26 formulas with RU and EN fields and working patterns', () => {
    expect(data!.hooks).toHaveLength(26);
    expect(data!.classify_order).toHaveLength(26);
    for (const h of data!.hooks) {
      for (const lang of ['ru', 'en'] as const) {
        for (const f of ['name', 'template', 'example', 'on_screen', 'best_for', 'trap'] as const) expect(h[lang][f].length, `${h.id} ${lang} ${f}`).toBeGreaterThanOrEqual(3);
        expect(() => new RegExp(h.match[lang], 'iu')).not.toThrow();
      }
    }
    expect(data!.rules.ru).toHaveLength(6);
  });

  it('every Russian example classifies as its own formula; most English ones do as well', () => {
    let en = 0;
    for (const h of data!.hooks) {
      expect(classifyHook(h.ru.example, data, 'ru')?.id, `ru ${h.id} ${h.ru.example}`).toBe(h.id);
      if (classifyHook(h.en.example, data, 'en')?.id === h.id) en++;
    }
    expect(en).toBeGreaterThanOrEqual(20);
  });

  it('ranks by the multiple over the account median, not by views', () => {
    const r = rankSwipe([
      { account: '@big', followers: 2_000_000, median: 380_000, views: 400_000, hook: 'Stop posting three times a day' },
      { account: '@small', followers: 4000, median: 1000, views: 400_000, hook: 'nobody tells you your first 30 reels are supposed to flop' },
      { account: '@mid', median: 5000, views: 7500, hook: 'Никто не говорит, что боты не продают сами' },
    ]);
    expect(r.reels.map((x) => x.account)).toEqual(['@small', '@mid', '@big']);
    expect(r.reels[0]!.outlier).toBe(400);
    expect(r.reels[0]!.formula).toBe('Nobody Tells You');
    expect(r.reels[1]!.formula).toBe('Никто не говорит');
    expect(r.baseline).toBe('account median');
    expect(r.confidence).toBe('low');
    expect(r.formulasLoaded).toBe(true);
  });

  it('without a median it falls back to followers and says so; without formulas it names none', () => {
    const rows = [{ account: '@a', followers: 1000, views: 5000, hook: 'Не делайте этого' }, { account: '@b', followers: 100, views: 100, hook: 'тест' }];
    expect(rankSwipe(rows, { hooks: null }).baseline).toBe('follower count');
    expect(rankSwipe(rows, { hooks: null }).reels.every((x) => x.formula === 'unclassified')).toBe(true);
    expect(rankSwipe([{ views: 10, hook: 'x' }]).baseline).toBe('none');
  });

  it('through the tool: rows without views or hooks are invalid', async () => {
    const { t } = tools({ dept: 'marketing' });
    expect(await t.text.swipeRank([{ views: 0, hook: '' }])).toMatchObject({ ok: false, error: 'invalid' });
    const ok = await t.text.swipeRank([{ account: '@a', median: 100, views: 500, hook: 'Хватит постить каждый день' }]);
    expect(ok.ok && ok.value.reels[0]!.formula).toBe('Запрет');
  });
});
