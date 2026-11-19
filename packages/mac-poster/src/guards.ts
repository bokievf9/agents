/** What stops a run: Instagram asks to confirm the account, limits actions, or shows the login page. Pure text checks. */
export type BlockKind = 'challenge' | 'rate' | 'login';
export interface Block { kind: BlockKind; message: string }

const CHALLENGE = [
  /suspicious login/i, /подозрительн\S* (попытк\S* )?вход/i, /confirm it'?s you/i, /подтвердите,? что это вы/i, /we suspect automated/i,
  /автоматизированн\S* (поведение|действи)/i, /help us confirm/i, /помогите нам подтвердить/i, /enter the code we sent/i, /введите код,? который мы/i,
  /your account (has been|was) (suspended|disabled)/i, /ваш аккаунт (заблокирован|отключен|приостановлен)/i,
];
const RATE = [/try again later/i, /повторите попытку позже/i, /попробуйте (еще|ещё) раз позже/i, /action blocked/i, /действие заблокировано/i, /we limit how often/i, /мы ограничиваем частоту/i];
const LOGIN_TEXT = [/^log in$|^войти$/im];

/** Classifies the page by its URL and visible text; null when nothing blocks. `loginForm`: a username input is on the page. */
export function classifyBlock(url: string, text: string, loginForm = false): Block | null {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    /* about:blank and the like */
  }
  if (/^\/challenge\//.test(path) || /^\/accounts\/suspended/.test(path) || CHALLENGE.some((r) => r.test(text))) {
    return { kind: 'challenge', message: 'Instagram просит подтвердить вход («Подтвердите, что это вы»). Откройте окно (pnpm --filter mac-poster login), пройдите проверку руками, потом запускайте снова.' };
  }
  if (RATE.some((r) => r.test(text))) return { kind: 'rate', message: 'Instagram ограничил действия («Повторите попытку позже»). Остановился, следующий запуск по расписанию.' };
  if (/^\/accounts\/login/.test(path) || (loginForm && LOGIN_TEXT.some((r) => r.test(text)))) {
    return { kind: 'login', message: 'Instagram показывает страницу входа: профиль разлогинен. Запустите pnpm --filter mac-poster login и войдите руками.' };
  }
  return null;
}

/** Stops the whole run (no item is marked failed: it is not the item's fault). */
export class BlockedError extends Error {
  constructor(readonly block: Block) {
    super(block.message);
  }
}

/** «Поделиться» was pressed but success was not seen: the post may be out. Never retried automatically. */
export class StuckError extends Error {}

/** The site cannot do this item (a story on desktop web): left to the owner, with the reason. */
export class ManualError extends Error {}
