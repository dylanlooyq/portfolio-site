// Cloudflare Worker: serves the CV PDF only after a Cloudflare Turnstile check passes.
// The PDF lives in a private R2 bucket (binding CV_BUCKET), never in the public repo.

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CV_KEY = 'Dylan-Loo-CV.pdf';

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

    if (url.pathname !== '/cv') return fail(404, 'Not found');
    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (request.method !== 'POST') return fail(405, 'Method not allowed');
    if (!originOk) return fail(403, 'Forbidden');

    let token;
    try {
      ({ token } = await request.json());
    } catch {
      return fail(400, 'Bad request');
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return fail(400, 'Bad request');

    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET);
    body.append('response', token);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.append('remoteip', ip);

    let result;
    try {
      result = await (await fetch(SITEVERIFY, { method: 'POST', body })).json();
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
  },
};
