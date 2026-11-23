import { Composition } from 'remotion';
import { FPS, HEIGHT, WIDTH } from '../brand.js';
import type { ReelProps } from '../props.js';
import { buildTimeline, estimateVoiceSec } from '../timing.js';
import { SAMPLE_SCRIPT } from '../sample-script.js';
import { Reel } from './Reel.js';
import { COPY } from '../launch/copy.js';
import { FILM_FRAMES, TEASER_FRAMES, type LaunchProps } from '../launch/plan.js';
import { LaunchFilmComposition, LaunchTeaserComposition } from './Launch.js';

/** Studio default: the sample script with voice lengths estimated from the text (no voice files). */
const timeline = buildTimeline(SAMPLE_SCRIPT.scenes.map((s) => ({ voiceSec: estimateVoiceSec(s.voice) })), null, SAMPLE_SCRIPT.durationSec);
const defaults: ReelProps = {
  hook: SAMPLE_SCRIPT.hook,
  cta: SAMPLE_SCRIPT.cta,
  scenes: SAMPLE_SCRIPT.scenes.map((s) => ({ subtitle: s.subtitle, voice: s.voice, audio: null })),
  ctaAudio: null,
  timeline,
  brand: { fira: { bubble: SAMPLE_SCRIPT.hook } },
};

const launchDefaults: LaunchProps = { lang: 'ru', vo: COPY.ru.vo, voice: {}, sfx: true, musicPath: null, musicVolume: 0.35, captions: true };

export const Root = () => (
  <>
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
  <Composition id="LaunchFilm" component={LaunchFilmComposition} width={WIDTH} height={HEIGHT} fps={FPS} durationInFrames={FILM_FRAMES} defaultProps={launchDefaults} />
  <Composition id="LaunchTeaser" component={LaunchTeaserComposition} width={WIDTH} height={HEIGHT} fps={FPS} durationInFrames={TEASER_FRAMES} defaultProps={launchDefaults} />
  </>
);
