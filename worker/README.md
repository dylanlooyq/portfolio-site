# CV download gate

Serves the CV PDF only after a Cloudflare Turnstile captcha passes. The PDF lives in a
private R2 bucket, not in this (public) repo.

One-time setup (Cloudflare free tier is enough):

1. **Turnstile widget**: dash.cloudflare.com → Turnstile → Add site. Add the hostname
   `dylanlooyq.github.io` (plus `localhost` for testing). Copy the **site key** and **secret key**.
2. **R2 bucket + upload the CV** (from this `worker/` folder):
   ```
   npm i -g wrangler && wrangler login
   wrangler r2 bucket create dylan-cv
   wrangler r2 object put dylan-cv/Dylan-Loo-CV.pdf --file "../Resources/CV/Dylan Loo CV -.pdf" --content-type application/pdf
   ```
3. **Deploy the Worker and set the secret**:
   ```
   wrangler secret put TURNSTILE_SECRET     # paste the secret key
   wrangler deploy                          # prints https://dylan-cv.<you>.workers.dev
   ```
4. **Point the site at it**: edit `../config.js`:
   ```js
   turnstileSiteKey: "<site key>",
   cvEndpoint: "https://dylan-cv.<you>.workers.dev/cv"
   ```
   Commit and push. Until both values are set, the CV buttons fall back to "email me".

To update the CV later, re-run the `r2 object put` command. No redeploy needed.

Local testing: Cloudflare publishes always-pass test keys (site key `1x00000000000000000000AA`,
secret `1x0000000000000000000000000000000AA`). Use them with `wrangler dev` and
`python -m http.server 8000`.
