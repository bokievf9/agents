import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProps } from '../src/job.js';
import { SFX, SFX_DIR, SFX_GAIN_DB, SFX_MIN_GAP_SECONDS, SFX_VOLUME, planSfx, sfxAvailable } from '../src/sfx.js';
import { buildTimeline } from '../src/timing.js';
import { wavSeconds } from '../src/wav.js';

const timeline = (scenes = 5, durationSec = 30) => buildTimeline(Array.from({ length: scenes }, () => ({ voiceSec: 3 })), 2.5, durationSec);

describe('sound effect layer: the plan', () => {
  it('whoosh on every scene change, pop on every text, one hit on the final card', () => {
    const t = timeline();
    const cues = planSfx(t);
    const cta = t.segments.find((s) => s.kind === 'cta')!;
    const hits = cues.filter((c) => c.kind === 'hit');
    expect(hits).toHaveLength(1);
    expect(Math.abs(hits[0]!.startFrame - cta.startFrame)).toBeLessThanOrEqual(1); // its loudest moment is on the card
    const scenes = t.segments.filter((s) => s.kind === 'scene');
    const whooshes = cues.filter((c) => c.kind === 'whoosh');
    expect(whooshes).toHaveLength(scenes.length); // hook -> scene 1, and every later scene
    const cuts = scenes.map((s, i) => (i === 0 ? t.hookFrames : s.startFrame));
    cuts.forEach((cut, i) => expect(Math.abs(whooshes[i]!.startFrame + Math.round(SFX.whoosh.peakSec * t.fps) - cut)).toBeLessThanOrEqual(1));
    expect(cues.filter((c) => c.kind === 'pop')).toHaveLength(scenes.length + 1); // the hook and every scene text
    expect(cues.every((c) => c.file === SFX[c.kind].file)).toBe(true);
  });

  it('no two effects start closer than 250 ms, whatever the timeline', () => {
    for (const [scenes, dur] of [[4, 20], [7, 40], [2, 15], [7, 15]] as const) {
      const t = timeline(scenes, dur);
      const cues = planSfx(t);
      const min = Math.ceil(SFX_MIN_GAP_SECONDS * t.fps);
      for (let i = 1; i < cues.length; i++) expect(cues[i]!.startFrame - cues[i - 1]!.startFrame, `${scenes} scenes ${dur}s`).toBeGreaterThanOrEqual(min);
      expect(cues.every((c) => c.startFrame >= 0 && c.startFrame + c.durationFrames <= t.totalFrames)).toBe(true);
    }
  });

  it('mixes at -14 dB, in time order', () => {
    expect(SFX_GAIN_DB).toBe(-14);
    expect(SFX_VOLUME).toBeCloseTo(0.1995, 3);
    const cues = planSfx(timeline());
    expect(cues.every((c) => c.volume === SFX_VOLUME)).toBe(true);
    expect(cues.map((c) => c.startFrame)).toEqual([...cues.map((c) => c.startFrame)].sort((a, b) => a - b));
  });

  it('a hit wins over a whoosh that would sit within 250 ms of it', () => {
    // a timeline whose last scene ends right at the card: the cut into the card has no whoosh, only the hit
    const t = timeline(3, 20);
    const cta = t.segments.find((s) => s.kind === 'cta')!;
    expect(planSfx(t).filter((c) => Math.abs(c.startFrame - cta.startFrame) < 8).map((c) => c.kind)).toEqual(['hit']);
  });
});

describe('sound effect layer: the render job flag', () => {
  const script = { title: 't', hook: 'Привет', durationSec: 24, scenes: [{ voice: 'Первая сцена.', subtitle: 'Раз' }, { voice: 'Вторая сцена.', subtitle: 'Два' }, { voice: 'Третья сцена.', subtitle: 'Три' }], cta: 'firtech.pro', lang: 'ru' as const };
  const opts = { tts: null, dir: mkdtempSync(join(tmpdir(), 'sfx-')), rel: 'jobs/x' };

  it('props carry the cues by default and none with sfx: false', async () => {
    const on = await buildProps(script, opts);
    expect(on.props.sfx!.length).toBeGreaterThan(4);
    expect(JSON.parse(JSON.stringify(on.props)).sfx).toHaveLength(on.props.sfx!.length); // survives the input-props round trip
    const off = await buildProps(script, { ...opts, sfx: false });
    expect(off.props.sfx).toEqual([]);
  });
});

describe('the effect files', () => {
  const files = readdirSync(SFX_DIR).filter((f) => f.endsWith('.wav'));

  it('twelve 48 kHz mono WAV files, under 1 MB together, credited with their earshot ids', () => {
    expect(files).toHaveLength(12);
    expect(sfxAvailable()).toBe(true);
    const total = files.reduce((s, f) => s + statSync(join(SFX_DIR, f)).size, 0);
    expect(total).toBeLessThan(1_000_000);
    const credits = readFileSync(join(SFX_DIR, 'CREDITS.md'), 'utf8');
    expect(credits).toContain('earshot 0.4.1');
    expect(credits).toContain('MIT');
    for (const f of files) {
      const buf = readFileSync(join(SFX_DIR, f));
      expect(buf.toString('ascii', 0, 4), f).toBe('RIFF');
      expect(buf.readUInt16LE(22), `${f} channels`).toBe(1);
      expect(buf.readUInt32LE(24), `${f} rate`).toBe(48000);
      expect(credits, f).toContain(`\`${f}\``);
    }
    for (const id of ['ui_pop/soft', 'ui_pop/step', 'knock/wood', 'cut_hit/kick', 'cut_hit/punch', 'whoosh_fast/whip', 'swish/bright', 'riser/dark', 'notify/mid_tine', 'shutter/snap', 'mallet/glock', 'glitch/burst']) expect(credits).toContain(`\`${id}\``);
  });

  it('the durations in the table match the files', () => {
    for (const s of Object.values(SFX)) {
      expect(existsSync(join(SFX_DIR, s.file)), s.file).toBe(true);
      expect(Math.abs(wavSeconds(readFileSync(join(SFX_DIR, s.file))) - s.seconds), s.file).toBeLessThan(0.01);
    }
  });
});
