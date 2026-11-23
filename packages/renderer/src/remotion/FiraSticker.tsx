import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BRAND } from '../brand.js';
import { resolveFira, type FiraBrand } from '../fira-spec.js';
import { FONT_BODY } from './fonts.js';

/** Instagram covers the top ~220 px and the bottom ~380 px of a reel; the sticker sits inside the safe zone. */
const EDGE = 60;
const TOP = 250;
const BOTTOM = 400;

/**
 * Fira in a corner of the frame: springs in (a little overshoot), then breathes. With a bubble text, a speech bubble
 * pops in a moment later next to her. Renders nothing when `brand` is off.
 */
export const FiraSticker = ({ brand, delay = 0 }: { brand: FiraBrand | undefined; delay?: number }) => {
  const frame = useCurrentFrame() - delay;
  const { fps } = useVideoConfig();
  const f = resolveFira(brand);
  if (!f || frame < 0) return null;
  const pop = spring({ frame, fps, config: { damping: 11, stiffness: 140, mass: 0.8 } });
  const bubblePop = spring({ frame: frame - 10, fps, config: { damping: 16, stiffness: 180 } });
  const breathe = 1 + Math.sin(frame / 14) * 0.012;
  const right = f.position.endsWith('right');
  const top = f.position.startsWith('top');
  const bubbleW = 520;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute', width: f.size, height: f.size, [right ? 'right' : 'left']: EDGE, [top ? 'top' : 'bottom']: top ? TOP : BOTTOM,
          transform: `translateY(${(1 - pop) * 120}px) scale(${pop * breathe})`, transformOrigin: top ? 'top center' : 'bottom center', opacity: interpolate(pop, [0, 0.3], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      >
        <Img src={staticFile(f.file)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>
      {f.bubble ? (
        <div
          style={{
            position: 'absolute', width: bubbleW, [right ? 'right' : 'left']: EDGE, [top ? 'top' : 'bottom']: (top ? TOP : BOTTOM) + f.size + 4,
            padding: '22px 30px', borderRadius: 34, background: BRAND.fg, color: BRAND.bg, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 38, lineHeight: 1.22,
            opacity: bubblePop, transform: `scale(${0.85 + bubblePop * 0.15})`, transformOrigin: `${right ? 'right' : 'left'} ${top ? 'top' : 'bottom'}`,
          }}
        >
          {f.bubble}
          <div style={{ position: 'absolute', [top ? 'top' : 'bottom']: -14, [right ? 'right' : 'left']: f.size * 0.4, width: 28, height: 28, background: BRAND.fg, transform: 'rotate(45deg)' }} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
