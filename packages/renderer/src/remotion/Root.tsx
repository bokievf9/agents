import { Composition } from 'remotion';
import { FPS, HEIGHT, WIDTH } from '../brand.js';
import type { ReelProps } from '../props.js';
import { buildTimeline, estimateVoiceSec } from '../timing.js';
import { SAMPLE_SCRIPT } from '../sample-script.js';
import { Reel } from './Reel.js';

/** Studio default: the sample script with voice lengths estimated from the text (no voice files). */
const timeline = buildTimeline(SAMPLE_SCRIPT.scenes.map((s) => ({ voiceSec: estimateVoiceSec(s.voice) })), null, SAMPLE_SCRIPT.durationSec);
const defaults: ReelProps = {
  hook: SAMPLE_SCRIPT.hook,
  cta: SAMPLE_SCRIPT.cta,
  scenes: SAMPLE_SCRIPT.scenes.map((s) => ({ subtitle: s.subtitle, voice: s.voice, audio: null })),
  ctaAudio: null,
  timeline,
};

export const Root = () => (
  <Composition
    id="Reel"
    component={Reel}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    durationInFrames={timeline.totalFrames}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({ durationInFrames: props.timeline.totalFrames })}
  />
);
