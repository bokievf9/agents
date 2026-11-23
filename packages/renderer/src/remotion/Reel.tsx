import { AbsoluteFill, Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BRAND, CTA_CARD, WORDMARK } from '../brand.js';
import type { ReelProps } from '../props.js';
import { phraseAt, timePhrases } from '../subtitles.js';
import { VOICE_PAD_SECONDS, type Segment } from '../timing.js';
import { FiraSticker } from './FiraSticker.js';
import { FONT_BODY, FONT_TITLE, loadBrandFonts } from './fonts.js';

/** Instagram covers the top ~220 px and the bottom ~380 px with its own UI: text stays between them. */
const SAFE_TOP = 230;

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** Slow drifting rings and dots: the only decoration (no stock footage, no faces, no photos). */
const Background = ({ total }: { total: number }) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const ring = (cx: number, cy: number, r: number, speed: number, phase: number, o: number) => (
    <div
      style={{
        position: 'absolute', left: cx + Math.sin(t * speed + phase) * 90 - r, top: cy + Math.cos(t * speed * 0.8 + phase) * 120 - r,
        width: r * 2, height: r * 2, borderRadius: '50%', border: `6px solid ${BRAND.accent}`, opacity: o,
      }}
    />
  );
  const dots = Array.from({ length: 18 }, (_, i) => {
    const x = (i * 197) % 1080;
    const y = ((i * 331 + t * (30 + (i % 5) * 12)) % 2100) - 90;
    return <div key={i} style={{ position: 'absolute', left: x, top: 2000 - y - 100, width: 10, height: 10, borderRadius: 5, background: BRAND.accent, opacity: 0.08 + (i % 4) * 0.04 }} />;
  });
  return (
    <AbsoluteFill style={{ background: BRAND.bg, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: -300, top: 1100, width: 900, height: 900, borderRadius: '50%', background: `radial-gradient(circle, ${BRAND.accent}22 0%, transparent 65%)` }} />
      {ring(900, 420, 260, 0.35, 0, 0.1)}
      {ring(150, 1500, 180, 0.5, 2, 0.08)}
      {ring(820, 1450, 90, 0.7, 4, 0.12)}
      {dots}
      <div style={{ position: 'absolute', left: 0, top: 0, height: 8, width: `${Math.min(100, (frame / total) * 100)}%`, background: BRAND.accent }} />
    </AbsoluteFill>
  );
};

const Wordmark = ({ size = 40 }: { size?: number }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.45, fontFamily: FONT_TITLE, fontWeight: 700, fontSize: size, color: BRAND.fg }}>
    <div style={{ width: size * 0.55, height: size * 0.55, borderRadius: '50%', background: BRAND.accent }} />
    {WORDMARK}
  </div>
);

const Hook = ({ text, frames }: { text: string; frames: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bar = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const out = interpolate(frame, [frames - 10, frames], [1, 0], clamp);
  const words = text.split(/\s+/);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: '0 80px', opacity: out, transform: `translateY(${(1 - out) * -40}px)` }}>
      <div style={{ width: 140, height: 12, background: BRAND.accent, marginBottom: 60, transform: `scaleX(${bar})`, transformOrigin: 'left' }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 28px', fontFamily: FONT_TITLE, fontWeight: 700, fontSize: words.join(' ').length > 40 ? 88 : 104, lineHeight: 1.14, color: BRAND.fg }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - 4 - i * 3, fps, config: { damping: 16, stiffness: 170 } });
          return <span key={i} style={{ display: 'inline-block', opacity: s, transform: `translateY(${(1 - s) * 70}px) scale(${0.9 + s * 0.1})`, color: i === words.length - 1 ? BRAND.accent : BRAND.fg }}>{w}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};

/** The scene's on-screen line: words spring in, a position counter above it. */
const SceneText = ({ text, index, count, frames, delay }: { text: string; index: number; count: number; frames: number; delay: number }) => {
  const frame = useCurrentFrame() - delay;
  const { fps } = useVideoConfig();
  if (frame < 0) return null;
  const out = interpolate(frame, [frames - 8, frames], [1, 0], clamp);
  const words = text.split(/\s+/);
  return (
    <AbsoluteFill style={{ top: SAFE_TOP + 330, height: 640, padding: '0 80px', justifyContent: 'center', opacity: out }}>
      <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 40, color: BRAND.accent, letterSpacing: 4, marginBottom: 36 }}>
        {String(index + 1).padStart(2, '0')} / {String(count).padStart(2, '0')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 26px', fontFamily: FONT_TITLE, fontWeight: 700, fontSize: text.length > 28 ? 80 : 96, lineHeight: 1.16, color: BRAND.fg }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - 3 - i * 4, fps, config: { damping: 18, stiffness: 150 } });
          return <span key={i} style={{ display: 'inline-block', opacity: s, transform: `translateY(${(1 - s) * 50}px)` }}>{w}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Spoken-phrase captions in the lower third; the word being spoken is lime. */
const Captions = ({ voice, voiceFrames }: { voice: string; voiceFrames: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const phrases = timePhrases(voice, voiceFrames);
  const p = phraseAt(phrases, frame);
  if (!p || frame > voiceFrames + 12) return null;
  const pop = spring({ frame: frame - p.startFrame, fps, config: { damping: 20, stiffness: 220 }, durationInFrames: 10 });
  return (
    <AbsoluteFill style={{ top: 1290, height: 260, padding: '0 70px', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0 18px', padding: '26px 38px', borderRadius: 36, background: 'rgba(10,13,11,0.82)', border: `3px solid ${BRAND.accent}33`, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 62, lineHeight: 1.2, textAlign: 'center', transform: `scale(${0.94 + pop * 0.06})`, opacity: pop }}>
        {p.words.map((w, i) => (
          <span key={i} style={{ color: frame >= w.startFrame ? BRAND.accent : BRAND.fg }}>{w.text}</span>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Scene = ({ seg, props, index }: { seg: Segment; props: ReelProps; index: number }) => {
  const scene = props.scenes[index]!;
  // without a voice file the captions run over the scene minus the pad
  const voiceFrames = seg.voiceFrames || Math.max(1, seg.durationFrames - Math.round(VOICE_PAD_SECONDS * props.timeline.fps));
  return (
    <AbsoluteFill>
      {scene.audio ? <Audio src={staticFile(scene.audio)} /> : null}
      <SceneText text={scene.subtitle} index={index} count={props.scenes.length} frames={seg.durationFrames - (index === 0 ? props.timeline.hookFrames : 0)} delay={index === 0 ? props.timeline.hookFrames : 0} />
      <Captions voice={scene.voice} voiceFrames={voiceFrames} />
    </AbsoluteFill>
  );
};

const CtaCard = ({ cta, audio }: { cta: string; audio: string | null }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const pulse = 1 + Math.sin(frame / 7) * 0.012;
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 70px', opacity: interpolate(frame, [0, 8], [0, 1], clamp) }}>
      {audio ? <Audio src={staticFile(audio)} /> : null}
      <div style={{ opacity: s, transform: `translateY(${(1 - s) * 50}px)`, textAlign: 'center', fontFamily: FONT_BODY, fontWeight: 700, fontSize: 52, lineHeight: 1.3, color: BRAND.muted, marginBottom: 80, maxWidth: 900 }}>{cta}</div>
      <div style={{ transform: `scale(${s * pulse})`, background: BRAND.accent, color: BRAND.bg, fontFamily: FONT_TITLE, fontWeight: 700, fontSize: 44, whiteSpace: 'nowrap', padding: '44px 40px', borderRadius: 40, textAlign: 'center', lineHeight: 1.25 }}>{CTA_CARD}</div>
    </AbsoluteFill>
  );
};

export const Reel = (props: ReelProps) => {
  loadBrandFonts();
  const { timeline } = props;
  return (
    <AbsoluteFill style={{ fontFamily: FONT_BODY, color: BRAND.fg }}>
      <Background total={timeline.totalFrames} />
      {timeline.segments.map((seg) =>
        seg.kind === 'scene' ? (
          <Sequence key={seg.index} from={seg.startFrame} durationInFrames={seg.durationFrames}>
            <Scene seg={seg} props={props} index={seg.index} />
          </Sequence>
        ) : (
          <Sequence key="cta" from={seg.startFrame} durationInFrames={seg.durationFrames}>
            <CtaCard cta={props.cta} audio={props.ctaAudio} />
          </Sequence>
        ),
      )}
      {(props.sfx ?? []).map((c, i) => (
        <Sequence key={`sfx${i}`} from={c.startFrame} durationInFrames={c.durationFrames}>
          <Audio src={staticFile(`sfx/${c.file}`)} volume={c.volume} />
        </Sequence>
      ))}
      <Sequence from={0} durationInFrames={timeline.hookFrames}>
        <Hook text={props.hook} frames={timeline.hookFrames} />
      </Sequence>
      <div style={{ position: 'absolute', top: SAFE_TOP - 110, left: 80 }}><Wordmark /></div>
      <FiraSticker brand={props.brand?.fira} delay={6} />
    </AbsoluteFill>
  );
};
