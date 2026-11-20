import type { CSSProperties, ReactNode } from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { BRAND } from '../brand.js';
import { COPY, type Lang, type ProductId } from '../launch/copy.js';
import { WHIP } from '../launch/plan.js';
import { FONT_BODY, FONT_TITLE } from './fonts.js';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const CARD_W = 880;
/** Local frame (inside a beat's sequence) where the key moment of a mock happens: the beat start + 34. */
export const KEY = WHIP + 34;

/** Spring from 0 to 1 starting at local frame `at`. */
export const useIn = (at: number, damping = 16, stiffness = 170): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: { damping, stiffness } });
};

/** Render prop version of `useIn`, safe inside loops and conditionals. */
export const Anim = ({ at, d = 16, k = 170, children }: { at: number; d?: number; k?: number; children: (s: number) => ReactNode }) => <>{children(useIn(at, d, k))}</>;

export const Card = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div style={{ width: CARD_W, borderRadius: 44, background: BRAND.surface, border: `2px solid ${BRAND.accent}38`, padding: 40, boxSizing: 'border-box', boxShadow: `0 0 120px ${BRAND.accent}14, 0 30px 80px #000a`, fontFamily: FONT_BODY, ...style }}>{children}</div>
);

export const Bubble = ({ text, side, at, lime = false, w }: { text: string; side: 'l' | 'r'; at: number; lime?: boolean; w?: number }) => {
  const s = useIn(at, 18, 190);
  return (
    <div style={{ display: 'flex', justifyContent: side === 'r' ? 'flex-end' : 'flex-start', marginBottom: 22, opacity: s, transform: `translateY(${(1 - s) * 40}px) scale(${0.92 + s * 0.08})`, transformOrigin: side === 'r' ? 'right bottom' : 'left bottom' }}>
      <div style={{ maxWidth: w ?? 640, padding: '24px 32px', borderRadius: 36, borderBottomLeftRadius: side === 'l' ? 10 : 36, borderBottomRightRadius: side === 'r' ? 10 : 36, background: lime ? BRAND.accent : '#1d241f', color: lime ? BRAND.bg : BRAND.fg, fontWeight: 700, fontSize: 42, lineHeight: 1.25 }}>{text}</div>
    </div>
  );
};

export const Typing = ({ from, to }: { from: number; to: number }) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to) return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '26px 32px', width: 150, borderRadius: 36, background: '#1d241f', marginBottom: 22 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ width: 20, height: 20, borderRadius: 10, background: BRAND.muted, opacity: 0.45 + 0.55 * Math.max(0, Math.sin((frame - i * 3) / 3)) }} />
      ))}
    </div>
  );
};

/** A tick drawn with borders (no glyph needed). */
export const Check = ({ size = 40, color = BRAND.bg, on }: { size?: number; color?: string; on: number }) => (
  <div style={{ width: size, height: size, position: 'relative', opacity: on }}>
    <div style={{ position: 'absolute', left: size * 0.22, top: size * 0.02, width: size * 0.3, height: size * 0.6, borderRight: `${size * 0.14}px solid ${color}`, borderBottom: `${size * 0.14}px solid ${color}`, transform: `rotate(40deg) scale(${on})` }} />
  </div>
);

export const Dot = ({ color = BRAND.accent, size = 22 }: { color?: string; size?: number }) => <div style={{ width: size, height: size, borderRadius: size, background: color, flex: 'none' }} />;

const Row = ({ at, children, style }: { at: number; children: ReactNode; style?: CSSProperties }) => {
  const s = useIn(at, 18, 150);
  return <div style={{ opacity: s, transform: `translateX(${(1 - s) * 80}px)`, ...style }}>{children}</div>;
};

// ---- the product mocks ---------------------------------------------------------------------------------------------

const BotMock = ({ lang }: { lang: Lang }) => {
  const u = COPY[lang].ui.bot;
  const frame = useCurrentFrame();
  const pick = frame >= KEY + 36;
  const chip = (t: string, i: number) => {
    const chosen = pick && i === 1;
    return <Anim key={t} at={KEY + 12 + i * 5} d={14} k={200}>{(s) => <div style={{ flex: 1, textAlign: 'center', padding: '22px 0', borderRadius: 28, fontWeight: 700, fontSize: 38, opacity: s, transform: `scale(${0.8 + s * 0.2})`, background: chosen ? BRAND.accent : 'transparent', color: chosen ? BRAND.bg : BRAND.accent, border: `3px solid ${BRAND.accent}` }}>{t}</div>}</Anim>;
  };
  return (
    <Card style={{ minHeight: 700 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, paddingBottom: 28, marginBottom: 28, borderBottom: '2px solid #ffffff14' }}>
        <div style={{ width: 76, height: 76, borderRadius: 38, background: BRAND.accent, color: BRAND.bg, fontFamily: FONT_TITLE, fontWeight: 700, fontSize: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>fir</div>
        <div><div style={{ fontWeight: 700, fontSize: 44 }}>{u.name}</div><div style={{ color: BRAND.accent, fontSize: 30 }}>online</div></div>
      </div>
      <Bubble text={u.ask} side="r" at={WHIP + 10} />
      <Typing from={WHIP + 24} to={KEY} />
      {frame >= KEY ? <Bubble text={u.reply} side="l" at={KEY} /> : null}
      {frame >= KEY + 10 ? <div style={{ display: 'flex', gap: 18, marginBottom: 22 }}>{u.slots.map(chip)}</div> : null}
      {pick ? <Bubble text={u.done} side="l" at={KEY + 40} lime /> : null}
    </Card>
  );
};

const IntakeMock = ({ lang }: { lang: Lang }) => {
  const u = COPY[lang].ui.intake;
  const frame = useCurrentFrame();
  const sent = useIn(KEY, 14, 140);
  return (
    <Card style={{ minHeight: 700 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 30 }}><Dot /><div style={{ fontWeight: 700, fontSize: 46 }}>{u.head}</div></div>
      {u.fields.map(([k, v], i) => {
        const at = WHIP + 8 + i * 9;
        const shown = Math.max(0, Math.min(v.length, Math.floor((frame - at - 6) / 1.2)));
        return (
          <Row key={k} at={at} style={{ marginBottom: 26, padding: '26px 32px', borderRadius: 30, background: '#1a211c' }}>
            <div style={{ color: BRAND.muted, fontSize: 30, marginBottom: 8 }}>{k}</div>
            <div style={{ fontWeight: 700, fontSize: 48, height: 60 }}>{v.slice(0, shown)}{frame % 14 < 7 && shown < v.length ? <span style={{ color: BRAND.accent }}>|</span> : null}</div>
          </Row>
        );
      })}
      <div style={{ marginTop: 40, display: 'flex', alignItems: 'center', gap: 24, padding: '30px 36px', borderRadius: 32, background: BRAND.accent, color: BRAND.bg, fontWeight: 700, fontSize: 42, opacity: frame >= KEY ? sent : 0, transform: `translateY(${(1 - sent) * 60}px)` }}>
        <Check size={52} on={sent} />{u.sent}
      </div>
    </Card>
  );
};

const AutomationMock = ({ lang }: { lang: Lang }) => {
  const u = COPY[lang].ui.automation;
  const frame = useCurrentFrame();
  const travel = interpolate(frame, [KEY - 14, KEY + 36], [0, 1], clamp);
  const node = (t: string, i: number) => {
    const lit = travel * 2 >= i - 0.05;
    return (
      <Anim key={t} at={WHIP + 6 + i * 12}>{(s) => <div style={{ opacity: s, transform: `scale(${0.85 + s * 0.15})`, display: 'flex', alignItems: 'center', gap: 28, padding: '34px 40px', borderRadius: 36, background: lit ? '#1f2d18' : '#1a211c', border: `3px solid ${lit ? BRAND.accent : '#ffffff18'}`, width: 700, alignSelf: 'center', fontWeight: 700, fontSize: 46 }}>
        <div style={{ width: 64, height: 64, borderRadius: 18, background: lit ? BRAND.accent : '#2a342d', flex: 'none' }} />{t}
      </div>}</Anim>
    );
  };
  const wire = (i: number) => (
    <div key={`w${i}`} style={{ alignSelf: 'center', width: 8, height: 90, background: '#ffffff1c', position: 'relative', borderRadius: 4 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 8, borderRadius: 4, background: BRAND.accent, height: `${Math.min(1, Math.max(0, travel * 2 - i)) * 100}%` }} />
    </div>
  );
  return (
    <Card style={{ minHeight: 700, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      {node(u.nodes[0], 0)}{wire(0)}{node(u.nodes[1], 1)}{wire(1)}{node(u.nodes[2], 2)}
    </Card>
  );
};

const ContentMock = ({ lang }: { lang: Lang }) => {
  const u = COPY[lang].ui.content;
  const frame = useCurrentFrame();
  const tag = useIn(KEY, 14, 180);
  const tile = (i: number) => {
    const hue = [BRAND.accent, '#6fd3b0', '#e4f7b5', '#8fbf4d'][i]!;
    const done = frame >= KEY + i * 7;
    return (
      <Anim key={i} at={WHIP + 8 + i * 8} k={160}>{(s) => <div style={{ width: 386, height: 250, flex: 'none', borderRadius: 36, background: '#1a211c', position: 'relative', overflow: 'hidden', opacity: s, transform: `scale(${0.8 + s * 0.2})`, border: `3px solid ${done ? BRAND.accent : '#ffffff14'}` }}>
        <div style={{ position: 'absolute', left: 30, top: 30, width: 110 + i * 16, height: 110 + i * 16, borderRadius: i % 2 ? 30 : '50%', background: hue, opacity: 0.9 }} />
        <div style={{ position: 'absolute', left: 30, bottom: 50, width: 260, height: 18, borderRadius: 9, background: '#ffffff30' }} />
        <div style={{ position: 'absolute', left: 30, bottom: 20, width: 170, height: 18, borderRadius: 9, background: '#ffffff20' }} />
        {done ? <div style={{ position: 'absolute', right: 18, top: 18, padding: '8px 18px', borderRadius: 20, background: BRAND.accent, color: BRAND.bg, fontWeight: 700, fontSize: 26, transform: `scale(${tag})` }}>{u.published}</div> : null}
      </div>}</Anim>
    );
  };
  return (
    <Card style={{ minHeight: 700 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 }}>
        <div style={{ fontWeight: 700, fontSize: 44 }}>{u.week}</div>
        <div style={{ display: 'flex', gap: 14 }}>{Array.from({ length: 7 }, (_, i) => <div key={i} style={{ width: 26, height: 26, borderRadius: 13, background: frame >= WHIP + 14 + i * 6 ? BRAND.accent : '#2a342d' }} />)}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, width: 800 }}>{[0, 1, 2, 3].map(tile)}</div>
    </Card>
  );
};

const MiniAppMock = ({ lang }: { lang: Lang }) => {
  const u = COPY[lang].ui.miniapp;
  const frame = useCurrentFrame();
  const press = interpolate(frame, [KEY - 4, KEY, KEY + 5], [1, 0.92, 1], clamp);
  const toast = useIn(KEY + 4, 14, 180);
  const phone = useIn(WHIP, 18, 120);
  return (
    <div style={{ width: CARD_W, display: 'flex', justifyContent: 'center', opacity: phone, transform: `translateY(${(1 - phone) * 120}px)` }}>
      <div style={{ width: 470, height: 740, borderRadius: 70, background: BRAND.surface, border: `6px solid ${BRAND.accent}55`, boxShadow: `0 0 120px ${BRAND.accent}18`, padding: '34px 30px', position: 'relative', fontFamily: FONT_BODY }}>
        <div style={{ width: 150, height: 14, borderRadius: 7, background: '#ffffff22', margin: '0 auto 26px' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 44 }}>{u.app}</div><div style={{ color: BRAND.accent, fontSize: 28 }}>{u.inside}</div>
        </div>
        {u.items.slice(0, 2).map((t, i) => (
          <Row key={i} at={WHIP + 8 + i * 8} style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '18px 20px', borderRadius: 26, background: '#1a211c', marginBottom: 18 }}>
            <div style={{ width: 84, height: 84, borderRadius: 22, background: [BRAND.accent, '#6fd3b0', '#e4f7b5'][i], flex: 'none' }} />
            <div><div style={{ fontWeight: 700, fontSize: 36 }}>{t}</div><div style={{ width: 130, height: 14, borderRadius: 7, background: '#ffffff26', marginTop: 12 }} /></div>
          </Row>
        ))}
        <div style={{ position: 'absolute', left: 30, right: 30, bottom: 36, padding: '30px 0', textAlign: 'center', borderRadius: 32, background: BRAND.accent, color: BRAND.bg, fontWeight: 700, fontSize: 46, transform: `scale(${press})` }}>{u.button}</div>
        {frame >= KEY + 4 ? <div style={{ position: 'absolute', left: 50, right: 50, bottom: 150, padding: '24px 20px', textAlign: 'center', borderRadius: 28, background: '#fff', color: BRAND.bg, fontWeight: 700, fontSize: 38, opacity: toast, transform: `translateY(${(1 - toast) * 40}px)` }}>{u.toast}</div> : null}
      </div>
    </div>
  );
};

const AgentMock = ({ lang }: { lang: Lang }) => {
  const u = COPY[lang].ui.agent;
  const frame = useCurrentFrame();
  const pulse = 0.55 + 0.45 * Math.sin(frame / 4);
  return (
    <Card style={{ minHeight: 700 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 34 }}>
        <div style={{ width: 28, height: 28, borderRadius: 14, background: BRAND.accent, opacity: pulse, boxShadow: `0 0 30px ${BRAND.accent}` }} />
        <div style={{ fontWeight: 700, fontSize: 48 }}>{u.name}</div>
      </div>
      {u.tasks.map((t, i) => {
        const at = WHIP + 10 + i * 8;
        const doneAt = i === 1 ? KEY : WHIP + 22 + i * 14;
        const done = frame >= doneAt;
        return (
          <Row key={t} at={at} style={{ display: 'flex', alignItems: 'center', gap: 28, padding: '28px 34px', borderRadius: 30, background: done ? '#1f2d18' : '#1a211c', marginBottom: 22, border: `3px solid ${done ? BRAND.accent : '#ffffff12'}` }}>
            <div style={{ width: 62, height: 62, borderRadius: 18, border: `4px solid ${done ? BRAND.accent : '#ffffff40'}`, background: done ? BRAND.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{done ? <Anim at={doneAt} d={14} k={220}>{(d) => <Check size={46} on={d} />}</Anim> : null}</div>
            <div style={{ fontWeight: 700, fontSize: 48, flex: 1 }}>{t}</div>
            {done ? <Anim at={doneAt} d={14} k={220}>{(d) => <div style={{ color: BRAND.accent, fontSize: 34, fontWeight: 700, opacity: d }}>{u.done}</div>}</Anim> : null}
          </Row>
        );
      })}
    </Card>
  );
};

const DepartmentMock = ({ lang }: { lang: Lang }) => {
  const u = COPY[lang].ui.department;
  const frame = useCurrentFrame();
  const center = useIn(WHIP + 4, 14, 160);
  const spots = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
  return (
    <Card style={{ minHeight: 700, position: 'relative', height: 700 }}>
      <svg width={800} height={620} style={{ position: 'absolute', left: 40, top: 40 }}>
        {spots.map(([cx, cy], i) => {
          const p = interpolate(frame, [WHIP + 14 + i * 6, WHIP + 30 + i * 6], [0, 1], clamp);
          const x2 = 120 + cx * 560, y2 = 70 + cy * 480;
          return <line key={i} x1={400} y1={310} x2={400 + (x2 + 120 - 400) * p} y2={310 + (y2 + 40 - 310) * p} stroke={BRAND.accent} strokeWidth={6} opacity={0.6} />;
        })}
      </svg>
      {spots.map(([cx, cy], i) => {
        const on = frame >= KEY + i * 7;
        return (
          <Anim key={i} at={WHIP + 16 + i * 6}>{(s) => <div style={{ position: 'absolute', left: 40 + cx * 560, top: 40 + cy * 480, width: 240, padding: '30px 0', textAlign: 'center', borderRadius: 34, background: on ? '#1f2d18' : '#1a211c', border: `3px solid ${on ? BRAND.accent : '#ffffff18'}`, fontWeight: 700, fontSize: 36, opacity: s, transform: `scale(${0.7 + s * 0.3})` }}>
            <div style={{ width: 22, height: 22, borderRadius: 11, background: on ? BRAND.accent : '#2a342d', margin: '0 auto 16px' }} />{u.roles[i]}
          </div>}</Anim>
        );
      })}
      <div style={{ position: 'absolute', left: 290, top: 270, width: 300, padding: '38px 0', textAlign: 'center', borderRadius: 40, background: BRAND.accent, color: BRAND.bg, fontWeight: 700, fontSize: 44, transform: `scale(${center})`, boxShadow: `0 0 80px ${BRAND.accent}55` }}>{u.boss}</div>
    </Card>
  );
};

export const ProductMock = ({ id, lang }: { id: ProductId; lang: Lang }) => {
  switch (id) {
    case 'bot': return <BotMock lang={lang} />;
    case 'intake': return <IntakeMock lang={lang} />;
    case 'automation': return <AutomationMock lang={lang} />;
    case 'content': return <ContentMock lang={lang} />;
    case 'miniapp': return <MiniAppMock lang={lang} />;
    case 'agent': return <AgentMock lang={lang} />;
    case 'department': return <DepartmentMock lang={lang} />;
  }
};
