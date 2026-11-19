import type { PublishPack } from './pack.js';

/**
 * Stage 2 interface: posting a pack through a platform API. Stage 1 has only the manual poster (the owner posts by
 * hand and presses «Опубликовано»). No network posting exists in this package. Accounts and apps each API needs are
 * listed in README.md; a real poster still runs only after the owner approved the item.
 */
export interface PlatformPoster {
  readonly platform: PublishPack['platform'];
  /** Posts the pack; resolves to the public URL. Must throw on any failure and never retry blindly. */
  post(pack: PublishPack): Promise<{ url: string }>;
  /** Does the pack have what this poster needs (a video, pictures)? Default: a video file. A pack it cannot post stays manual, silently. */
  canPost?(pack: PublishPack): boolean;
}

/** Thrown by a poster whose post is accepted but not finished yet (a Reel still processing): not an error, the next run finishes it. */
export class PostPending extends Error {
  constructor(readonly platformLabel: string) {
    super(`${platformLabel}: видео ещё обрабатывается, публикация завершится при следующем запуске`);
  }
}

/** Stage 1: no API. `post` always refuses, so a caller falls back to the manual flow. */
export class ManualPoster implements PlatformPoster {
  constructor(readonly platform: PublishPack['platform']) {}
  post(): Promise<{ url: string }> {
    return Promise.reject(new Error('manual: публикует человек, затем кнопка «Опубликовано»'));
  }
}
