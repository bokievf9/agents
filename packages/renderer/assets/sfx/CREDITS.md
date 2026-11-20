# Sound effects of the reel layer

Twelve short effects rendered from the sound bank of **earshot 0.4.1** (https://github.com/Leonxlnx/earshot, MIT licence, author Leon Lin,
installed with `uv tool install ~/earshot`). The bank is pure DSP (recipes and parameters, no recorded audio), so the rendered files are our own output; earshot's
licence is MIT and is kept here with the ids. Bank version `forge_v2r6+forge04r1+fit1+pluck1` (252 sounds).

Rendered with `earshot sfx render <id> -o x.wav --sr 48000` (default take, peak -1 dBFS), then converted to 48 kHz mono 16-bit PCM with
`ffmpeg -ar 48000 -ac 1 -c:a pcm_s16le`. About 0.5 MB in all.

| file | earshot id | seconds | loudest at | use |
|---|---|---|---|---|
| `whoosh_fast_whip.wav` | `whoosh_fast/whip` | 0.91 | 0.116 s | in the layer: whoosh on a scene change |
| `ui_pop_soft.wav` | `ui_pop/soft` | 0.18 | 0.042 s | in the layer: pop when a scene's text appears |
| `cut_hit_kick.wav` | `cut_hit/kick` | 0.33 | 0.013 s | in the layer: hit on the final card |
| `ui_pop_step.wav` | `ui_pop/step` | 0.19 | 0.044 s | spare: pop, a step up |
| `knock_wood.wav` | `knock/wood` | 0.15 | 0.015 s | spare: knock |
| `cut_hit_punch.wav` | `cut_hit/punch` | 0.28 | 0.058 s | spare: heavier hit |
| `swish_bright.wav` | `swish/bright` | 0.35 | 0.155 s | spare: thin swish for text slides |
| `riser_dark.wav` | `riser/dark` | 0.95 | 0.697 s | spare: build into a cut |
| `notify_mid_tine.wav` | `notify/mid_tine` | 0.43 | 0.038 s | spare: notification tick |
| `shutter_snap.wav` | `shutter/snap` | 0.14 | 0.061 s | spare: shutter |
| `mallet_glock.wav` | `mallet/glock` | 0.41 | 0.011 s | spare: glockenspiel note |
| `glitch_burst.wav` | `glitch/burst` | 0.87 | 0.361 s | spare: glitch burst |

The layer (`src/sfx.ts`) mixes them 14 dB under the voice, never starts two effects within 250 ms of each other and is off for a render
job with `sfx: false` (`RENDER_SFX=off` for the service).

## MIT licence of earshot

MIT License. Copyright (c) 2026 Leon Lin. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files, to deal in the software without restriction, including the rights to use, copy, modify, merge, publish,
distribute, sublicense and sell copies, subject to the inclusion of the copyright notice and this permission notice in all copies or
substantial portions of the software. The software is provided "as is", without warranty of any kind.
