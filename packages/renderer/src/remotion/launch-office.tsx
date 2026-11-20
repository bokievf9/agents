import { interpolate, useCurrentFrame } from 'remotion';
import { BRAND } from '../brand.js';

/** The live office as a pixel illustration drawn in code: desks, monitors, pixel people at work, a walker, sun through the windows. */
const U = 9; // one pixel of a sprite
type R = [x: number, y: number, w: number, h: number, color: string];

const Sprite = ({ x, y, rects, scale = 1 }: { x: number; y: number; rects: R[]; scale?: number }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
    {rects.map(([rx, ry, w, h, c], i) => <div key={i} style={{ position: 'absolute', left: rx * U, top: ry * U, width: w * U, height: h * U, background: c }} />)}
  </div>
);

const SKIN = ['#f1c9a0', '#d9a577', '#a9744d', '#f6d8b8'];
const HAIR = ['#2b2118', '#6b3f1d', '#c9a24a', '#15110d'];
const SHIRT = [BRAND.accent, '#6fd3b0', '#e4f7b5', '#8fbf4d', '#ffffff', '#4f9d6b'];

/** A seated worker facing the monitor: head, body, two arms that type. `t` is the frame, `busy` makes the hands move. */
const Worker = ({ x, y, look, t, busy }: { x: number; y: number; look: number; t: number; busy: boolean }) => {
  const k = busy ? Math.floor(t / 3) % 2 : 0;
  const r: R[] = [
    [2, 0, 6, 2, HAIR[look % 4]!], [2, 2, 6, 5, SKIN[look % 4]!], [3, 3, 1, 1, '#1b1b1b'], [6, 3, 1, 1, '#1b1b1b'], [2, 2, 1, 2, HAIR[look % 4]!],
    [0, 7, 10, 6, SHIRT[look % 6]!], [-1, 12 + k, 3, 2, SKIN[look % 4]!], [8, 12 + (1 - k), 3, 2, SKIN[look % 4]!],
  ];
  return <Sprite x={x} y={y} rects={r} />;
};

const Walker = ({ x, y, t }: { x: number; y: number; t: number }) => {
  const step = Math.floor(t / 4) % 2;
  const r: R[] = [
    [2, 0, 6, 2, HAIR[1]!], [2, 2, 6, 5, SKIN[2]!], [3, 3, 1, 1, '#1b1b1b'], [6, 3, 1, 1, '#1b1b1b'],
    [1, 7, 8, 7, '#ffffff'], [-1, 8 + step, 2, 5, SKIN[2]!], [9, 8 + (1 - step), 2, 5, SKIN[2]!],
    [2, 14, 3, 5 - step, '#26332a'], [5, 14, 3, 4 + step, '#26332a'], [2, 19 - step, 3, 1, '#0a0d0b'], [5, 18 + step, 3, 1, '#0a0d0b'],
  ];
  return <Sprite x={x} y={y} rects={r} />;
};

const Desk = ({ x, y, look, t, busy, seed }: { x: number; y: number; look: number; t: number; busy: boolean; seed: number }) => {
  const lines = [0, 1, 2, 3].map((i) => 40 + ((seed * 37 + i * 53 + (busy ? Math.floor(t / 6) * 29 : 0)) % 90));
  return (
    <div style={{ position: 'absolute', left: x, top: y }}>
      {/* chair */}
      <div style={{ position: 'absolute', left: 70, top: 120, width: 120, height: 70, borderRadius: 24, background: '#1c2a21' }} />
      <Worker x={80} y={26} look={look} t={t + seed * 5} busy={busy} />
      {/* desk */}
      <div style={{ position: 'absolute', left: 0, top: 120, width: 260, height: 86, borderRadius: 14, background: '#34483a', borderTop: '8px solid #4a6454' }} />
      {/* monitor */}
      <div style={{ position: 'absolute', left: 60, top: 52, width: 140, height: 96, borderRadius: 10, background: '#0e1411', border: '6px solid #5b6f62', boxShadow: busy ? `0 0 46px ${BRAND.accent}88` : 'none', overflow: 'hidden' }}>
        {lines.map((w, i) => <div key={i} style={{ position: 'absolute', left: 10, top: 10 + i * 18, width: busy ? w : 30, height: 8, borderRadius: 4, background: i % 2 ? '#6fd3b0' : BRAND.accent, opacity: busy ? 0.9 : 0.25 }} />)}
      </div>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 20, height: 16, background: '#5b6f62' }} />
      {/* status light: lime when working */}
      <div style={{ position: 'absolute', left: 215, top: 100, width: 16, height: 16, borderRadius: 8, background: busy ? BRAND.accent : '#586a5d', boxShadow: busy ? `0 0 ${14 + 8 * Math.sin((t + seed * 9) / 5)}px ${BRAND.accent}` : 'none' }} />
    </div>
  );
};

export const PixelOffice = ({ label, tag }: { label: string; tag: string }) => {
  const t = useCurrentFrame();
  const W = 920, H = 760;
  const walkX = interpolate(t % 150, [0, 150], [-60, W + 40]);
  const desks = [0, 1, 2, 3, 4, 5];
  return (
    <div style={{ position: 'relative', width: W, height: H, borderRadius: 48, overflow: 'hidden', background: '#101713', border: `3px solid ${BRAND.accent}33`, boxShadow: `0 0 140px ${BRAND.accent}18` }}>
      {/* floor tiles */}
      {Array.from({ length: 5 * 6 }, (_, i) => <div key={i} style={{ position: 'absolute', left: (i % 6) * 160 - 20, top: 190 + Math.floor(i / 6) * 160, width: 160, height: 160, background: (i + Math.floor(i / 6)) % 2 ? '#131b16' : '#16201a' }} />)}
      {/* back wall + windows with sun */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: 190, background: '#1a251e', borderBottom: '10px solid #2a3b30' }} />
      {[190, 450, 710].map((wx, i) => (
        <div key={i} style={{ position: 'absolute', left: wx, top: 36, width: 140, height: 110, background: '#bfe6a8', border: '8px solid #4a6454', opacity: 0.92 }}>
          <div style={{ position: 'absolute', left: 62, top: 0, width: 8, height: 110, background: '#4a6454' }} />
        </div>
      ))}
      <div style={{ position: 'absolute', left: 0, top: 150, width: W, height: 610, background: `linear-gradient(115deg, ${BRAND.accent}22 0%, transparent 45%)`, clipPath: 'polygon(8% 0, 42% 0, 18% 100%, 0 100%)' }} />
      <div style={{ position: 'absolute', left: 0, top: 150, width: W, height: 610, background: `linear-gradient(115deg, ${BRAND.accent}1a 0%, transparent 45%)`, clipPath: 'polygon(46% 0, 80% 0, 62% 100%, 28% 100%)' }} />
      {/* desks: two rows of three, each person at work (a status light and moving hands), one at rest */}
      {desks.map((d) => (
        <Desk key={d} x={30 + (d % 3) * 300} y={205 + Math.floor(d / 3) * 232} look={d + 1} seed={d} t={t} busy={d !== 4 || Math.floor(t / 45) % 2 === 0} />
      ))}
      <Walker x={walkX} y={14} t={t} />
      {/* plant */}
      <div style={{ position: 'absolute', left: 850, top: 640, width: 46, height: 46, background: '#7a5236' }} />
      {[0, 1, 2].map((i) => <div key={i} style={{ position: 'absolute', left: 836 + i * 20, top: 580 + (i % 2) * 18, width: 22, height: 70, borderRadius: 12, background: '#4f9d6b' }} />)}
      {/* tag and label */}
      <div style={{ position: 'absolute', left: 30, top: 30, zIndex: 3, padding: '10px 22px', borderRadius: 24, background: BRAND.accent, color: BRAND.bg, fontWeight: 700, fontSize: 34 }}>{tag}</div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, display: 'flex', justifyContent: 'center' }}>
        <div style={{ padding: '22px 44px', borderRadius: 40, background: 'rgba(10,13,11,0.9)', border: `3px solid ${BRAND.accent}`, color: BRAND.fg, fontWeight: 700, fontSize: 50 }}>{label}</div>
      </div>
    </div>
  );
};
