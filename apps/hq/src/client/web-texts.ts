import { productList, productName } from '@fir/core';
import { PRODUCT_IDS, PRODUCTS, startingPrices, type CatalogueId } from './products.js';
import { BUDGETS, DEADLINES, NEED_BUTTONS, productCardHtml, T, type Lang } from './texts.js';

/** Telegram texts are HTML; the website chat shows plain text. */
export const plain = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** Button labels without the leading emoji (the site styles its own buttons). */
export const label = (s: string): string => s.replace(/^[\p{Extended_Pictographic}️\s]+/u, '').trim();

export interface WebButton {
  id: string;
  label: string;
}

interface WebTexts {
  welcome: string;
  /** The greeting in front of the answer to a first message that already names a need: no product list (it is on «что вы делаете» only). */
  welcomeShort: string;
  /** The scripted demo description with the bot's deep link. */
  demo: string;
  menu: Record<'intake' | 'products' | 'client' | 'ask', string>;
  productsIntro: string;
  discuss: string;
  allProducts: string;
  ask: string;
  askContact: string;
  contactBad: string;
  done(need: string, deadline: string, budget: string, night: boolean): string;
  clientDone(ticket: boolean, night: boolean): string;
  price: string;
  night: string;
  fallback: string;
  /** The model is down: scripted, asks for a contact so the request is not lost, never an error. */
  down: string;
  cap: string;
}

const RU: WebTexts = {
  get demo() {
    return `Демо продукта «${productName('adminbot', 'ru')}» на примере вымышленного «Салона Лайм»: выбираете услугу, мастера, день и время, ассистент записывает вас, через минуту присылает напоминание, предлагает перенести, отменить или оставить отзыв. Записи не настоящие. Демо работает в Telegram: https://t.me/firtech_bot?start=demo_salon`;
  },
  get welcome() {
    return `Здравствуйте. Я Фира, ИИ-ассистент Fir Tech: так же я могу принимать клиентов вашего бизнеса. Что мы делаем: ${productList('ru')}. Собрать проект и увидеть цену можно в «Сборке проекта»: https://firtech.pro/ru/builder. Чем помочь?`;
  },
  get welcomeShort() {
    return `Здравствуйте. Я Фира, ИИ-ассистент Fir Tech.`;
  },
  productsIntro: 'Наши продукты. Выберите, расскажу, для кого это и что внутри.',
  discuss: 'Обсудить',
  allProducts: 'Все продукты',
  menu: { intake: 'Обсудить проект', products: 'Продукты', client: 'Я уже клиент', ask: 'Задать вопрос' },
  ask: 'Спрашивайте: расскажу, что и как мы делаем. Цены на сайте в долларах, точную цену и срок команда записывает в смете.',
  askContact: 'Последний шаг. Как с вами связаться? Напишите Telegram @username, телефон или email.',
  contactBad: 'Не похоже на контакт. Напишите Telegram @username, телефон с кодом страны или email.',
  done: (need, deadline, budget, night) =>
    `Готово, заявка принята.\nЗадача: ${need}\nСрок: ${deadline}\nБюджет: ${budget}\n\nМы свяжемся с вами по этому контакту. Первый ответ за 5 минут, круглосуточно; цены и сроки подтверждает основатель.${night ? ' Сейчас у нас ночь, поэтому ответ придёт утром.' : ''}`,
  clientDone: (ticket, night) =>
    `Приняли. ${ticket ? 'Ответим по вашему контакту в течение часа в рабочее время.' : 'Передали команде, свяжемся по вашему контакту. Первый ответ за 5 минут, круглосуточно; цены и сроки подтверждает основатель.'}${night ? ' Сейчас ночь, поэтому ответ придёт утром.' : ''}`,
  get price() {
    return `${startingPrices('ru')}.\n\nТочную цену и срок считаем под задачу и записываем в смете. Ответьте на три коротких вопроса, и мы вернёмся с предложением. Первый ответ за 5 минут, круглосуточно; цены и сроки подтверждает основатель.`;
  },
  night: 'Сейчас у нас ночь, человек ответит утром. Если хотите, оставьте заявку: это три коротких вопроса и контакт.',
  fallback: 'На этот вопрос лучше ответит команда. Оставьте заявку: три коротких вопроса и контакт, и мы вернёмся с ответом.',
  down: 'Принял, менеджер ответит в рабочее время. Оставьте контакт (Telegram @username, телефон или email), и мы напишем вам первыми.',
  cap: 'Чтобы ответить по существу, нужно знать вашу задачу. Оставьте заявку: три коротких вопроса и контакт, и команда вернётся с предложением.',
};

const EN: WebTexts = {
  get demo() {
    return `A demo of the “${productName('adminbot', 'en')}” on the example of a fictional “Lime Salon”: you pick a service, a master, a day and a time, the assistant books you, sends a reminder a minute later and offers to reschedule, cancel or leave a review. Bookings are not real. The demo runs in Telegram: https://t.me/firtech_bot?start=demo_salon`;
  },
  get welcome() {
    return `Hello. I'm Fira, Fir Tech's AI assistant: I can receive your business’s clients the same way. What we do: ${productList('en')}. You can put a project together and see the price in the builder: https://firtech.pro/en/builder. How can we help?`;
  },
  get welcomeShort() {
    return `Hello. I'm Fira, Fir Tech's AI assistant.`;
  },
  productsIntro: 'Our products. Pick one and I will tell you who it is for and what is inside.',
  discuss: 'Discuss',
  allProducts: 'All products',
  menu: { intake: 'Discuss a project', products: 'Products', client: 'I am a client', ask: 'Ask a question' },
  ask: 'Go ahead: I will tell you what we do and how. Prices are on the site in USD, the team writes the exact price and timing in the estimate.',
  askContact: 'Last step. How can we reach you? Send a Telegram @username, a phone number or an email.',
  contactBad: 'That does not look like a contact. Send a Telegram @username, a phone number with country code or an email.',
  done: (need, deadline, budget, night) =>
    `Done, request received.\nTask: ${need}\nTiming: ${deadline}\nBudget: ${budget}\n\nWe will contact you. First reply within 5 minutes, around the clock; prices and timing are confirmed by the founder.${night ? ' It is night here now, so the answer will come in the morning.' : ''}`,
  clientDone: (ticket, night) =>
    `Got it. ${ticket ? 'We will answer through your contact within an hour during working hours.' : 'Passed to the team, we will reach out. First reply within 5 minutes, around the clock; prices and timing are confirmed by the founder.'}${night ? ' It is night here now, so the answer will come in the morning.' : ''}`,
  get price() {
    return `${startingPrices('en')}.\n\nWe set the exact price and timing for each task and write them in the estimate. Answer three short questions and we will come back with a proposal. First reply within 5 minutes, around the clock; prices and timing are confirmed by the founder.`;
  },
  night: 'It is night here now, a person will answer in the morning. If you like, leave a request: three short questions and a contact.',
  fallback: 'The team can answer this better. Leave a request: three short questions and a contact, and we will come back with an answer.',
  down: 'Got it, a manager will reply during business hours. Leave a contact (Telegram @username, phone or email) and we will write to you first.',
  cap: 'To answer properly we need to know your task. Leave a request: three short questions and a contact, and the team will come back with a proposal.',
};

export const W: Record<Lang, WebTexts> = { ru: RU, en: EN };

export const menuButtons = (lang: Lang): WebButton[] => (['intake', 'products', 'client', 'ask'] as const).map((id) => ({ id, label: W[lang].menu[id] }));
export const intakeButton = (lang: Lang): WebButton[] => [{ id: 'intake', label: W[lang].menu.intake }];

export const needButtons = (lang: Lang): WebButton[] => NEED_BUTTONS.map((k) => ({ id: `need:${k}`, label: label(T[lang].need[k]) }));
export const deadlineButtons = (lang: Lang): WebButton[] => DEADLINES.map((k) => ({ id: `deadline:${k}`, label: label(T[lang].deadline[k]) }));
export const budgetButtons = (lang: Lang): WebButton[] => BUDGETS.map((k) => ({ id: `budget:${k}`, label: label(T[lang].budget[k]) }));

export const productListButtons = (lang: Lang): WebButton[] => [...PRODUCT_IDS, 'site' as const].map((id) => ({ id: `product:${id}`, label: PRODUCTS[id].name[lang] }));
export const productCardButtons = (lang: Lang, id: CatalogueId): WebButton[] => [
  { id: `need:${id}`, label: W[lang].discuss },
  { id: 'products', label: W[lang].allProducts },
];

/** The product card as plain text. */
export const productCardText = (lang: Lang, id: CatalogueId): string => plain(productCardHtml(lang, id));
