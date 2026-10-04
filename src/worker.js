// Static assets are served by Cloudflare; only the gameplay video comes through here, because the
// assets layer ignores Range requests and a video that can't answer them can't be scrubbed.
export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

    const asset = await env.ASSETS.fetch(new Request(request.url, { method: 'GET' }));
    if (!asset.ok) return asset;

    const headers = new Headers(asset.headers);
    headers.set('Accept-Ranges', 'bytes');
    const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get('Range') || '').trim());
    if (!m || !(m[1] || m[2])) return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers });

    const body = await asset.arrayBuffer();
    const size = body.byteLength;
    let start, end;
    if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
    else { start = Math.max(size - +m[2], 0); end = size - 1; }   // "-N": the last N bytes
    if (start >= size || start > end) {
      headers.set('Content-Range', `bytes */${size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(request.method === 'HEAD' ? null : body.slice(start, end + 1), { status: 206, headers });
  },
};
