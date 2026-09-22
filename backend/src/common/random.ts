import { randomInt } from 'crypto';

/**
 * Случайная строка из алфавита — криптостойко (crypto.randomInt, CSPRNG).
 * Для паролей студентов и реферальных кодов: Math.random предсказуем.
 */
export function secureRandomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
