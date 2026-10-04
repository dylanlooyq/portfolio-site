# Download gates

One Cloudflare Worker guards two downloads. Everything it serves lives in **private R2 buckets**,
never in this (public) repo, because anything committed here is public. The site only holds the
Worker's URL.

| Route | Gate | Serves |
| --- | --- | --- |
| `POST /cv` | Cloudflare Turnstile captcha | CV PDF (`dylan-cv` bucket) |
| `POST /game/unlock` → `GET /game/download` | Access key from you | Beat Beat City builds (`beat-beat-city` bucket) |

Cloudflare's free tier is enough for all of it. One-time prerequisite, from this `worker/` folder:

```
npm i -g wrangler && wrangler login
```

> **Wrangler 4 defaults to a local simulator** for `r2 object` and `kv key` commands. Always add
> `--remote` when you mean the real thing (the `keys.mjs` script does this for you).

## Beat Beat City (access key)

How it works: the visitor picks macOS or Windows and types the key you sent them. The Worker looks
the key up in KV; if it exists, it returns a download link signed for one hour, and the browser
fetches the zip from R2 with a normal progress bar (and resume, if the connection drops). Keys are
80 bits of randomness, so they can't be guessed.

### Setup

1. **Create the bucket and the key store**
   ```
   wrangler r2 bucket create beat-beat-city
   wrangler kv namespace create GAME_KEYS     # prints an id: paste it into wrangler.toml
   ```
2. **Zip each build and upload it** (names must match `GAME_FILES` in `index.js`)
   ```
   wrangler r2 object put beat-beat-city/BeatBeatCity-windows.zip --file BeatBeatCity-windows.zip --content-type application/zip --remote
   wrangler r2 object put beat-beat-city/BeatBeatCity-mac.zip     --file BeatBeatCity-mac.zip     --content-type application/zip --remote
   ```
   On a Mac, zip the `.app` with `ditto -c -k --keepParent "Beat Beat City.app" BeatBeatCity-mac.zip`
   so permissions survive. Wrangler uploads top out around 300 MB; for bigger builds use `rclone`
   against the bucket's S3 endpoint. To ship a new version, run the same upload again (no redeploy).
3. **Set the link-signing secret** (any long random string, only the Worker ever sees it)
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   wrangler secret put DOWNLOAD_SECRET        # paste it
   wrangler deploy                            # prints https://dylan-cv.<you>.workers.dev
   ```
4. **Point the site at it**: in the `window.SITE_CONFIG` block near the bottom of `../index.html`:
   ```js
   gameEndpoint: "https://dylan-cv.<you>.workers.dev/game"
   ```
   Commit and push. Until it is set, the Mac/Windows buttons fall back to "email me for a key".

### Day to day

```
node keys.mjs new "Alice, Acme recruiter"            # works until you revoke it
node keys.mjs new "Alice, Acme recruiter" --days 30  # expires on its own
node keys.mjs revoke BBC-XXXX-XXXX-XXXX-XXXX
```

`new` prints the key to send. Use one key per person, so you can revoke one without affecting the rest.

- **Who has a key:** in the Cloudflare dashboard, open the `GAME_KEYS` KV namespace. It lists every
  key with the name you gave it.
- **Who downloaded:** `wrangler tail` prints a line per unlock with that name and the platform.
- **Revoking** takes up to about a minute to apply everywhere, and a link already issued keeps
  working for the rest of its hour.
- The builds are unsigned, so tell people what to expect: on macOS, right-click the app → Open;
  on Windows, SmartScreen → More info → Run anyway.

## CV (captcha)

Serves the CV PDF only after a Cloudflare Turnstile captcha passes.

1. **Turnstile widget**: dash.cloudflare.com → Turnstile → Add site. Add the hostname
   `dylanloo.dev` (plus `localhost` for testing). Copy the **site key** and **secret key**.
2. **R2 bucket + upload the CV**:
   ```
   wrangler r2 bucket create dylan-cv
   wrangler r2 object put dylan-cv/Dylan-Loo-CV.pdf --file "../Resources/CV/Dylan Loo CV -.pdf" --content-type application/pdf --remote
   ```
3. **Set the secret and deploy** (skip `deploy` if you already did it above):
   ```
   wrangler secret put TURNSTILE_SECRET     # paste the secret key
   wrangler deploy
   ```
4. **Point the site at it** in `window.SITE_CONFIG` in `../index.html`:
   ```js
   turnstileSiteKey: "<site key>",
   cvEndpoint: "https://dylan-cv.<you>.workers.dev/cv"
   ```
   Commit and push. Until both values are set, the CV buttons fall back to "email me".

To update the CV later, re-run the `r2 object put` command. No redeploy needed.

## Local testing

`wrangler dev` runs the Worker against a local simulator of R2 and KV, so nothing touches
your real buckets.

1. Create `.dev.vars` (git-ignored) with throwaway secrets. For the CV, Cloudflare publishes
   always-pass Turnstile test keys (site key `1x00000000000000000000AA`, secret below):
   ```
   TURNSTILE_SECRET=1x0000000000000000000000000000000AA
   DOWNLOAD_SECRET=anything-local
   ```
2. Seed it: upload a dummy zip with `wrangler r2 object put ... --local` (same commands as above,
   `--local` instead of `--remote`) and mint a key with `node keys.mjs new "Test" --local`.
3. `wrangler dev --var "ALLOWED_ORIGINS:http://localhost:8123"`, then serve the site on that port
   (`python -m http.server 8123`) with `gameEndpoint` set to `http://127.0.0.1:8787/game` in a
   scratch copy of `index.html`. Pick a free port: `localhost:8000` is often already taken by
   another dev server.
