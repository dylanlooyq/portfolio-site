// Cloudflare Worker behind dylanlooyq.github.io. Everything it serves lives in private R2
// buckets, never in the public repo.
//
//   POST /cv              Cloudflare Turnstile check, then the CV PDF (CV_BUCKET)
//   POST /game/unlock     access key + platform, then a signed one-hour download link
//   GET  /game/download   streams the Beat Beat City build for that link (GAME_BUCKET)
//
// Game access keys are KV entries (GAME_KEYS): key = the access key, value = who it was
// issued to. Mint and revoke them with `node keys.mjs` (see README.md).

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CV_KEY = 'Dylan-Loo-CV.pdf';

// Object names in GAME_BUCKET. The browser only ever sends "mac" or "windows".
// A release writes `latest.json` to the bucket ({ "windows": "<object>", "mac": "<object>" }; the
// game repo's tools/publish-builds.mjs does it), so a new version needs no redeploy. The names
// here are served for a platform that file does not name.
const GAME_FILES = {
  mac: 'BeatBeatCity-mac.zip',
  windows: 'BeatBeatCity-windows.zip',
};
const GAME_MANIFEST = 'latest.json';
const CONTENT_TYPES = { zip: 'application/zip', dmg: 'application/x-apple-diskimage' };

async function gameFile(env, platform) {
  try {
    const manifest = await (await env.GAME_BUCKET.get(GAME_MANIFEST))?.json();
    const name = manifest?.[platform];
    if (typeof name === 'string' && /^[\w.-]+$/.test(name)) return name;
  } catch {
    // An unreadable manifest must not take the downloads down.
  }
  return GAME_FILES[platform];
}
// Long enough to resume an interrupted download of a big file.
const LINK_TTL_SECONDS = 60 * 60;

const enc = new TextEncoder();

// Keys are typed by hand, so ignore case and separators and forgive O/0 and I/L/1 mix-ups
// (the generated alphabet has no O, I or L). Keep in sync with keys.mjs.
const normalizeKey = (s) => s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^A-Z0-9]/g, '');

const toB64Url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const hmacKey = (secret, usage) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

async function signLink(secret, platform, expires) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(`${platform}.${expires}`));
  return `${platform}.${expires}.${toB64Url(sig)}`;
}

// Returns the platform the link was issued for, or null if it is forged, malformed or expired.
async function verifyLink(secret, token) {
  const [platform, expires, sig, extra] = token.split('.');
  if (extra !== undefined || !sig || !Object.hasOwn(GAME_FILES, platform)) return null;
  if (!(Number(expires) > Date.now() / 1000)) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromB64Url(sig), enc.encode(`${platform}.${expires}`));
    return ok ? platform : null;
  } catch {
    return null; // sig was not valid base64
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const originOk = allowed.includes(origin);

    const cors = { Vary: 'Origin' };
    if (originOk) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      cors['Access-Control-Allow-Headers'] = 'Content-Type';
      cors['Access-Control-Max-Age'] = '86400';
    }
    const fail = (status, msg) =>
      new Response(msg, { status, headers: { ...cors, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

    // A plain browser navigation: no Origin header, no CORS. The signed link is the credential.
    if (url.pathname === '/game/download') {
      if (request.method !== 'GET') return fail(405, 'Method not allowed');
      return download(request, env, url, fail);
    }

    const route = { '/cv': cv, '/game/unlock': unlock }[url.pathname];
    if (!route) return fail(404, 'Not found');
    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (request.method !== 'POST') return fail(405, 'Method not allowed');
    if (!originOk) return fail(403, 'Forbidden');

    let body;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'Bad request');
    }
    return route(request, env, { body, url, cors, fail, allowed });
  },
};

async function cv(request, env, { body, cors, fail, allowed }) {
  const token = body?.token;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return fail(400, 'Bad request');

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);

  let result;
  try {
    result = await (await fetch(SITEVERIFY, { method: 'POST', body: form })).json();
  } catch {
    return fail(502, 'Verification unavailable');
  }

  // The token must be valid AND issued for one of our own sites.
  const hosts = allowed.map((o) => new URL(o).hostname);
  if (!result.success || !hosts.includes(result.hostname)) return fail(403, 'Captcha failed');

  const obj = await env.CV_BUCKET.get(CV_KEY);
  if (!obj) return fail(404, 'CV not uploaded yet');

  return new Response(obj.body, {
    headers: {
      ...cors,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${CV_KEY}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// Verify a Google Sign-In ID token (RS256 JWT) and return { sub, email }, or null if it is
// forged, expired, for another app, or the email is unverified.
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const fromB64UrlText = (s) => new TextDecoder().decode(fromB64Url(s));

async function verifyGoogle(env, credential) {
  try {
    const [h, p, s, extra] = credential.split('.');
    if (extra !== undefined || !s) return null;
    const header = JSON.parse(fromB64UrlText(h));
    if (header.alg !== 'RS256') return null;

    const jwks = await (await fetch(GOOGLE_JWKS, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64Url(s), enc.encode(`${h}.${p}`)))) return null;

    const claims = JSON.parse(fromB64UrlText(p));
    const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID) return null;
    if (!(claims.exp > Date.now() / 1000) || !claims.sub || claims.email_verified !== true) return null;
    return { sub: String(claims.sub), email: String(claims.email || '') };
  } catch {
    return null;
  }
}

// GAME_KEYS holds three kinds of entries (the prefixes contain ":", which a normalized key never does):
//   <KEY>        -> who the key was issued to (written by keys.mjs; may expire)
//   bind:<KEY>   -> { sub, email }  the Google account the key is locked to
//   acct:<SUB>   -> <KEY>           the key a Google account holds (one key per account)
// The key entry itself is never rewritten, so its expiry and revocation keep working: a link is
// only honoured while the key entry still exists.

// Trade a valid access key AND a Google sign-in for a signed download link. Both are required, every
// time. The first use locks the key to that Google account; after that only that account can use it.
// Credentials are checked here, once; the big file is then fetched with a plain GET so the browser
// shows progress and can resume.
async function unlock(request, env, { body, url, cors, fail }) {
  const { key, platform, credential } = body ?? {};
  if (typeof key !== 'string' || key.length > 100) return fail(400, 'Bad request');
  if (typeof credential !== 'string' || credential.length > 4096) return fail(400, 'Bad request');
  if (typeof platform !== 'string' || !Object.hasOwn(GAME_FILES, platform)) return fail(400, 'Bad request');

  const google = await verifyGoogle(env, credential);
  if (!google) return fail(403, 'Google sign-in failed. Please try again.');

  const normalized = normalizeKey(key);
  const owner = normalized ? await env.GAME_KEYS.get(normalized) : null;
  if (owner === null) return fail(403, 'Invalid or expired key');

  const bound = await env.GAME_KEYS.get(`bind:${normalized}`, 'json');
  if (bound) {
    if (bound.sub !== google.sub) return fail(403, 'This key is linked to a different Google account.');
  } else {
    // First use: lock the key to this account (one key per account).
    const existing = await env.GAME_KEYS.get(`acct:${google.sub}`);
    if (existing && existing !== normalized && (await env.GAME_KEYS.get(existing)) !== null) {
      return fail(403, 'This Google account is already linked to a different key.');
    }
    await env.GAME_KEYS.put(`bind:${normalized}`, JSON.stringify({ sub: google.sub, email: google.email }));
    await env.GAME_KEYS.put(`acct:${google.sub}`, normalized);
  }

  console.log(`beat-beat-city unlock: ${owner} (${platform}) via google ${google.email}`); // visible with `wrangler tail`
  const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const token = await signLink(env.DOWNLOAD_SECRET, platform, expires);
  return new Response(JSON.stringify({ url: `${url.origin}/game/download?t=${encodeURIComponent(token)}` }), {
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function download(request, env, url, fail) {
  const platform = await verifyLink(env.DOWNLOAD_SECRET, url.searchParams.get('t') || '');
  if (!platform) return fail(403, 'This link has expired. Go back to the site and enter your key again.');

  // `range: request.headers` makes R2 honour Range, so an interrupted download can resume.
  const name = await gameFile(env, platform);
  const obj = await env.GAME_BUCKET.get(name, { range: request.headers });
  if (!obj) return fail(404, 'This build has not been uploaded yet.');

  const headers = new Headers({
    'Content-Type': CONTENT_TYPES[name.split('.').pop()] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    ETag: obj.httpEtag,
  });
  let status = 200;
  if (obj.range && request.headers.has('Range')) {
    const start = obj.range.offset ?? 0;
    const end = obj.range.length === undefined ? obj.size - 1 : start + obj.range.length - 1;
    headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
    status = 206;
  }
  return new Response(obj.body, { status, headers });
}
