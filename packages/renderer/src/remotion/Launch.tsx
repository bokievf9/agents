import { AbsoluteFill, Audio, Easing, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BRAND, WORDMARK } from '../brand.js';
import { COPY, type Lang, type ProductId } from '../launch/copy.js';
import { VOICE_OFFSET, WHIP, beatsOf, musicGain, planLaunchSfx, totalFramesOf, voiceRoom, type Beat, type LaunchProps, type Variant } from '../launch/plan.js';
import { estimateVoiceSec } from '../timing.js';
import { phraseAt, timePhrases } from '../subtitles.js';
import { FONT_BODY, FONT_TITLE, loadBrandFonts } from './fonts.js';
import { Anim, Bubble, Card, CARD_W, Dot, ProductMock, Typing, useIn } from './launch-ui.js';
import { PixelOffice } from './launch-office.js';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const SAFE_TOP = 230;
/** Top of the content block (titles and mocks) and of the captions band. */
const CONTENT_TOP = 330;
const CAPTION_TOP = 1330;

const Background = ({ total }: { total: number }) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  return (
    <AbsoluteFill style={{ background: BRAND.bg, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: -300 + Math.sin(t * 0.4) * 60, top: 1150, width: 1000, height: 1000, borderRadius: '50%', background: `radial-gradient(circle, ${BRAND.accent}26 0%, transparent 65%)` }} />
      <div style={{ position: 'absolute', left: 500 + Math.cos(t * 0.3) * 60, top: -200, width: 900, height: 900, borderRadius: '50%', background: `radial-gradient(circle, ${BRAND.accent}14 0%, transparent 65%)` }} />
      {Array.from({ length: 10 }, (_, i) => <div key={i} style={{ position: 'absolute', left: i * 120 - 10, top: 0, width: 2, height: 1920, background: '#ffffff07' }} />)}
      <div style={{ position: 'absolute', left: 0, top: 0, height: 8, width: `${Math.min(100, (frame / total) * 100)}%`, background: BRAND.accent }} />
    </AbsoluteFill>
  );
};

export const Logo = ({ size = 40 }: { size?: number }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.45, fontFamily: FONT_TITLE, fontWeight: 700, fontSize: size, color: BRAND.fg }}>
    <div style={{ width: size * 0.55, height: size * 0.55, borderRadius: '50%', background: BRAND.accent }} />
    {WORDMARK}
  </div>
);

/** A beat arrives with a whip (fast slide from the right, blur and skew) and leaves the same way to the left. */
const BeatShell = ({ children, first = false }: { children: React.ReactNode; first?: boolean }) => {
  const f = useCurrentFrame();
  const { durationInFrames: d } = useVideoConfig();
  const inP = first ? 1 : interpolate(f, [0, 8], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const outP = interpolate(f, [d - WHIP, d], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  const x = (1 - inP) * 1150 - outP * 1150;
  const blur = (1 - inP) * 26 + outP * 20;
  return (
    <AbsoluteFill style={{ transform: `translateX(${x}px) skewX(${(1 - inP) * -7 + outP * 7}deg)`, filter: blur > 0.5 ? `blur(${blur}px)` : undefined }}>{children}</AbsoluteFill>
  );
};

/** Kinetic title: words spring up one after another; a lime bar wipes in under it. */
const Title = ({ text, at, size }: { text: string; at: number; size?: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  const longest = Math.max(...words.map((w) => w.length), 1);
  const fs = size ?? Math.max(54, Math.min(words.length > 1 ? 92 : 108, Math.floor(900 / (longest * 0.86))));
  const bar = useIn(at + 6, 20, 120);
  return (
    <div style={{ padding: '0 80px', height: 250, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 26px', fontFamily: FONT_TITLE, fontWeight: 700, fontSize: fs, lineHeight: 1.12, color: BRAND.fg }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - at - i * 4, fps, config: { damping: 15, stiffness: 180 } });
          return <span key={i} style={{ display: 'inline-block', whiteSpace: 'nowrap', opacity: Math.min(1, s * 1.4), transform: `translateY(${(1 - s) * 70}px)` }}>{w}</span>;
        })}
      </div>
      <div style={{ width: 150, height: 12, background: BRAND.accent, marginTop: 26, transform: `scaleX(${bar})`, transformOrigin: 'left' }} />
    </div>
  );
};

const Captions = ({ text, frames, lang, offset }: { text: string; frames: number; lang: Lang; offset: number }) => {
  const frame = useCurrentFrame() - offset;
  const { fps } = useVideoConfig();
  void lang;
  const phrases = timePhrases(text, frames);
  const p = phraseAt(phrases, frame);
  if (!p || frame < 0 || frame > frames + 10) return null;
  const pop = spring({ frame: frame - p.startFrame, fps, config: { damping: 20, stiffness: 220 }, durationInFrames: 10 });
  return (
    <AbsoluteFill style={{ top: CAPTION_TOP, height: 220, padding: '0 70px', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0 16px', padding: '22px 36px', borderRadius: 34, background: 'rgba(10,13,11,0.88)', border: `3px solid ${BRAND.accent}33`, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 56, lineHeight: 1.2, textAlign: 'center', transform: `scale(${0.95 + pop * 0.05})`, opacity: pop }}>
        {p.words.map((w, i) => <span key={i} style={{ color: frame >= w.startFrame ? BRAND.accent : BRAND.fg }}>{w.text}</span>)}
      </div>
    </AbsoluteFill>
  );
};

// ---- beats ---------------------------------------------------------------------------------------------------------

const HookBeat = ({ lang }: { lang: Lang }) => {
  const h = COPY[lang].hook;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const big = spring({ frame, fps, config: { damping: 11, stiffness: 160 } });
  const out = interpolate(frame, [76, 90], [0, 1], clamp);
  const word = (t: string, at: number, color: string, size: number) => {
    const s = spring({ frame: frame - at, fps, config: { damping: 15, stiffness: 180 } });
    return <div style={{ fontFamily: FONT_TITLE, fontWeight: 700, fontSize: size, color, opacity: Math.min(1, s * 1.4), transform: `translateY(${(1 - s) * 80}px)`, lineHeight: 1.15 }}>{t}</div>;
  };
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingBottom: 200, transform: `scale(${1 + out * 0.04})` }}>
      <div style={{ fontFamily: FONT_TITLE, fontWeight: 700, fontSize: 330, color: BRAND.accent, letterSpacing: -8, transform: `scale(${0.82 + big * 0.18})`, textShadow: `0 0 120px ${BRAND.accent}66`, lineHeight: 1 }}>{h.big}</div>
      <div style={{ height: 24 }} />
      {word(h.l1, 10, BRAND.fg, 92)}
      {word(h.l2, 15, BRAND.fg, h.l2.length > 16 ? 68 : 92)}
    </AbsoluteFill>
  );
};

const ProblemBeat = ({ lang }: { lang: Lang }) => {
  const p = COPY[lang].problem;
  const frame = useCurrentFrame();
  const colors = [BRAND.muted, BRAND.fg, BRAND.accent];
  const unread = useIn(WHIP + 30, 14, 200);
  return (
    <AbsoluteFill style={{ top: CONTENT_TOP, padding: '0 100px' }}>
      <Card style={{ width: CARD_W - 40, padding: 36 }}>
        <Bubble text={p.chat} side="r" at={WHIP + 8} w={620} />
        <Typing from={WHIP + 24} to={WHIP + 400} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, color: BRAND.muted, fontSize: 34, opacity: unread }}><Dot color="#ff6b5e" size={20} />{p.unread}</div>
      </Card>
      <div style={{ marginTop: 70, display: 'flex', flexDirection: 'column', gap: 26 }}>
        {p.lines.map((l, i) => (
          <Anim key={i} at={WHIP + [8, 40, 72][i]! + 0} d={15} k={180}>
            {(s) => <div style={{ fontFamily: FONT_TITLE, fontWeight: 700, fontSize: lang === 'ru' ? 62 : 58, lineHeight: 1.15, color: colors[i], opacity: Math.min(1, s * 1.4), transform: `translateX(${(1 - s) * -120}px)` }}>{l}</div>}
          </Anim>
        ))}
      </div>
      {frame > 0 ? null : null}
    </AbsoluteFill>
  );
};

const ProductBeat = ({ id, lang }: { id: ProductId; lang: Lang }) => (
  <AbsoluteFill>
    <div style={{ position: 'absolute', left: 0, right: 0, top: CONTENT_TOP - 70 }}><Title text={COPY[lang].title[id]} at={WHIP + 8} /></div>
    <div style={{ position: 'absolute', left: (1080 - CARD_W) / 2, top: CONTENT_TOP + 230, height: 760, display: 'flex' }}><ProductMock id={id} lang={lang} /></div>
  </AbsoluteFill>
);

const OfficeBeat = ({ lang }: { lang: Lang }) => {
  const o = COPY[lang].office;
  const frame = useCurrentFrame();
  const s = useIn(WHIP, 20, 110);
  const push = interpolate(frame, [0, 150], [1, 1.035]);
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, top: CONTENT_TOP - 70 }}><Title text={o.title} at={WHIP + 8} /></div>
      <div style={{ position: 'absolute', left: 80, top: CONTENT_TOP + 215, opacity: Math.min(1, s * 2), transform: `scale(${(0.9 + s * 0.1) * push})` }}><PixelOffice label={o.label} tag="24/7" /></div>
    </AbsoluteFill>
  );
};

const CtaBeat = ({ lang }: { lang: Lang }) => {
  const c = COPY[lang].cta;
  const frame = useCurrentFrame();
  const logo = useIn(WHIP + 12, 11, 150);
  const btn = useIn(WHIP + 34, 14, 170);
  const pulse = 1 + Math.sin(frame / 6) * 0.014;
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, top: CONTENT_TOP + 140, display: 'flex', justifyContent: 'center', opacity: Math.min(1, logo * 2), transform: `scale(${0.5 + logo * 0.5})` }}>
        <Logo size={120} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: CONTENT_TOP + 400, display: 'flex', justifyContent: 'center' }}>
        <div style={{ background: BRAND.accent, color: BRAND.bg, fontFamily: FONT_TITLE, fontWeight: 700, fontSize: lang === 'ru' ? 46 : 52, padding: '44px 48px', borderRadius: 44, textAlign: 'center', lineHeight: 1.2, whiteSpace: 'nowrap', opacity: Math.min(1, btn * 2), transform: `scale(${(0.7 + btn * 0.3) * pulse})`, boxShadow: `0 0 100px ${BRAND.accent}55` }}>{c.button}</div>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: CONTENT_TOP + 600, textAlign: 'center', fontFamily: FONT_TITLE, fontWeight: 700, fontSize: 74, color: BRAND.fg, opacity: Math.min(1, btn * 2) }}>{c.url}</div>
      <div style={{ position: 'absolute', left: 60, right: 60, top: CONTENT_TOP + 740, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 20 }}>
        {c.chips.map((t, i) => (
          <Anim key={t} at={WHIP + 48 + i * 6} d={14} k={200}>
            {(s) => <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 38, padding: '18px 34px', borderRadius: 34, border: `3px solid ${BRAND.accent}`, color: BRAND.fg, background: '#111512', opacity: Math.min(1, s * 2), transform: `scale(${0.8 + s * 0.2})` }}>{t}</div>}
          </Anim>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const BeatBody = ({ beat, lang }: { beat: Beat; lang: Lang }) => {
  switch (beat.kind) {
    case 'hook': return <HookBeat lang={lang} />;
    case 'problem': return <ProblemBeat lang={lang} />;
    case 'product': return <ProductBeat id={beat.id as ProductId} lang={lang} />;
    case 'office': return <OfficeBeat lang={lang} />;
    case 'cta': return <CtaBeat lang={lang} />;
  }
};

// ---- the film ------------------------------------------------------------------------------------------------------

const LaunchFilm = ({ variant, ...p }: LaunchProps & { variant: Variant }) => {
  loadBrandFonts();
  const beats = beatsOf(variant);
  const total = totalFramesOf(variant);
  const cues = p.sfx ? planLaunchSfx(variant) : [];
  // voice windows: from the audio files, or estimated from the text when there is no voice
  const windows = beats.map((b) => {
    const text = p.vo[b.vo] ?? COPY[p.lang].vo[b.vo];
    const v = p.voice[b.id];
    const frames = v ? v.frames : Math.min(voiceRoom(b), Math.ceil(estimateVoiceSec(text) * 30));
    const start = b.start + VOICE_OFFSET[b.kind];
    return { b, text, v, frames, start };
  });
  const duck: [number, number][] = windows.map((w) => [w.start, w.start + w.frames]);
  return (
    <AbsoluteFill style={{ fontFamily: FONT_BODY, color: BRAND.fg }}>
      <Background total={total} />
      {beats.map((b, i) => (
        <Sequence key={b.id} from={Math.max(0, b.start - (i === 0 ? 0 : WHIP))} durationInFrames={b.dur + (i === 0 ? 0 : WHIP)}>
          <BeatShell first={i === 0}><BeatBody beat={b} lang={p.lang} /></BeatShell>
        </Sequence>
      ))}
      {p.captions
        ? windows.map(({ b, text, frames, start }) => (
            <Sequence key={`c${b.id}`} from={start} durationInFrames={frames + 12}>
              <Captions text={text} frames={frames} lang={p.lang} offset={0} />
            </Sequence>
          ))
        : null}
      {windows.map(({ b, v, start, frames }) =>
        v ? (
          <Sequence key={`v${b.id}`} from={start} durationInFrames={Math.min(frames + 2, total - start)}>
            <Audio src={staticFile(v.src)} />
          </Sequence>
        ) : null,
      )}
      {cues.map((c, i) => (
        <Sequence key={`s${i}`} from={c.startFrame} durationInFrames={c.durationFrames}>
          <Audio src={staticFile(`sfx/${c.file}`)} volume={c.volume} playbackRate={c.rate} />
        </Sequence>
      ))}
      {p.musicPath ? <Audio src={staticFile(p.musicPath)} loop volume={(f) => musicGain(f, total, duck, p.musicVolume)} /> : null}
      <div style={{ position: 'absolute', top: SAFE_TOP - 110, left: 80 }}><Logo /></div>
    </AbsoluteFill>
  );
};

export const LaunchFilmComposition = (p: LaunchProps) => <LaunchFilm variant="film" {...p} />;
export const LaunchTeaserComposition = (p: LaunchProps) => <LaunchFilm variant="teaser" {...p} />;
