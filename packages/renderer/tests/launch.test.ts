import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY, VO_IDS, launchSpeakable, parseLaunchScript } from '../src/launch/copy.js';
import { FILM_FRAMES, KEY_FRAME, LAUNCH_SFX, SFX_MIN_GAP_FRAMES, TEASER_FRAMES, VOICE_OFFSET, beatsOf, musicGain, planLaunchSfx, voiceRoom } from '../src/launch/plan.js';
import { compositionId, readLaunchScript, scriptPath } from '../src/launch/render.js';
import { SFX_DIR } from '../src/sfx.js';

const root = join(import.meta.dirname, '..');

describe('launch film: compositions and duration', () => {
  it('film is 38 s and teaser 15 s at 30 fps, beats are contiguous', () => {
    expect(FILM_FRAMES).toBe(38 * 30);
    expect(TEASER_FRAMES).toBe(15 * 30);
    for (const v of ['film', 'teaser'] as const) {
      const beats = beatsOf(v);
      beats.forEach((b, i) => expect(b.start).toBe(i === 0 ? 0 : beats[i - 1]!.start + beats[i - 1]!.dur));
      expect(beats.at(-1)!.kind).toBe('cta');
    }
  });

  it('film structure follows the study: hook 0-3, problem 3-8, seven products 8-28, office 28-33, CTA 33-38', () => {
    const b = beatsOf('film');
    expect(b.map((x) => x.kind)).toEqual(['hook', 'problem', ...Array(7).fill('product'), 'office', 'cta']);
    expect(b[1]!.start).toBe(90);
    expect(b[2]!.start).toBe(240);
    expect(b.find((x) => x.kind === 'office')!.start).toBe(840);
    expect(b.find((x) => x.kind === 'cta')!.start).toBe(990);
  });

  it('both compositions are registered in the Root with the right ids and lengths', () => {
    const root_ = readFileSync(join(root, 'src/remotion/Root.tsx'), 'utf8');
    expect(root_).toContain('id="LaunchFilm"');
    expect(root_).toContain('id="LaunchTeaser"');
    expect(root_).toContain('durationInFrames={FILM_FRAMES}');
    expect(root_).toContain('durationInFrames={TEASER_FRAMES}');
    expect(compositionId('film')).toBe('LaunchFilm');
    expect(compositionId('teaser')).toBe('LaunchTeaser');
  });

  it('the render script is wired in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['render:launch']).toContain('src/launch/render.ts');
  });
});

describe('launch film: props and copy', () => {
  it('RU and EN copy have the same shape, the only digits are 24/7', () => {
    const shape = (o: unknown): unknown => (Array.isArray(o) ? o.map(shape) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o);
    expect(shape(COPY.en)).toEqual(shape(COPY.ru));
    for (const lang of ['ru', 'en'] as const) {
      const strings: string[] = [];
      const walk = (o: unknown): void => (typeof o === 'string' ? void strings.push(o) : o && typeof o === 'object' ? Object.values(o).forEach(walk) : undefined);
      walk(COPY[lang]);
      const all = strings.join(' ').replace(/24\/7/g, '');
      expect(all, lang).not.toMatch(/\d/);
      expect(COPY[lang].cta.url).toBe('firtech.pro');
      expect(COPY[lang].cta.chips.join(' ')).toContain('USDT');
    }
    expect(COPY.ru.cta.button).toBe('Собрать проект');
    expect(COPY.ru.hook.big).toBe('24/7');
  });

  it('no long dashes in any copy or voice line', () => {
    expect(JSON.stringify(COPY)).not.toMatch(/[—–]/);
  });

  it('the voice is spoken-ready', () => {
    expect(launchSpeakable('ИИ-агенты работают 24/7. Mini App в Telegram. firtech.pro', 'ru')).toBe('и-и агенты работают двадцать четыре на семь. мини эп в телеграм. фир тек точка про');
  });
});

describe('launch film: script files', () => {
  for (const lang of ['ru', 'en'] as const) {
    it(`scripts/launch-${lang}.txt exists, has every section and matches the copy`, () => {
      expect(existsSync(scriptPath(lang))).toBe(true);
      const parsed = parseLaunchScript(readFileSync(scriptPath(lang), 'utf8'));
      for (const id of VO_IDS) expect(parsed[id], `${lang} ${id}`).toBeTruthy();
      expect(parsed).toEqual(COPY[lang].vo);
      expect(readLaunchScript(lang)).toEqual(COPY[lang].vo);
    });
  }

  it('every Russian line fits its beat: at most ~16 spoken characters per second of room (Piper denis at length-scale 0.8, measured)', () => {
    for (const v of ['film', 'teaser'] as const)
      for (const b of beatsOf(v)) {
        const chars = launchSpeakable(COPY.ru.vo[b.vo], 'ru').length;
        expect(chars, `${v} ${b.id}`).toBeLessThanOrEqual(Math.floor((voiceRoom(b) / 30) * 16.5));
      }
  });
});

describe('launch film: sound plan', () => {
  it('every cue has a file on disk', () => {
    for (const v of ['film', 'teaser'] as const) for (const c of planLaunchSfx(v)) expect(existsSync(join(SFX_DIR, c.file)), c.file).toBe(true);
    for (const s of Object.values(LAUNCH_SFX)) expect(existsSync(join(SFX_DIR, s.file)), s.file).toBe(true);
  });

  it('whoosh on cuts, kick on the cold open and CTA, riser into the CTA, mallet on the logo', () => {
    const cues = planLaunchSfx('film');
    const cta = beatsOf('film').find((b) => b.kind === 'cta')!;
    const at = (c: (typeof cues)[number]) => c.startFrame + Math.round((LAUNCH_SFX[c.kind].peak / LAUNCH_SFX[c.kind].rate) * 30);
    expect(cues.find((c) => c.kind === 'kick')!.startFrame).toBe(0);
    expect(cues.filter((c) => c.kind === 'kick')).toHaveLength(2);
    const riser = cues.find((c) => c.kind === 'riser')!;
    expect(at(riser)).toBe(cta.start - 6); // peaks just before the CTA hit
    expect(riser.rate).toBe(0.5);
    expect(cues.some((c) => c.kind === 'mallet' && c.startFrame > cta.start)).toBe(true);
    const cutsWithWhoosh = cues.filter((c) => c.kind === 'whoosh').map(at);
    for (const b of beatsOf('film').slice(1)) if (b.kind !== 'cta' && b.kind !== 'office') expect(cutsWithWhoosh).toContain(b.start + 2);
    for (const b of beatsOf('film').filter((x) => x.kind === 'product')) expect(cues.some((c) => c.kind === 'tap' && at(c) === b.start + KEY_FRAME)).toBe(true);
  });

  it('effects never start closer than 250 ms (the riser excepted) and stay inside the film', () => {
    for (const v of ['film', 'teaser'] as const) {
      const cues = planLaunchSfx(v).filter((c) => c.kind !== 'riser');
      for (let i = 1; i < cues.length; i++) expect(cues[i]!.startFrame - cues[i - 1]!.startFrame, v).toBeGreaterThanOrEqual(SFX_MIN_GAP_FRAMES);
      const total = v === 'film' ? FILM_FRAMES : TEASER_FRAMES;
      expect(planLaunchSfx(v).every((c) => c.startFrame >= 0 && c.startFrame + c.durationFrames <= total)).toBe(true);
    }
  });

  it('music ducks under the voice, fades in and out, and is silent at base 0', () => {
    const duck: [number, number][] = [[100, 200]];
    expect(musicGain(150, 1140, duck, 0.4)).toBeCloseTo(0.4 * 0.45, 3);
    expect(musicGain(500, 1140, duck, 0.4)).toBeCloseTo(0.4, 3);
    expect(musicGain(0, 1140, duck, 0.4)).toBe(0);
    expect(musicGain(1139, 1140, duck, 0.4)).toBeLessThan(0.02);
    expect(musicGain(150, 1140, duck, 0)).toBe(0);
  });

  it('voice starts after the whip', () => {
    for (const k of Object.values(VOICE_OFFSET)) expect(k).toBeGreaterThanOrEqual(10);
  });
});
