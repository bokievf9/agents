import { DIRECTIONS, type Direction } from './directions.js';

export const ANGLES = {
  how: 'как это работает: механика на одном конкретном примере',
  price: 'сколько стоит и что входит (цена только из справки)',
  before_after: 'было, стало: пример сценария, обязательно с подписью «Пример сценария», без цифр результата',
  demo: 'показ в работе на примерных данных, с подписью «Демо на примерных данных»',
  client_mistake: 'ошибка клиента: типичная ошибка владельца бизнеса в этой рутине и как её закрывает агент, без цифр результата',
  fact: 'цифра дня: один факт из справки (цена, срок или что входит) как главная мысль ролика, без выдуманной статистики',
} as const;
export type AngleId = keyof typeof ANGLES;

export interface Topic {
  /** Unique key for the history: `<direction>:<angle>` or `free:<slug>`. */
  key: string;
  directionId: Direction['id'] | null;
  text: string;
}

export const REPEAT_WINDOW_DAYS = 42; // six weeks
/**
 * Pool size: 8 directions x 6 angles = 48 topics. A pack is 7 clips plus a carousel every other week, so on
 * average 7.5 topics a week: 48 / 7.5 = 6.4 weeks before the first topic comes back, which covers the six-week
 * window (6 weeks use 45 topics). Raising CLIPS_PER_WEEK or CAROUSELS_PER_WEEK needs more angles or directions.
 */
const DAY = 86_400_000;

export const ALL_TOPICS: Topic[] = DIRECTIONS.flatMap((d) =>
  (Object.keys(ANGLES) as AngleId[]).map((a) => ({ key: `${d.id}:${a}`, directionId: d.id, text: `${d.name}: ${ANGLES[a]}` })),
);

export function freeTopic(text: string): Topic {
  const slug = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
  return { key: `free:${slug}`, directionId: null, text };
}

/** `used` maps topic key to the last time it was used (ms). */
export type History = Map<string, number>;

/**
 * Picks `count` topics: different directions inside one pack, never a key used within the last six weeks
 * (when everything is used up, falls back to the least recently used). Directions are taken in the order of
 * their last use, oldest first, so all eight rotate evenly.
 */
export function pickTopics(history: History, count: number, now: number, rng: () => number = Math.random): Topic[] {
  const lastKeyUse = (k: string) => history.get(k) ?? 0;
  const lastDirUse = (id: string) => Math.max(0, ...ALL_TOPICS.filter((t) => t.directionId === id).map((t) => lastKeyUse(t.key)));
  const fresh = (t: Topic) => now - lastKeyUse(t.key) >= REPEAT_WINDOW_DAYS * DAY;
  const dirs = DIRECTIONS.map((d) => d.id).sort((a, b) => lastDirUse(a) - lastDirUse(b) || (a < b ? -1 : 1));
  const picked: Topic[] = [];
  for (let i = 0; picked.length < count; i++) {
    const id = dirs[i % dirs.length]!;
    const own = ALL_TOPICS.filter((t) => t.directionId === id && !picked.includes(t));
    const pool = own.filter(fresh);
    if (pool.length > 0) picked.push(pool[Math.floor(rng() * pool.length)]!);
    else if (i >= dirs.length * 2 || own.length === 0) {
      // Everything is used up: least recently used key overall.
      const rest = ALL_TOPICS.filter((t) => !picked.includes(t)).sort((a, b) => lastKeyUse(a.key) - lastKeyUse(b.key));
      picked.push(rest[0]!);
    }
  }
  return picked;
}
