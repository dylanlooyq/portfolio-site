// The Worker's update routes (gameUpdate in index.js) against a stand-in bucket: no Cloudflare, no network.
//   node update-routes-check.mjs
// The update it holds is signed with a key made here; the Worker does not check signatures (the game does),
// it only has to hand the signed record back unchanged to a build whose token was published.
import crypto from 'node:crypto';
import worker from './index.js';

const installer = crypto.randomBytes(300_000);
const sha256 = crypto.createHash('sha256').update(installer).digest('hex');
const key = crypto.generateKeyPairSync('ed25519');
const info = { version: '9.9.9', file: 'BeatBeatCity-9.9.9-windows-setup.exe', bytes: installer.length, sha256 };
info.sig = crypto.sign(null, Buffer.from(`beat-beat-city update\n${info.version}\n${info.bytes}\n${info.sha256}`), key.privateKey).toString('base64');
const token = crypto.randomBytes(24).toString('hex');
const pack = crypto.randomBytes(1000);
const packName = `${crypto.createHash('sha256').update(pack).digest('hex')}.pack`;

// What the Worker uses of an R2 bucket: get(key, { range: Headers }) -> { body, size, httpEtag, range, json() } or null.
const bucket = (objects) => ({
  async get(name, options) {
    const bytes = objects[name];
    if (!bytes) return null;
    const m = /^bytes=(\d+)-(\d*)$/.exec(options?.range?.get?.('Range') || '');
    const start = m ? +m[1] : 0, end = m && m[2] ? +m[2] : bytes.length - 1;
    return {
      body: bytes.subarray(start, end + 1), size: bytes.length, httpEtag: '"etag"',
      range: m ? { offset: start, length: end - start + 1 } : undefined,
      json: async () => JSON.parse(bytes.toString('utf8')),
    };
  },
});
const json = (v) => Buffer.from(JSON.stringify(v));
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const published = {
  'update/tokens.json': json({ [hash(token)]: '9.9.8' }),
  'update/windows.json': json(info),
  [info.file]: installer,
  [`looks/${packName}`]: pack,
};
const env = (objects = published) => ({ ALLOWED_ORIGINS: 'https://example.test', GAME_BUCKET: bucket(objects) });
const ask = (path, { headers = {}, method = 'GET', objects } = {}) => worker.fetch(new Request(`https://worker.test${path}`, { method, headers }), env(objects));

let failed = 0, count = 0;
const check = (what, ok, got) => { count++; if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `: ${got}`}`); };
const withToken = { 'X-BBC-Update': token };

let r = await ask('/game/update/windows', { headers: withToken });
const answer = r.status === 200 ? await r.json() : null;
check('a published build is told the version', r.status === 200 && answer.version === info.version && answer.bytes === info.bytes && answer.sha256 === sha256, r.status);
check('the record is the signed one, unchanged', !!answer && crypto.verify(null, Buffer.from(`beat-beat-city update\n${answer.version}\n${answer.bytes}\n${answer.sha256}`), key.publicKey, Buffer.from(answer.sig, 'base64')), JSON.stringify(answer));
check('the answer is not cached', r.headers.get('Cache-Control') === 'no-store', r.headers.get('Cache-Control'));

r = await ask('/game/update/windows');
check('no token: 403', r.status === 403, r.status);
r = await ask('/game/update/windows', { headers: { 'X-BBC-Update': crypto.randomBytes(24).toString('hex') } });
check('a token that was never published: 403', r.status === 403, r.status);
r = await ask('/game/update/windows', { headers: { 'X-BBC-Update': 'not hex at all' } });
check('a malformed token: 403', r.status === 403, r.status);
r = await ask(`/game/update/windows/${sha256}`);
check('the installer without a token: 403', r.status === 403, r.status);
r = await ask('/game/update/windows', { headers: withToken, method: 'POST' });
check('POST: 405', r.status === 405, r.status);

r = await ask(`/game/update/windows/${sha256}`, { headers: withToken });
let body = Buffer.from(await r.arrayBuffer());
check('the installer, whole: 200 and the same bytes', r.status === 200 && body.equals(installer), `${r.status}, ${body.length} bytes`);
check('the installer is not cached', r.headers.get('Cache-Control') === 'private, no-store', r.headers.get('Cache-Control'));
r = await ask(`/game/update/windows/${sha256}`, { headers: { ...withToken, Range: 'bytes=100000-' } });
body = Buffer.from(await r.arrayBuffer());
check('going on from where it stopped: 206, Content-Range, the rest of the bytes', r.status === 206 && r.headers.get('Content-Range') === `bytes 100000-${installer.length - 1}/${installer.length}` && body.equals(installer.subarray(100000)), `${r.status} ${r.headers.get('Content-Range')}`);
r = await ask(`/game/update/windows/${'0'.repeat(64)}`, { headers: withToken });
check('an installer that is not the current one: 404', r.status === 404, r.status);

r = await ask('/game/update/windows', { headers: withToken, objects: { 'update/tokens.json': published['update/tokens.json'] } });
check('nothing published as an update yet: 404', r.status === 404, r.status);
r = await ask('/game/update/windows', { headers: withToken, objects: {} });
check('no token list in the bucket: 403', r.status === 403, r.status);
r = await ask('/game/update/windows', { headers: withToken, objects: { ...published, 'update/windows.json': json({ ...info, file: '../latest.json' }) } });
check('a record that names an object outside the builds: 404', r.status === 404, r.status);
r = await ask(`/game/update/windows/${sha256}`, { headers: withToken, objects: { ...published, [info.file]: undefined } });
check('the installer is not in the bucket: 404', r.status === 404, r.status);

r = await ask(`/game/looks/${packName}`);
check('the look packs are still served without a token', r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(pack), r.status);
r = await ask('/game/update/mac', { headers: withToken });
check('any other address: 404', r.status === 404, r.status);

console.log(failed ? `update routes: ${failed} of ${count} FAILED` : `update routes: ${count} of ${count} ok`);
process.exit(failed ? 1 : 0);
