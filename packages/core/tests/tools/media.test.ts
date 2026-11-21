import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { markdownToPdfDoc, qrMatrix, rsDivisor, rsRemainder, scriptRuns } from '../../src/index.js';
import { tools } from './helpers.js';
import { makePng } from './png.js';

type Decoder = (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const jsqrMod = createRequire(import.meta.url)('jsqr') as Decoder | { default: Decoder };
const jsQR: Decoder = typeof jsqrMod === 'function' ? jsqrMod : jsqrMod.default;

/** Rasterises a module matrix (4 px a module, 4 modules quiet zone) and decodes it with jsQR. */
function decode(m: boolean[][]): string | null {
  const scale = 4;
  const n = (m.length + 8) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + 4) * scale + dy) * n + (x + 4) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
    }),
  );
  return jsQR(px, n, n)?.data ?? null;
}

describe('media.qr (own encoder)', () => {
  it('Reed-Solomon matches the textbook vector (HELLO WORLD, 1-M)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('a decoder reads back what was encoded: short, Cyrillic, a long payment link, every level', () => {
    const texts = ['hi', 'https://firtech.pro', 'Оплата счёта FT-2026-012', `https://firtech.pro/ru/pay/FT-2026-012?k=${'a1b2c3'.repeat(20)}`];
    for (const text of texts) for (const ecc of ['L', 'M', 'Q', 'H'] as const) expect(decode(qrMatrix(text, ecc)), `${ecc} ${text.slice(0, 20)}`).toBe(text);
    expect(qrMatrix('hi').length).toBe(21); // version 1
    expect(qrMatrix('x'.repeat(300)).length).toBeGreaterThan(41); // version 7+ carries version info
    expect(decode(qrMatrix('x'.repeat(300)))).toBe('x'.repeat(300));
  });

  it('the tool: SVG, limits, department rights', async () => {
    const { t } = tools({ dept: 'sales' });
    const r = await t.media.qr('https://firtech.pro', { scale: 2, margin: 2 });
    expect(r).toMatchObject({ ok: true, value: { modules: 25 } });
    expect(r.ok && r.value.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 29 29" width="58"/);
    expect(await t.media.qr('')).toMatchObject({ error: 'invalid' });
    expect(await t.media.qr('x'.repeat(1001))).toMatchObject({ error: 'invalid' });
    expect(await t.media.qr('x', { ecc: 'Z' as never })).toMatchObject({ error: 'invalid' });
    expect(await tools({ dept: 'marketing' }).t.media.qr('x')).toMatchObject({ error: 'not_allowed' });
  });
});

describe('media.pdf', () => {
  const doc = {
    title: 'Счёт № FT-2026-012',
    meta: ['Клиент: ООО «Ромашка»', 'Дата: 20.11.2026'],
    sections: [
      { heading: 'Услуги', paragraphs: ['Telegram-бот для записи клиентов, оплата 50% до старта.'], table: { columns: ['Позиция', 'Сумма, $'], widths: [3, 1], rows: Array.from({ length: 70 }, (_, i) => [`Работа ${i + 1}`, String(10 * i)]) } },
      { heading: 'Условия', paragraphs: ['Оплата USDT TRC20 или TON по ссылке в счёте.'] },
    ],
    footer: 'Fir Tech',
    signatures: ['Исполнитель: ____________ / Fir Tech', 'Заказчик: ____________'],
  };

  it('a valid PDF: header, page count, Onest fonts embedded', async () => {
    const { t } = tools({ dept: 'backoffice' });
    const r = await t.media.pdf(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.bytes;
    expect(b.subarray(0, 5).toString()).toBe('%PDF-');
    expect(b.subarray(-6).toString()).toContain('%%EOF');
    expect(r.value.pages).toBeGreaterThanOrEqual(2);
    expect((b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(r.value.pages);
    expect(b.toString('latin1')).toMatch(/Onest/);
    const one = await t.media.pdf({ title: 'Акт', sections: [{ paragraphs: ['Работы приняты.'] }] });
    expect(one).toMatchObject({ ok: true, value: { pages: 1 } });
  });

  it('the two parties of a contract side by side, the client\'s drawn signature as a picture', async () => {
    const { t } = tools({ dept: 'backoffice' });
    const base = { title: 'Договор № 2026-5', sections: [{ heading: '1. Предмет', paragraphs: ['Исполнитель делает сайт.'] }] };
    const unsigned = await t.media.pdf({ ...base, parties: [{ role: 'Исполнитель', name: 'Fir Tech', date: '22.11.2026' }, { role: 'Заказчик', name: 'Анвар' }] });
    const signed = await t.media.pdf({
      ...base, parties: [{ role: 'Исполнитель', name: 'Fir Tech', details: ['hello@firtech.pro'], date: '22.11.2026' }, { role: 'Заказчик', name: 'Анвар Каримов', date: '22.11.2026', signature: makePng({ stroke: true }) }],
    });
    expect(unsigned.ok && signed.ok).toBe(true);
    if (!unsigned.ok || !signed.ok) return;
    expect(signed.value.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(unsigned.value.bytes.toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    expect(signed.value.bytes.toString('latin1')).toMatch(/\/Subtype \/Image/);
    // more than two parties, or a signature that is not bytes, is refused with the reason
    const three = await t.media.pdf({ ...base, parties: [{ role: 'a', name: 'b' }, { role: 'a', name: 'b' }, { role: 'a', name: 'b' }] });
    expect(three).toMatchObject({ ok: false, error: 'invalid' });
    const text = await t.media.pdf({ ...base, parties: [{ role: 'a', name: 'b', signature: 'data:image/png;base64,AAAA' as unknown as Uint8Array }] });
    expect(text).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('a bad document is invalid with the reason; rights by department', async () => {
    const { t } = tools({ dept: 'sales' });
    expect(await t.media.pdf({ title: '', sections: [] })).toMatchObject({ ok: false, error: 'invalid' });
    const bad = await t.media.pdf({ title: 'x', sections: [{ table: { columns: ['a', 'b'], rows: [['1']] } }] });
    expect(bad).toMatchObject({ ok: false, error: 'invalid', message: expect.stringContaining('one cell per column') });
    expect(await tools({ dept: 'marketing' }).t.media.pdf(doc)).toMatchObject({ error: 'not_allowed' });
  });

  it('text runs: Cyrillic letters in the Cyrillic subset, spaces, digits and Latin in the Latin one', () => {
    expect(scriptRuns('Счёт № 12 (USDT)')).toEqual([
      { cyr: true, script: 'cyr', text: 'Счёт' }, { cyr: false, script: 'lat', text: ' ' }, { cyr: true, script: 'cyr', text: '№' }, { cyr: false, script: 'lat', text: ' 12 (USDT)' },
    ]);
  });
});

describe('media.pdf: Tajik letters (Cyrillic Extended subset)', () => {
  const TAJIK = 'ҳқҷӯғӣ';
  const fontDir = new URL('../../assets/fonts/', import.meta.url).pathname;

  it('the letters go to the ext subset, the rest of the words to the Cyrillic one', () => {
    expect(scriptRuns('Душанбе, ҳисоб').map((r) => [r.script, r.text])).toEqual([['cyr', 'Душанбе'], ['lat', ', '], ['ext', 'ҳ'], ['cyr', 'исоб']]);
    for (const ch of TAJIK) expect(scriptRuns(ch)[0]!.script).toBe('ext');
  });

  it('the ext fonts (400 and 700) have the glyphs, and neither the Cyrillic nor the Latin subset does', async () => {
    const { default: PDFDocument } = await import('pdfkit');
    const doc = new PDFDocument();
    const has = (file: string, ch: string): boolean => {
      doc.registerFont(file, `${fontDir}${file}`);
      return (doc.font(file) as unknown as { _font: { font: { hasGlyphForCodePoint(cp: number): boolean } } })._font.font.hasGlyphForCodePoint(ch.codePointAt(0)!);
    };
    for (const w of ['400', '700']) {
      for (const ch of TAJIK) {
        expect(has(`onest-cyrillic-ext-${w}-normal.woff`, ch), `ext ${w} ${ch}`).toBe(true);
        expect(has(`onest-cyrillic-${w}-normal.woff`, ch), `cyr ${w} ${ch}`).toBe(false);
      }
    }
    doc.registerFont('e', `${fontDir}onest-cyrillic-ext-400-normal.woff`);
    expect(doc.font('e').widthOfString(TAJIK)).toBeGreaterThan(0);
  });

  it('a PDF with «Душанбе, ҳисоб» embeds the ext subset, in regular and bold', async () => {
    const { t } = tools({ dept: 'backoffice' });
    const tajik = await t.media.pdf({ title: 'Ҳисоб', sections: [{ heading: 'Душанбе', paragraphs: ['Душанбе, ҳисоб, қарз, ҷавоб, ӯро, ғайр, ӣ.'] }] });
    const plain = await t.media.pdf({ title: 'Акт', sections: [{ heading: 'Душанбе', paragraphs: ['Работы приняты.'] }] });
    expect(tajik.ok && plain.ok).toBe(true);
    if (!tajik.ok || !plain.ok) return;
    const names = (b: Buffer) => new Set(b.toString('latin1').match(/\/FontName \/[A-Z]{6}\+[A-Za-z0-9-]+/g));
    expect(names(tajik.value.bytes).size).toBe(names(plain.value.bytes).size + 2); // ext regular (text) and ext bold (title)
  });
});

describe('media.png (adapter slot)', () => {
  it('not configured without a renderer; the renderer is used and checked', async () => {
    expect(await tools().t.media.png({ type: 'post' })).toMatchObject({ error: 'not_configured' });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const ok = tools({ renderPng: () => Promise.resolve(png) }).t;
    expect(await ok.media.png({ type: 'post' })).toEqual({ ok: true, value: png });
    expect(await ok.media.png(null)).toMatchObject({ error: 'invalid' });
    expect(await tools({ renderPng: () => Promise.resolve(new Uint8Array([1, 2, 3])) }).t.media.png({})).toMatchObject({ error: 'internal' });
    expect(await tools({ renderPng: () => Promise.reject(new Error('font missing')) }).t.media.png({})).toMatchObject({ error: 'internal', message: expect.stringContaining('font missing') });
  });
});

describe('markdownToPdfDoc (document templates)', () => {
  it('title, sections, lists, tables; renders', async () => {
    const md = '# Акт № 2026-5\n\n20.11.2026\n\nИсполнитель передал **результат**.\n\n## Что передано\n- Бот\n- Доступы\n\n## Смета\n| Позиция | Сумма |\n|---|---|\n| Бот | $300 |\n';
    const doc = markdownToPdfDoc(md, { footer: 'Fir Tech' });
    expect(doc).toEqual({
      title: 'Акт № 2026-5', footer: 'Fir Tech',
      sections: [
        { paragraphs: ['20.11.2026', 'Исполнитель передал результат.'] },
        { heading: 'Что передано', paragraphs: ['• Бот', '• Доступы'] },
        { heading: 'Смета', paragraphs: [], table: { columns: ['Позиция', 'Сумма'], rows: [['Бот', '$300']] } },
      ],
    });
    expect(await tools({ dept: 'backoffice' }).t.media.pdf(doc)).toMatchObject({ ok: true, value: { pages: 1 } });
  });
});
