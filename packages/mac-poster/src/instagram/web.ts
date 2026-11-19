import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { BlockedError, ManualError, StuckError, classifyBlock } from '../guards.js';
import type { PlanItem } from '../select.js';
import type { SitePoster } from '../site.js';
import { newestNew, profileUrl, usernameFromHref } from '../urls.js';

/**
 * instagram.com (desktop web) driven by Playwright in the owner's persistent profile. Locators are role/aria/text based
 * with RU and EN strings; when Instagram changes its layout, the strings below are the place to fix (see README).
 */
const HOME = 'https://www.instagram.com/';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

export const T = {
  create: /^(Создать|Create|Новая публикация|New post)$/i,
  createMenuPost: /^(Публикация|Post)$/i,
  next: /^(Далее|Next)$/i,
  share: /^(Поделиться|Share)$/i,
  ok: /^(OK|ОК|Понятно)$/i,
  notNow: /^(Не сейчас|Not now|Not Now)$/i,
  close: /^(Закрыть|Close)$/i,
  caption: /(подпись|caption)/i,
  processing: /(Обработка|Processing)/i,
  shared: /(публикация опубликована|ваша публикация опубликована|видео reels опубликовано|ваше видео reels опубликовано|has been shared|^post shared$|^reel shared$)/i,
  shareFailed: /(не удалось (поделиться|опубликовать)|couldn'?t (be )?shar|something went wrong|что-то пошло не так)/i,
  yourStory: /^(Ваша история|Your story)$/i,
  addToStory: /^(Добавить в (вашу )?историю|Add to (your )?story|Поделиться|Share|Ваша история|Your story)$/i,
  originalCrop: /^(Оригинал|Original)$/i,
} as const;

const CROP_ICON = 'svg[aria-label="Select crop"], svg[aria-label="Выбрать размер и обрезать"], svg[aria-label="Выберите размер и обрежьте"]';
const NEW_POST_ICON = 'svg[aria-label="New post"], svg[aria-label="Новая публикация"], svg[aria-label="Create"], svg[aria-label="Создать"]';
const LOGGED_IN = 'a[href^="/direct/"], svg[aria-label="Home"], svg[aria-label="Главная"], a[href="/explore/"]';

export interface WebOpts {
  profileDir: string;
  logsDir: string;
  headless: boolean;
  username: string;
  /** Random pause between steps, ms (tests and `--fast` pass smaller numbers). */
  pause?: [number, number];
  log?: (line: string) => void;
}

export async function openContext(profileDir: string, headless: boolean): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Asia/Kuala_Lumpur',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

const visible = async (l: Locator, timeout = 3000): Promise<boolean> => {
  try {
    await l.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
};

export async function isLoggedIn(page: Page): Promise<boolean> {
  if (await page.locator('input[name="username"]').count()) return false;
  return (await page.locator(LOGGED_IN).count()) > 0;
}

/** The username from the sidebar «Профиль» link or the avatar picture; '' when not found. */
export async function readUsername(page: Page): Promise<string> {
  const byName = page.getByRole('link', { name: /^(Профиль|Profile)$/i }).first();
  const candidates = [await byName.getAttribute('href', { timeout: 2000 }).catch(() => null)];
  for (const img of await page.locator('img[alt*="profile picture" i], img[alt*="Фото профиля" i]').all()) {
    candidates.push(await img.evaluate((el) => el.closest('a')?.getAttribute('href') ?? null).catch(() => null));
  }
  for (const h of candidates) {
    const u = h ? usernameFromHref(h) : null;
    if (u) return u;
  }
  return '';
}

export class InstagramWeb implements SitePoster {
  readonly site = 'instagram';
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private grid: string[] = [];
  private username: string;

  constructor(private readonly o: WebOpts) {
    this.username = o.username;
  }

  private log(s: string) {
    (this.o.log ?? console.log)(s);
  }

  private async human(): Promise<void> {
    const [a, b] = this.o.pause ?? [1000, 4000];
    await new Promise((r) => setTimeout(r, a + Math.random() * (b - a)));
  }

  private get p(): Page {
    if (!this.page) throw new Error('browser not started');
    return this.page;
  }

  /** Throws `BlockedError` on a challenge, a limit or the login page. */
  async guard(page: Page = this.p): Promise<void> {
    const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const form = (await page.locator('input[name="username"]').count().catch(() => 0)) > 0;
    const b = classifyBlock(page.url(), text.slice(0, 20_000), form);
    if (b) throw new BlockedError(b);
  }

  async shot(name: string, page: Page | null = this.page): Promise<string | null> {
    if (!page) return null;
    mkdirSync(this.o.logsDir, { recursive: true });
    const file = join(this.o.logsDir, `${name.replace(/[^\w.-]+/g, '_')}.png`);
    try {
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    this.ctx = await openContext(this.o.profileDir, this.o.headless);
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    await this.p.goto(HOME, { waitUntil: 'domcontentloaded' });
    await this.human();
    await this.dismissPopups(this.p);
    await this.guard();
    if (!(await visible(this.p.locator(LOGGED_IN), 15_000))) {
      await this.guard();
      throw new BlockedError({ kind: 'login', message: 'Не вижу ленту Instagram: профиль разлогинен? Запустите pnpm --filter mac-poster login.' });
    }
    if (!this.username) this.username = await readUsername(this.p);
    this.grid = await this.profileGrid();
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.page = null;
  }

  /** «Включить уведомления?», «Сохранить данные для входа?» and the like: «Не сейчас». */
  private async dismissPopups(page: Page): Promise<void> {
    for (let i = 0; i < 2; i++) {
      const b = page.getByRole('button', { name: T.notNow });
      if (await visible(b, 1500)) await b.first().click().catch(() => undefined);
      else break;
    }
  }

  /** Links of the first grid items on the profile (to find the new post after sharing). */
  private async profileGrid(): Promise<string[]> {
    if (!this.username) return [];
    const page = this.p;
    await page.goto(profileUrl(this.username), { waitUntil: 'domcontentloaded' });
    await visible(page.locator('a[href*="/p/"], a[href*="/reel/"]'), 10_000);
    const hrefs = await page.locator('main a[href*="/p/"], main a[href*="/reel/"]').evaluateAll((els) => els.slice(0, 24).map((e) => e.getAttribute('href') ?? '')).catch(() => [] as string[]);
    await this.guard();
    return hrefs;
  }

  /** Runs one step; on failure takes `<item>-<step>.png` and rethrows with the step name. Blocks are checked first. */
  private async step<R>(item: PlanItem, name: string, fn: () => Promise<R>, page: Page = this.p): Promise<R> {
    try {
      const r = await fn();
      await this.human();
      return r;
    } catch (e) {
      const shot = await this.shot(`${item.id}-${name}`, page);
      if (e instanceof BlockedError || e instanceof StuckError || e instanceof ManualError) throw e;
      await this.guard(page);
      const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      throw new Error(`шаг «${name}»: ${msg}${shot ? ` (скриншот ${shot})` : ''}`, { cause: e });
    }
  }

  async post(item: PlanItem, files: string[]): Promise<{ url: string }> {
    if (item.kind === 'story') return this.story(item, files);
    const page = this.p;
    await this.step(item, 'home', async () => {
      if (!page.url().startsWith(HOME) || new URL(page.url()).pathname !== '/') await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      await this.dismissPopups(page);
      await this.guard();
    });
    await this.step(item, 'create', async () => {
      const btn = page.getByRole('link', { name: T.create }).or(page.getByRole('button', { name: T.create })).or(page.locator(NEW_POST_ICON));
      await btn.first().click({ timeout: 15_000 });
      // newer layouts open a small menu: «Публикация» / «Post»
      const menuPost = page.getByRole('link', { name: T.createMenuPost }).or(page.getByRole('menuitem', { name: T.createMenuPost })).or(page.getByRole('button', { name: T.createMenuPost }));
      if (await visible(menuPost, 3000)) await menuPost.first().click();
      await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 15_000 });
    });
    await this.step(item, 'files', async () => {
      const input = page.locator('input[type="file"]').first();
      await input.waitFor({ state: 'attached', timeout: 15_000 });
      await input.setInputFiles(files);
      // «Видеопубликации теперь публикуются как видео Reels»: OK
      const ok = page.getByRole('button', { name: T.ok });
      if (await visible(ok, 4000)) await ok.first().click();
      await page.getByRole('button', { name: T.next }).first().waitFor({ state: 'visible', timeout: item.kind === 'clip' ? 120_000 : 60_000 });
    });
    await this.step(item, 'crop', async () => {
      const f = item.files[0];
      const portrait = f && f.w > 0 && f.h > 0 && Math.abs(f.w / f.h - 0.8) < 0.02;
      const icon = page.locator(CROP_ICON).first();
      if (await visible(icon, 3000)) {
        await icon.click();
        const choice = portrait ? page.getByText(/^4:5$/).first() : page.getByText(T.originalCrop).first();
        if (await visible(choice, 3000)) await choice.click();
        await icon.click().catch(() => undefined); // close the crop menu
      }
    });
    await this.step(item, 'next-1', async () => {
      await page.getByRole('button', { name: T.next }).first().click({ timeout: 15_000 });
    });
    await this.step(item, 'next-2', async () => {
      // edit/filters step (reels: trim and cover): Next again
      await page.getByRole('button', { name: T.next }).first().click({ timeout: 30_000 });
    });
    await this.step(item, 'caption', async () => {
      const box = page.getByRole('textbox', { name: T.caption }).or(page.locator('div[contenteditable="true"][aria-label]')).first();
      await box.waitFor({ state: 'visible', timeout: 20_000 });
      await box.click();
      await typeCaption(page, box, item.caption);
    });
    if (item.kind === 'clip') {
      await this.step(item, 'processing', async () => {
        await page.getByText(T.processing).first().waitFor({ state: 'hidden', timeout: 600_000 }).catch(() => undefined);
      });
    }
    await this.step(item, 'share', async () => {
      await page.getByRole('dialog').getByRole('button', { name: T.share }).first().click({ timeout: 20_000 });
    });
    // from here the post may be out: an unclear result is «stuck», never retried by itself
    try {
      const okText = page.getByText(T.shared).first();
      const failText = page.getByText(T.shareFailed).first();
      const outcome = await Promise.race([
        okText.waitFor({ state: 'visible', timeout: item.kind === 'clip' ? 900_000 : 180_000 }).then(() => 'ok' as const),
        failText.waitFor({ state: 'visible', timeout: item.kind === 'clip' ? 900_000 : 180_000 }).then(() => 'fail' as const),
      ]);
      if (outcome === 'fail') {
        const shot = await this.shot(`${item.id}-share-result`);
        throw new Error(`Instagram ответил «не удалось поделиться»${shot ? ` (скриншот ${shot})` : ''}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Instagram ответил')) throw e;
      const shot = await this.shot(`${item.id}-share-result`);
      await this.guard();
      throw new StuckError(`после «Поделиться» не увидел подтверждения: проверьте профиль руками${shot ? ` (скриншот ${shot})` : ''}`);
    }
    this.log(`  опубликовано: #${item.id}`);
    await this.human();
    const close = page.getByRole('button', { name: T.close }).or(page.locator('svg[aria-label="Закрыть"], svg[aria-label="Close"]'));
    if (await visible(close, 3000)) await close.first().click().catch(() => undefined);
    return { url: await this.findNewUrl() };
  }

  /** The new post's link on the profile grid (pinned posts are in both snapshots), else the profile URL. */
  private async findNewUrl(): Promise<string> {
    if (!this.username) return HOME;
    for (let i = 0; i < 3; i++) {
      await this.human();
      const after = await this.profileGrid().catch(() => [] as string[]);
      const url = newestNew(this.grid, after);
      if (url) {
        this.grid = after;
        return url;
      }
    }
    return profileUrl(this.username);
  }

  /**
   * Stories: desktop instagram.com has no upload, so a page of the same profile is switched to an iPhone (CDP emulation)
   * where the home feed shows «Ваша история». No upload control within 20 s: `ManualError` (the owner posts it from the phone).
   * Every frame is its own story.
   */
  private async story(item: PlanItem, files: string[]): Promise<{ url: string }> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('browser not started');
    const page = await ctx.newPage();
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone', acceptLanguage: 'ru-RU,ru' });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      for (const [i, file] of files.entries()) {
        await this.step(item, `story-${i + 1}-open`, async () => {
          await page.goto(HOME, { waitUntil: 'domcontentloaded' });
          await this.dismissPopups(page);
          await this.guard(page);
        }, page);
        const chosen = await this.step(item, `story-${i + 1}-upload`, async () => {
          const trigger = page.getByText(T.yourStory).or(page.getByRole('button', { name: T.yourStory })).or(page.locator('svg[aria-label="Камера"], svg[aria-label="Camera"]')).first();
          if (!(await visible(trigger, 20_000))) return false;
          const chooser = page.waitForEvent('filechooser', { timeout: 20_000 }).catch(() => null);
          await trigger.tap().catch(() => trigger.click());
          const fc = await chooser;
          if (fc) {
            await fc.setFiles(file);
            return true;
          }
          const input = page.locator('input[type="file"][accept*="image"]').first();
          if (!(await input.count())) return false;
          await input.setInputFiles(file);
          return true;
        }, page);
        if (!chosen) throw new ManualError('вручную: в веб-версии не нашлась загрузка истории («Ваша история» без поля файла за 20 с)');
        await this.step(item, `story-${i + 1}-share`, async () => {
          const add = page.getByRole('button', { name: T.addToStory }).or(page.getByText(T.addToStory)).last();
          if (!(await visible(add, 60_000))) throw new ManualError('вручную: после выбора картинки не появилась кнопка «Добавить в историю»');
          await add.tap().catch(() => add.click());
          await page.waitForURL((u) => new URL(u.toString()).pathname === '/', { timeout: 60_000 }).catch(() => undefined);
          await this.guard(page);
        }, page);
        this.log(`  история ${i + 1}/${files.length}: #${item.id}`);
      }
      return { url: this.username ? `https://www.instagram.com/stories/${encodeURIComponent(this.username)}/` : HOME };
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/**
 * Puts the caption into the editor as one paste (keeps line breaks, no hashtag pop-up eating an Enter); falls back to typing
 * line by line when the paste did not land.
 */
async function typeCaption(page: Page, box: Locator, caption: string): Promise<void> {
  if (!caption) return;
  await box.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, caption);
  await page.waitForTimeout(500);
  const probe = caption.replace(/\s+/g, ' ').trim().slice(0, 24);
  const now = ((await box.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
  if (now.includes(probe)) return;
  const lines = caption.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line) await page.keyboard.insertText(line);
    if (i < lines.length - 1) await page.keyboard.press('Enter');
  }
}

/** `login`: opens the window and waits (up to 15 min) until the owner is logged in; returns the username it sees. */
export async function loginFlow(o: { profileDir: string; log?: (s: string) => void; timeoutMs?: number }): Promise<string> {
  const log = o.log ?? console.log;
  const ctx = await openContext(o.profileDir, false);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    log('Окно открыто. Войдите в Instagram руками (логин, пароль, код). Я жду ленту, до 15 минут.');
    const deadline = Date.now() + (o.timeoutMs ?? 15 * 60_000);
    while (Date.now() < deadline) {
      if (await isLoggedIn(page).catch(() => false)) {
        await page.waitForTimeout(3000);
        const user = await readUsername(page).catch(() => '');
        log(`Вход виден${user ? `: @${user}` : ''}. Профиль сохранён, окно закрываю.`);
        return user;
      }
      await page.waitForTimeout(2000);
    }
    throw new Error('за 15 минут вход не появился');
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
