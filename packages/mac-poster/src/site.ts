import type { PlanItem } from './select.js';

/**
 * One social site driven in the browser. Instagram is the first; TikTok will be a second implementation with its own
 * profile folder (`<appDir>/<site>`), its own `selectItems` filter and the same run loop and HQ reports.
 */
export interface SitePoster {
  readonly site: string;
  /** Throws `BlockedError` when the profile is logged out or challenged. */
  start(): Promise<void>;
  /** Posts one item from local files (same order as `item.files`). Resolves to the public URL. */
  post(item: PlanItem, files: string[]): Promise<{ url: string }>;
  close(): Promise<void>;
}
