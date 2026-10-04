// Public settings for the CV download gate (nothing secret belongs in this file).
// Fill both in after deploying the Worker in /worker (see worker/README.md).
// While either is empty, the CV buttons fall back to "request by email".
window.SITE_CONFIG = {
  turnstileSiteKey: "",   // Cloudflare Turnstile *site* key
  cvEndpoint: ""          // e.g. "https://cv.<your-subdomain>.workers.dev/cv"
};
