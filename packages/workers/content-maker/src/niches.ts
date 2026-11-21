/**
 * Mirror of the site's builder catalogue (firtech/src/content/builder-catalog.ts: `kindCategories`, `kindCatalog`,
 * `productCatalog`). Copied by hand, never read at build time (different repo). When the site adds a niche, add it
 * here: the id is the `/solutions/<id>` slug, so a wrong id breaks the article's internal link.
 */
import { productName } from '@fir/core';

export interface Niche {
  id: string;
  category: string;
  name: string;
}

export const NICHE_CATEGORIES: Record<string, string> = {
  food: 'Еда',
  beauty: 'Красота и здоровье',
  retail: 'Торговля',
  services: 'Услуги',
  education: 'Образование',
  realty: 'Недвижимость и финансы',
  travel: 'Туризм',
  b2b: 'B2B',
  health: 'Медицина и уход',
  other: 'Другое',
};

export const NICHES: Niche[] = [
  { id: 'cafe', category: 'food', name: 'Кафе и ресторан' },
  { id: 'restaurant', category: 'food', name: 'Ресторан и банкеты' },
  { id: 'coffee', category: 'food', name: 'Кофейня' },
  { id: 'bakery', category: 'food', name: 'Пекарня и кондитерская' },
  { id: 'delivery', category: 'food', name: 'Доставка' },
  { id: 'catering', category: 'food', name: 'Кейтеринг' },
  { id: 'barber', category: 'beauty', name: 'Барбершоп' },
  { id: 'salon', category: 'beauty', name: 'Салон и запись' },
  { id: 'nails', category: 'beauty', name: 'Ногтевая студия' },
  { id: 'spa', category: 'beauty', name: 'Спа и релакс-центр' },
  { id: 'cosmetology', category: 'beauty', name: 'Косметолог' },
  { id: 'dentist', category: 'beauty', name: 'Стоматология' },
  { id: 'clinic', category: 'beauty', name: 'Клиника и медцентр' },
  { id: 'fitness', category: 'beauty', name: 'Фитнес-клуб' },
  { id: 'yoga', category: 'beauty', name: 'Йога-студия' },
  { id: 'massage', category: 'beauty', name: 'Массаж' },
  { id: 'shop', category: 'retail', name: 'Магазин' },
  { id: 'webshop', category: 'retail', name: 'Интернет-магазин' },
  { id: 'flowers', category: 'retail', name: 'Цветы' },
  { id: 'gifts', category: 'retail', name: 'Подарки и сувениры' },
  { id: 'clothing', category: 'retail', name: 'Одежда и обувь' },
  { id: 'electronics', category: 'retail', name: 'Электроника и техника' },
  { id: 'furniture', category: 'retail', name: 'Мебель' },
  { id: 'autoparts', category: 'retail', name: 'Автозапчасти' },
  { id: 'carservice', category: 'services', name: 'Автосервис' },
  { id: 'carwash', category: 'services', name: 'Автомойка' },
  { id: 'drycleaning', category: 'services', name: 'Химчистка и прачечная' },
  { id: 'cleaning', category: 'services', name: 'Клининг' },
  { id: 'repair', category: 'services', name: 'Ремонт техники' },
  { id: 'renovation', category: 'services', name: 'Ремонт квартир' },
  { id: 'photo', category: 'services', name: 'Фото-студия' },
  { id: 'events', category: 'services', name: 'Свадьбы и события' },
  { id: 'printing', category: 'services', name: 'Типография' },
  { id: 'tutor', category: 'education', name: 'Репетитор' },
  { id: 'languages', category: 'education', name: 'Языковые курсы' },
  { id: 'kidscenter', category: 'education', name: 'Детский центр' },
  { id: 'drivingschool', category: 'education', name: 'Автошкола' },
  { id: 'onlineschool', category: 'education', name: 'Онлайн-школа' },
  { id: 'realty', category: 'realty', name: 'Агентство недвижимости' },
  { id: 'lawyers', category: 'realty', name: 'Юристы' },
  { id: 'accounting', category: 'realty', name: 'Бухгалтерия' },
  { id: 'insurance', category: 'realty', name: 'Страхование' },
  { id: 'travel', category: 'travel', name: 'Турагентство' },
  { id: 'hotel', category: 'travel', name: 'Отель' },
  { id: 'guesthouse', category: 'travel', name: 'Гостевой дом' },
  { id: 'tours', category: 'travel', name: 'Экскурсии и гиды' },
  { id: 'services', category: 'b2b', name: 'Услуги и B2B' },
  { id: 'logistics', category: 'b2b', name: 'Логистика и перевозки' },
  { id: 'wholesale', category: 'b2b', name: 'Оптовая торговля' },
  { id: 'itservices', category: 'b2b', name: 'IT-услуги' },
  { id: 'marketing', category: 'b2b', name: 'Маркетинговое агентство' },
  { id: 'coworking', category: 'b2b', name: 'Коворкинг' },
  { id: 'pharmacy', category: 'health', name: 'Аптека' },
  { id: 'vet', category: 'health', name: 'Ветклиника' },
  { id: 'petshop', category: 'health', name: 'Зоомагазин' },
  { id: 'other', category: 'other', name: 'Другое' },
];

/** Niches that make a topic or an article (the catch-all «Другое» does not). */
export const TOPIC_NICHES: Niche[] = NICHES.filter((n) => n.category !== 'other');

/** A product as the posts name it: from the one map of product names (`@fir/core`), read at the moment of use. */
const named = (id: string): { id: string; name: string } => ({
  id,
  get name() {
    return productName(id, 'ru');
  },
});

/** The ten products of the catalogue (`productIds`), as the posts name them. */
export const PRODUCTS: { id: string; name: string }[] = [
  named('adminbot'),
  named('intake'),
  named('automation'),
  named('content'),
  named('miniapp'),
  named('agent'),
  named('aiteam'),
  named('site'),
  named('bot'),
  named('app'),
];

export const nicheById = (id: string): Niche | undefined => NICHES.find((n) => n.id === id);

/** Finds a niche by id or by a fragment of its name (the owner types «барбершоп» or «стоматология»). */
export function findNiche(query: string): Niche | undefined {
  const q = query.trim().toLowerCase().replace(/^\/(ru|en)\/solutions\//, '');
  if (!q) return undefined;
  return TOPIC_NICHES.find((n) => n.id === q) ?? TOPIC_NICHES.find((n) => n.name.toLowerCase() === q) ?? TOPIC_NICHES.find((n) => n.name.toLowerCase().includes(q));
}
