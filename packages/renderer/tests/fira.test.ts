import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRA_DIR, firaAvailable, prepareFira } from '../src/fira-files.js';
import { FIRA_ACCESSORIES, FIRA_DEFAULT, FIRA_EMOTIONS, FIRA_MANIFEST, FIRA_PNG_SIZE, firaFile, resolveFira, shortBubble } from '../src/fira-spec.js';
import { buildProps } from '../src/job.js';
import { SAMPLE_SCRIPT } from '../src/sample-script.js';

describe('Fira asset manifest', () => {
  it('16 files: 4 emotions x 4 accessories', () => {
    expect(FIRA_MANIFEST).toHaveLength(16);
    expect(new Set(FIRA_MANIFEST).size).toBe(16);
    expect(FIRA_MANIFEST).toContain(firaFile('listening', 'headphones'));
    expect(FIRA_EMOTIONS.length * FIRA_ACCESSORIES.length).toBe(16);
  });

  it('every file exists, is a 1024 px PNG with an alpha channel and a sane size', () => {
    expect(firaAvailable()).toBe(true);
    for (const f of FIRA_MANIFEST) {
      const path = join(FIRA_DIR, f.replace(/^fira\//, ''));
      expect(existsSync(path), f).toBe(true);
      const size = statSync(path).size;
      expect(size, f).toBeGreaterThan(50_000);
      expect(size, f).toBeLessThan(600_000);
      const head = readFileSync(path).subarray(0, 26);
      expect(head.subarray(1, 4).toString(), f).toBe('PNG');
      expect(head.readUInt32BE(16), f).toBe(FIRA_PNG_SIZE);
      expect(head.readUInt32BE(20), f).toBe(FIRA_PNG_SIZE);
      expect([4, 6], `${f} colour type: transparent`).toContain(head[25]); // 6 = RGBA
    }
  });

  it('prepareFira copies all 16 into the public dir', () => {
    const pub = mkdtempSync(join(tmpdir(), 'fira-'));
    prepareFira(pub);
    for (const f of FIRA_MANIFEST) expect(existsSync(join(pub, f)), f).toBe(true);
  });
});

describe('FiraSticker props', () => {
  it('false and undefined are off; true gives the defaults', () => {
    expect(resolveFira(undefined)).toBeNull();
    expect(resolveFira(false)).toBeNull();
    const d = resolveFira(true)!;
    expect(d).toMatchObject({ emotion: FIRA_DEFAULT.emotion, accessory: FIRA_DEFAULT.accessory, position: FIRA_DEFAULT.position, size: FIRA_DEFAULT.size, bubble: '' });
    expect(d.file).toBe('fira/happy-base.png');
  });

  it('overrides apply, unknown values and silly sizes fall back', () => {
    const r = resolveFira({ emotion: 'thinking', accessory: 'glasses', position: 'bottom-left', size: 420, bubble: 'Привет\nвторая строка' })!;
    expect(r).toMatchObject({ file: 'fira/thinking-glasses.png', position: 'bottom-left', size: 420, bubble: 'Привет' });
    expect(resolveFira({ emotion: 'nope' as never, size: 5 })!).toMatchObject({ emotion: 'happy', size: 300 });
  });

  it('the bubble is one short line cut at a word', () => {
    const long = 'Клиент пишет в два часа ночи, вы спите, а заявка остывает и уходит к конкурентам быстрее, чем вы проснётесь';
    const b = shortBubble(long);
    expect(b.length).toBeLessThanOrEqual(70);
    expect(b.endsWith('…')).toBe(true);
    expect(long.startsWith(b.slice(0, -1))).toBe(true);
    expect(shortBubble('')).toBe('');
  });

  it('buildProps turns the sticker on by default with the caption as the bubble, and off with fira: false', async () => {
    const opts = { tts: null, dir: mkdtempSync(join(tmpdir(), 'fira-props-')), rel: 'jobs/f' };
    const on = await buildProps(SAMPLE_SCRIPT, opts);
    expect(on.props.brand?.fira).toEqual({ bubble: SAMPLE_SCRIPT.caption });
    expect(JSON.parse(JSON.stringify(on.props)).brand).toEqual(on.props.brand); // survives the input-props round trip
    const off = await buildProps(SAMPLE_SCRIPT, { ...opts, fira: false });
    expect(off.props.brand).toBeUndefined();
    const custom = await buildProps(SAMPLE_SCRIPT, { ...opts, fira: { accessory: 'laptop', position: 'bottom-right' } });
    expect(custom.props.brand?.fira).toEqual({ accessory: 'laptop', position: 'bottom-right' });
  });
});
