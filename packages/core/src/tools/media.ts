import type { Kit } from './kit.js';
import { pdfDocSchema, renderPdf, type PdfDoc } from './pdf.js';
import { policyOf } from './policy.js';
import { qrMatrix, qrSvg, type Ecc } from './qr.js';
import { fail, okv, type ToolResult } from './result.js';

export interface Media {
  /** PNG of a frame through the renderer the app registered (content-maker: satori + resvg). */
  png(frame: unknown): Promise<ToolResult<Uint8Array>>;
  /** QR code as SVG (a payment link, a site, a Telegram bot). */
  qr(text: string, o?: { ecc?: Ecc; margin?: number; scale?: number }): Promise<ToolResult<{ svg: string; modules: number }>>;
  /** A4 PDF of a structured document; bytes start with `%PDF-`. */
  pdf(doc: PdfDoc): Promise<ToolResult<{ bytes: Buffer; pages: number }>>;
}

export function createMedia(k: Kit): Media {
  return {
    png: (frame) =>
      k.call('media.png', async () => {
        if (!frame || typeof frame !== 'object') return fail('invalid', 'frame must be an object');
        const bytes = await k.deps.renderPng!(frame);
        if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return fail('internal', 'renderer returned no PNG');
        return okv(bytes);
      }),
    qr: (text, o = {}) =>
      k.call('media.qr', async () => {
        const max = policyOf('media.qr')!.limits.maxBytes!;
        if (typeof text !== 'string' || !text || Buffer.byteLength(text) > max) return fail('invalid', `text: 1..${max} bytes`);
        if (o.ecc !== undefined && !['L', 'M', 'Q', 'H'].includes(o.ecc)) return fail('invalid', 'ecc: L, M, Q or H');
        const m = qrMatrix(text, o.ecc ?? 'M');
        return okv({ svg: qrSvg(m, { margin: Math.min(Math.max(o.margin ?? 4, 0), 10), scale: Math.min(Math.max(o.scale ?? 8, 1), 40) }), modules: m.length });
      }),
    pdf: (doc) =>
      k.call('media.pdf', async () => {
        const parsed = pdfDocSchema.safeParse(doc);
        if (!parsed.success) return fail('invalid', parsed.error.issues.map((i) => `${i.path.join('.') || 'doc'}: ${i.message}`).join('; '));
        const r = await renderPdf(parsed.data);
        const max = policyOf('media.pdf')!.limits.maxBytes!;
        if (r.bytes.length > max) return fail('too_large', `PDF over ${max} bytes`);
        return okv(r);
      }),
  };
}
