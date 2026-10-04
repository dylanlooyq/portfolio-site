#!/usr/bin/env node
// Mint or revoke Beat Beat City access keys (entries in the GAME_KEYS KV namespace).
//
//   node keys.mjs new "Alice, Acme recruiter"          # key that works until revoked
//   node keys.mjs new "Alice, Acme recruiter" --days 30 # key that expires by itself
//   node keys.mjs revoke BBC-XXXX-XXXX-XXXX-XXXX
//   node keys.mjs unlink BBC-XXXX-XXXX-XXXX-XXXX        # free a key from its Google account
//
// Add --local to act on the `wrangler dev` simulator instead of the live namespace.

import { randomInt } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O or U: easy to read out loud
const normalizeKey = (s) => s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^A-Z0-9]/g, ''); // keep in sync with index.js

const args = process.argv.slice(2);
function takeFlag(name, hasValue = false) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, hasValue ? 2 : 1);
  if (hasValue && value === undefined) fail(`${name} needs a value.`);
  return hasValue ? value : true;
}
const days = takeFlag('--days', true);
const local = takeFlag('--local') === true;
const [command, arg] = args;

function wrangler(sub) {
  // Every argument is double-quoted so this works in cmd, PowerShell and sh alike.
  const cmd = `npx wrangler kv key ${sub} --binding GAME_KEYS ${local ? '--local' : '--remote'}`;
  execSync(cmd, { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'inherit' });
}

if (command === 'new' && arg) {
  const who = arg.replace(/[^\w .,@()-]/g, '').trim();
  if (!who) fail('Give the key a name so you remember who has it, e.g. "Alice, Acme recruiter".');
  if (days !== undefined && !(Number(days) >= 1)) fail('--days needs a number of days, e.g. --days 30.');

  const chars = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const pretty = 'BBC-' + chars.match(/.{4}/g).join('-'); // 80 bits of randomness
  const ttl = days === undefined ? '' : ` --ttl ${Math.round(Number(days) * 86400)}`;
  wrangler(`put "${normalizeKey(pretty)}" "${who}"${ttl}`);

  console.log(`\nAccess key for ${who}${days ? ` (expires in ${days} days)` : ''}:\n\n    ${pretty}\n`);
} else if (command === 'revoke' && arg) {
  const key = normalizeKey(arg);
  if (!key) fail('That does not look like a key.');
  wrangler(`delete "${key}"`);
  unlink(key);
  console.log('\nRevoked. Links already issued stay valid for up to an hour; new unlocks fail within about a minute.');
} else if (command === 'unlink' && arg) {
  const key = normalizeKey(arg);
  if (!key) fail('That does not look like a key.');
  console.log(unlink(key) ? '\nUnlinked. The key can be locked to a Google account again on its next use.' : '\nThat key was not linked to a Google account.');
} else {
  fail('Usage:\n  node keys.mjs new "<who it is for>" [--days N] [--local]\n  node keys.mjs revoke <KEY> [--local]\n  node keys.mjs unlink <KEY> [--local]   # let the key be linked to a different Google account');
}

// Remove the Google account link for a key (the `bind:` and `acct:` entries). Returns whether there was one.
function unlink(key) {
  let raw;
  try {
    raw = execSync(`npx wrangler kv key get "bind:${key}" --binding GAME_KEYS ${local ? '--local' : '--remote'}`, {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const { sub } = JSON.parse(raw);
    wrangler(`delete "bind:${key}"`);
    if (sub) wrangler(`delete "acct:${sub}"`);
    return true;
  } catch {
    return false; // no link (wrangler exits non-zero when the entry does not exist)
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
