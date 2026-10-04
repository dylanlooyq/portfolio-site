(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Theme toggle: explicit choice wins, otherwise follow the OS ──
  var toggle = document.getElementById('themeToggle');
  function effectiveTheme() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  toggle.addEventListener('click', function () {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  });

  document.getElementById('year').textContent = new Date().getFullYear();

  // ── Email: assembled at runtime so it isn't a plain mailto in the HTML ──
  var email = ['dylanlyq', 'gmail.com'].join('@');
  document.querySelectorAll('[data-email]').forEach(function (el) {
    el.href = 'mailto:' + email;
    el.textContent = email;
  });

  // ── CV download: Turnstile captcha, verified server-side by the Worker ──
  var cfg = window.SITE_CONFIG || {};
  var gateReady = !!(cfg.turnstileSiteKey && cfg.cvEndpoint);
  var dialog = document.getElementById('cvDialog');
  var statusEl = document.getElementById('cvStatus');
  var widgetId = null, tsPromise = null;

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function loadTurnstile() {
    if (tsPromise) return tsPromise;
    tsPromise = new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      sc.async = true;
      sc.onload = function () { resolve(window.turnstile); };
      sc.onerror = function () { tsPromise = null; reject(new Error('load')); };
      document.head.appendChild(sc);
    });
    return tsPromise;
  }

  function saveBlob(blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'Dylan-Loo-CV.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function onToken(token) {
    setStatus('Verified. Preparing your download…');
    fetch(cfg.cvEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.blob();
    }).then(function (blob) {
      saveBlob(blob);
      setStatus('Done. Check your downloads.');
      setTimeout(function () { if (dialog.open) dialog.close(); }, 1200);
    }).catch(function () {
      setStatus('That didn’t work. Please try again, or email me for the CV.', true);
      if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
    });
  }

  document.querySelectorAll('[data-cv]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!gateReady) {
        location.href = 'mailto:' + email + '?subject=' + encodeURIComponent('CV request');
        return;
      }
      setStatus('');
      dialog.showModal();
      loadTurnstile().then(function (ts) {
        if (widgetId === null) {
          widgetId = ts.render('#cvWidget', {
            sitekey: cfg.turnstileSiteKey,
            callback: onToken,
            'error-callback': function () { setStatus('Captcha failed to load. Please try again.', true); }
          });
        } else {
          ts.reset(widgetId);
        }
      }).catch(function () {
        setStatus('Couldn’t load the captcha. Please email me for the CV.', true);
      });
    });
  });

  // ── Count-up on the impact ledger ──
  function countUp(el) {
    var end = parseFloat(el.dataset.count);
    var prefix = el.dataset.prefix || '';
    var suffix = el.dataset.suffix || '';
    var start = null, dur = 1100;
    function frame(t) {
      if (start === null) start = t;
      var p = Math.min((t - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + Math.round(end * eased) + suffix;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ── Reveal-on-scroll + bar animation ──
  var targets = document.querySelectorAll('.case, .job, .card, .viz, .ledger');
  if (reduce || !('IntersectionObserver' in window)) return;

  targets.forEach(function (el) { el.classList.add('reveal'); });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      var tat = e.target.querySelector('.tat');
      if (tat) tat.classList.add('is-ready');
      if (e.target.classList.contains('ledger')) {
        e.target.querySelectorAll('[data-count]').forEach(countUp);
      }
      io.unobserve(e.target);
    });
  }, { threshold: 0.12 });
  targets.forEach(function (el) { io.observe(el); });
})();
