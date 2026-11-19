/*
 * One-time YouTube authorisation (owner, on his Mac): `pnpm --filter hq yt-auth [path/to/client_secret.json]`.
 * Client JSON: the file argument, else the YT_OAUTH_CLIENT_JSON env. Prints the consent URL, reads the pasted code (or the whole
 * address the browser ended on) from stdin, exchanges it and prints ONLY the length and a sha256 prefix of the refresh token:
 * the token itself is never printed, it goes to the macOS clipboard (pbcopy) for the hidden dialog of the main window.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { consentUrl, exchangeCode, parseClientJson, parseCode } from '@fir/core';

const path = process.argv[2];
const client = parseClientJson(path ? readFileSync(path, 'utf8') : process.env.YT_OAUTH_CLIENT_JSON);
if (!client) {
  console.error('Нужен JSON клиента Google «Desktop app»: путь к файлу аргументом или YT_OAUTH_CLIENT_JSON в окружении.');
  process.exit(1);
}
console.log('1. Откройте ссылку, войдите аккаунтом владельца канала и разрешите доступ:\n');
console.log(consentUrl(client));
console.log('\n2. Браузер уйдёт на http://localhost и покажет ошибку: это нормально. Скопируйте из адресной строки значение code= (или весь адрес).\n');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = parseCode(await rl.question('Код: '));
rl.close();
if (!code) {
  console.error('Не похоже на код.');
  process.exit(1);
}
try {
  const token = await exchangeCode(client, code);
  console.log(`\nRefresh token получен: длина ${token.length}, sha256 ${createHash('sha256').update(token).digest('hex').slice(0, 12)}.`);
  try {
    execFileSync('pbcopy', { input: token });
  } catch {
    console.error('Не удалось положить токен в буфер обмена (pbcopy есть только на macOS). Токен не показан: повторите команду на Mac.');
    process.exit(1);
  }
  console.log('Токен лежит в буфере обмена macOS, на экран не выводился и нигде не сохранён. Вставьте его (Cmd+V) только в скрытое окно');
  console.log('главного окна (оно спросит YT_REFRESH_TOKEN), затем скопируйте что-нибудь другое, чтобы очистить буфер.');
} catch (e) {
  console.error(e instanceof Error ? e.message : 'ошибка обмена кода');
  process.exit(1);
}
