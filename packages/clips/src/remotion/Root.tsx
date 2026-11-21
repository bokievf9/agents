import React from 'react';
import { Composition } from 'remotion';
import { HEIGHT, WIDTH, FPS, type ClipScript } from '../schema';
import { buildTimeline, type Timeline } from '../timing';
import { Clip, type ClipProps } from './Clip';

// Studio preview defaults: estimate voice length at ~2.5 words per second.
const demo: ClipScript = {
  title: 'ИИ-менеджер заявок',
  hook: 'Клиент пишет в 2 ночи. Кто отвечает?',
  scenes: [
    { voice: 'Клиент пишет в два часа ночи. Кто отвечает?', subtitle: 'Клиент пишет ночью' },
    { voice: 'ИИ-менеджер заявок отвечает за секунды и записывает на удобное время.', subtitle: 'Отвечает за секунды' },
  ],
  cta: 'Подробнее на firtech.pro',
  theme: 'dark',
};
const est = (t: string) => t.split(/\s+/).length / 2.5;
const demoTimeline = buildTimeline(demo.scenes.map((s) => est(s.voice)), est(demo.cta));

export const Root: React.FC = () => (
  <Composition
    id="Clip"
    component={Clip}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    durationInFrames={demoTimeline.totalFrames}
    defaultProps={{ script: demo, timeline: demoTimeline } satisfies ClipProps}
    calculateMetadata={({ props }) => ({ durationInFrames: props.timeline.totalFrames })}
  />
);

export type { Timeline };
