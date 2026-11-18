# @fir/clips

Faceless vertical clips (1080x1920, 30 fps, h264) for Reels, TikTok and Shorts, rendered with Remotion from an approved
content-maker script. **Mac-only dev tool: it is not part of the Docker image and never runs on the VPS.** A builder
(Claude Code) renders on the owner's Mac when a `builder` issue asks for a clip.

## Requirements (Mac)

| Tool | Needed | Notes |
| --- | --- | --- |
| Node 22+ and pnpm | yes | `pnpm install` once |
| `ffmpeg`, `ffprobe` | yes | `brew install ffmpeg` |
| `edge-tts` | optional | `pipx install edge-tts`; voice `ru-RU-DmitryNeural`. Free, needs network |
| `say` (macOS) | fallback | voice `Milena` (AIFF to mp3 through ffmpeg). Used when `edge-tts` is missing |
| Chrome Headless Shell | auto | Remotion downloads it (~140 MB) on the first render |

Force an engine with `CLIPS_TTS=edge-tts|say`. Override the voice with `"voice"` in the script. No paid TTS.
The font (Inter, with Cyrillic) is loaded through `@remotion/google-fonts`, so the first render needs network.

## Render

```sh
pnpm --filter @fir/clips render <script.json> <out.mp4>
pnpm --filter @fir/clips preview     # Remotion Studio
pnpm --filter @fir/clips send <file.mp4> [caption]   # send the clip to the owner in Telegram
```

Relative paths are resolved from the directory where you typed the command. Image and music paths inside the script are
relative to the script file. The command prints the voice engine, scene lengths, duration and size. A 28 s clip renders
in about 45 s on an M1 Pro (about 1.5 MB).

## Script (`ClipScript`)

```json
{
  "slug": "ai-receptionist",
  "title": "...", "hook": "...",
  "scenes": [{ "voice": "text to speak", "subtitle": "line on screen", "image": "shot.png" }],
  "cta": "... firtech.pro",
  "theme": "dark",
  "music": "optional.mp3"
}
```

- `ClipScript` (zod) is exported from `src/schema.ts`. A content-maker clip converts with `fromContentMaker(clip)`;
  platform captions travel along in `captions` and are not rendered.
- Hook: the first 1.6 s show the hook as a big title (the first scene's voice starts with it). Then each scene shows its
  subtitle, the words lighting up in step with the voice; scene length is the measured voice length plus 0.3 s.
- `image`: optional screenshot, letterboxed (contain) in a card above the subtitle.
- End card: CTA text and `firtech.pro`, at least 2.2 s. A thin progress bar runs along the bottom.
- `music`: no music by default. If set, it loops, sits at low volume, ducks under the voice and fades out at the end.
  Use only music the studio may use.
- `theme`: `dark` (default) or `light`; tokens in `src/theme.ts`.

## How a builder renders a clip from an HQ issue

1. The issue body holds the clip JSON (a content-maker clip or a `ClipScript`). Save it as
   `/Users/firdavs/fir-tech/agents/out/clips/<slug>.json`. If it is a content-maker item without `slug`, run it through
   `fromContentMaker` first (`slug` is made from the title).
2. Render:
   `pnpm --filter @fir/clips render out/clips/<slug>.json out/clips/<slug>.mp4` from `/Users/firdavs/fir-tech/agents`.
3. Check the file: duration 20 to 40 s, size under about 10 MB, and look at one or two frames (`ffmpeg -ss 5 -i f.mp4 -frames:v 1 f.png`).
4. Send to the owner: `pnpm --filter @fir/clips send out/clips/<slug>.mp4 "<caption>"`. It calls the Bot API `sendVideo`
   (multipart) with `HQ_BOT_TOKEN` and `OWNER_TELEGRAM_ID`, taken from the environment or from the env file
   `CLIPS_ENV_FILE` (absolute, or relative to the package; default `../../apps/hq/.env.local`). The token is never printed.
   On success it prints `message: <id>`.
5. Comment on the issue: «отправлен владельцу в Telegram, message <id>» plus the local path
   `/Users/firdavs/fir-tech/agents/out/clips/<slug>.mp4`, the duration and the voice engine. Then close the issue.

## Limits

- 4 to 7 scenes, 20 to 40 s is the content-maker rule; the renderer accepts 1 to 12 scenes.
- `say` Milena sounds robotic; install `edge-tts` for a better voice.
- Render is sequential and uses all CPU cores for about a minute; do not run two at once on 16 GB.
- `out/` is git-ignored: mp4 files are not committed.
