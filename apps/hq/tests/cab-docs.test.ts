import { describe, expect, it } from 'vitest';
import { clientNextAction, docText, DOC_TEXT_MAX_BYTES, docNextStep, parseSignature, projectStateOf, SIGNATURE_MAX_CHARS, type DocRow, type StageLike } from '../src/cab-docs.js';
import { dataUrl, makePng } from './png.js';

const doc = (o: Partial<DocRow>): DocRow => ({
  id: 1, client_id: 1, kind: 'quote', title: 't', number: '', lead_id: 1, project_id: 1, pack_id: 1, state: 'awaiting_client', src: '', src_id: null, amount_usd: null, stage_no: null, body: '',
  pdf_rel: null, pdf_sha256: null, signed_pdf_rel: null, meta: '{}', created_at: 0, delivered_at: 0, accepted_at: null, signed_at: null, ...o,
});
const stage = (o: Partial<StageLike>): StageLike => ({ stageNo: 1, state: 'awaiting_payment', payUrl: null, invoiceNumber: null, ...o });

describe('the drawn signature', () => {
  it('a PNG with a stroke passes; a blank canvas, a flat white one, a tiny or huge picture, a non-PNG and an oversized data URL do not', () => {
    expect(parseSignature(dataUrl(makePng({ stroke: true })))).toMatchObject({ ok: true });
    expect(parseSignature(dataUrl(makePng({ stroke: true, background: 'white' })))).toMatchObject({ ok: true });
    expect(parseSignature(dataUrl(makePng()))).toEqual({ ok: false, reason: 'blank' });
    expect(parseSignature(dataUrl(makePng({ background: 'white' })))).toEqual({ ok: false, reason: 'blank' });
    expect(parseSignature(dataUrl(makePng({ w: 8, h: 4, stroke: true })))).toEqual({ ok: false, reason: 'bad_size' });
    expect(parseSignature(dataUrl(makePng({ w: 5000, h: 30, stroke: true })))).toEqual({ ok: false, reason: 'bad_size' });
    expect(parseSignature('data:image/jpeg;base64,/9j/4AAQ')).toEqual({ ok: false, reason: 'not_png' });
    expect(parseSignature('data:image/png;base64,AAAA')).toEqual({ ok: false, reason: 'not_png' });
    expect(parseSignature(`data:image/png;base64,${'A'.repeat(SIGNATURE_MAX_CHARS)}`)).toEqual({ ok: false, reason: 'too_large' });
    expect(parseSignature('data:image/png;base64,<script>')).toEqual({ ok: false, reason: 'not_png' });
    expect(parseSignature('hello')).toEqual({ ok: false, reason: 'not_png' });
  });
});

describe('what the client does next', () => {
  it('a quote to accept comes before a contract to sign, then the stage to pay with its link, then the stage to accept, otherwise wait', () => {
    const quote = doc({ id: 1, kind: 'quote', state: 'awaiting_client' });
    const contract = doc({ id: 2, kind: 'contract', state: 'awaiting_signature' });
    expect(clientNextAction([quote, contract], [stage({ payUrl: 'https://pay' })])).toEqual({ kind: 'accept_quote', docId: 1 });
    expect(clientNextAction([{ ...quote, state: 'accepted' }, contract], [])).toEqual({ kind: 'sign_contract', docId: 2 });
    const invoice = doc({ id: 3, kind: 'invoice', state: 'issued', number: 'FT-2026-001' });
    const signed = [{ ...quote, state: 'accepted' as const }, { ...contract, state: 'signed' as const }, invoice];
    expect(clientNextAction(signed, [stage({ payUrl: 'https://pay', invoiceNumber: 'FT-2026-001' })])).toEqual({ kind: 'pay_stage', stageNo: 1, payUrl: 'https://pay', docId: 3 });
    expect(clientNextAction(signed, [stage({ payUrl: null })])).toEqual({ kind: 'wait' }); // the invoice is not issued yet
    expect(clientNextAction(signed, [stage({ state: 'accepted' }), stage({ stageNo: 2, state: 'awaiting_acceptance' })])).toEqual({ kind: 'accept_stage', stageNo: 2 });
    expect(clientNextAction(signed, [stage({ state: 'in_progress' })])).toEqual({ kind: 'wait' });
    expect(clientNextAction([], [])).toEqual({ kind: 'wait' });
  });

  it('the project state: preparing until a stage is paid; then in progress; paused and done as they are', () => {
    expect(projectStateOf('draft', [])).toBe('preparing');
    expect(projectStateOf('draft', [{ state: 'awaiting_payment' }])).toBe('preparing');
    expect(projectStateOf('draft', [{ state: 'in_progress' }])).toBe('in_progress');
    expect(projectStateOf('active', [])).toBe('in_progress');
    expect(projectStateOf('paused', [{ state: 'in_progress' }])).toBe('paused');
    expect(projectStateOf('done', [])).toBe('done');
  });

  it('the lead sentence: only for a lead whose quote went through the cabinet, in the lead\'s language', () => {
    const quote = doc({ kind: 'quote', state: 'accepted' });
    expect(docNextStep([], { kind: 'wait' }, 'ru')).toBeNull();
    expect(docNextStep([quote], { kind: 'wait' }, 'ru')).toBe('КП принято, готовим договор');
    expect(docNextStep([quote], { kind: 'wait' }, 'en')).toBe('Proposal accepted, we are preparing the contract');
    expect(docNextStep([doc({ state: 'awaiting_client' })], { kind: 'accept_quote', docId: 1 }, 'ru')).toContain('Принять КП');
    expect(docNextStep([quote, doc({ id: 2, kind: 'contract', state: 'signed' })], { kind: 'wait' }, 'ru')).toBe('Договор подписан, готовим счёт на первый этап');
    expect(docNextStep([quote, doc({ id: 2, kind: 'contract', state: 'signed' }), doc({ id: 3, kind: 'invoice', state: 'issued' })], { kind: 'wait' }, 'ru')).toBeNull();
  });
});

describe('the text of a document in the API', () => {
  it('quote, contract and other carry the stored text; invoice and act carry null', () => {
    expect(docText(doc({ kind: 'quote', body: '# КП\n\nтекст' }))).toBe('# КП\n\nтекст');
    expect(docText(doc({ kind: 'other', body: 'Смета' }))).toBe('Смета');
    expect(docText(doc({ kind: 'invoice', body: 'x' }))).toBeNull();
    expect(docText(doc({ kind: 'act', body: 'x' }))).toBeNull();
  });
  it('the contract text stops before the signature block, like its PDF', () => {
    expect(docText(doc({ kind: 'contract', body: '# Договор\n\n1. Предмет\n\n## Подписи сторон\nИсполнитель' }))).toBe('# Договор\n\n1. Предмет\n\n');
  });
  it('is cut at 60 KB on a character boundary', () => {
    const long = 'я'.repeat(40_000); // 2 bytes each
    const t = docText(doc({ kind: 'quote', body: long }))!;
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(DOC_TEXT_MAX_BYTES);
    expect(t).toBe('я'.repeat(DOC_TEXT_MAX_BYTES / 2));
    expect(t).not.toContain('\uFFFD');
    const odd = docText(doc({ kind: 'quote', body: 'a' + 'я'.repeat(40_000) }))!; // the cut falls inside a letter
    expect(odd).toBe('a' + 'я'.repeat((DOC_TEXT_MAX_BYTES - 2) / 2));
    expect(odd).not.toContain('\uFFFD');
    expect(docText(doc({ kind: 'quote', body: 'a'.repeat(DOC_TEXT_MAX_BYTES) }))!.length).toBe(DOC_TEXT_MAX_BYTES);
  });
});
