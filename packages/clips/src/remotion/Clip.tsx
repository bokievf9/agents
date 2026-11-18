import React from 'react';
import { AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ClipScript } from '../schema';
import { THEMES, type Theme } from '../theme';
import { chunkLines, musicVolume, wordTimings, type Segment, type Timeline } from '../timing';
import { fontFamily } from './fonts';

export type ClipProps = {
  script: ClipScript;
  timeline: Timeline;
  /** Files copied into the public dir by the CLI, keyed by scene index; absent in Studio preview. */
  assets?: { voices?: (string | null)[]; ctaVoice?: string | null; images?: (string | null)[]; music?: string | null };
};

const HOOK_FRAMES = 48;

const Progress: React.FC<{ theme: Theme; total: number }> = ({ theme, total }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 10, background: theme.surface }}>
      <div style={{ width: `${Math.min(100, (frame / total) * 100)}%`, height: '100%', background: theme.accent }} />
    </div>
  );
};

const Subtitle: React.FC<{ text: string; voiceFrames: number; theme: Theme }> = ({ text, voiceFrames, theme }) => {
  const frame = useCurrentFrame();
  const lines = chunkLines(wordTimings(text, voiceFrames));
  // Show the line that holds the currently spoken word.
  const current = lines.findIndex((l, i) => frame >= l[0]!.startFrame && (i === lines.length - 1 || frame < lines[i + 1]![0]!.startFrame));
  const line = lines[Math.max(0, current)] ?? [];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0 22px', fontSize: 84, fontWeight: 800, lineHeight: 1.15, textAlign: 'center' }}>
      {line.map((w, i) => (
        <span key={`${w.word}-${i}`} style={{ color: frame >= w.startFrame ? theme.accent : theme.text, opacity: frame >= w.startFrame ? 1 : 0.55 }}>
          {w.word}
        </span>
      ))}
    </div>
  );
};

const Scene: React.FC<{ seg: Segment; subtitle: string; image?: string | null; voice?: string | null; theme: Theme }> = ({ seg, subtitle, image, voice, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 14 });
  return (
    <AbsoluteFill style={{ padding: '0 72px', justifyContent: 'center', alignItems: 'center', opacity: pop }}>
      {voice ? <Audio src={staticFile(voice)} /> : null}
      {image ? (
        <div style={{ width: 936, height: 900, marginBottom: 80, borderRadius: 28, background: theme.surface, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Img src={staticFile(image)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
      ) : null}
      <div style={{ position: image ? 'relative' : 'absolute', top: image ? undefined : 1080 }}>
        <Subtitle text={subtitle} voiceFrames={seg.voiceFrames} theme={theme} />
      </div>
    </AbsoluteFill>
  );
};

const Hook: React.FC<{ text: string; theme: Theme }> = ({ text, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 160 } });
  const out = interpolate(frame, [HOOK_FRAMES - 10, HOOK_FRAMES], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: theme.bg, justifyContent: 'center', padding: '0 72px', opacity: out }}>
      <div style={{ width: 120, height: 10, background: theme.accent, marginBottom: 56, transform: `scaleX(${enter})`, transformOrigin: 'left' }} />
      <div style={{ fontSize: 112, fontWeight: 800, lineHeight: 1.08, color: theme.text, transform: `translateY(${(1 - enter) * 60}px)`, opacity: enter }}>{text}</div>
    </AbsoluteFill>
  );
};

const EndCard: React.FC<{ cta: string; voice?: string | null; theme: Theme }> = ({ cta, voice, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  return (
    <AbsoluteFill style={{ background: theme.bg, justifyContent: 'center', alignItems: 'center', padding: '0 72px', opacity: enter }}>
      {voice ? <Audio src={staticFile(voice)} /> : null}
      <div style={{ fontSize: 60, fontWeight: 500, color: theme.muted, textAlign: 'center', lineHeight: 1.25, marginBottom: 70 }}>{cta.replace(/\s*Ссылка:\s*firtech\.pro\.?$/i, '')}</div>
      <div style={{ fontSize: 120, fontWeight: 800, color: theme.accentText, background: theme.accent, padding: '24px 56px', borderRadius: 32 }}>firtech.pro</div>
      <div style={{ marginTop: 56, fontSize: 40, fontWeight: 500, color: theme.muted }}>Fir Tech</div>
    </AbsoluteFill>
  );
};

export const Clip: React.FC<ClipProps> = ({ script, timeline, assets }) => {
  const theme = THEMES[script.theme];
  const hookSeg = timeline.segments[0];
  return (
    <AbsoluteFill style={{ background: theme.bg, fontFamily, color: theme.text }}>
      {timeline.segments.map((seg) =>
        seg.kind === 'scene' ? (
          <Sequence key={seg.index} from={seg.startFrame} durationInFrames={seg.durationFrames}>
            <Scene seg={seg} subtitle={script.scenes[seg.index]!.subtitle} image={assets?.images?.[seg.index]} voice={assets?.voices?.[seg.index]} theme={theme} />
          </Sequence>
        ) : (
          <Sequence key="cta" from={seg.startFrame} durationInFrames={seg.durationFrames}>
            <EndCard cta={script.cta} voice={assets?.ctaVoice} theme={theme} />
          </Sequence>
        ),
      )}
      {hookSeg ? (
        <Sequence from={0} durationInFrames={HOOK_FRAMES}>
          <Hook text={script.hook} theme={theme} />
        </Sequence>
      ) : null}
      {assets?.music ? <Audio src={staticFile(assets.music)} loop volume={(f) => musicVolume(f, timeline)} /> : null}
      <Progress theme={theme} total={timeline.totalFrames} />
    </AbsoluteFill>
  );
};
