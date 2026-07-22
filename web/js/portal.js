// Public portal driver (extracted from portal.html so the page can ship a
// strict CSP with script-src 'self'). Self-contained: pulls workspace + KB
// from /api/v1/public/:slug/* and posts new tickets to the same root. No
// bundler, no SPA glue. window.RESPOVIA_API_BASE is set by js/api-base.js
// (loaded before this file); the || fallback below keeps local/preview safe.
    const API_BASE = (window.RESPOVIA_API_BASE || 'http://localhost:3001');
    const params = new URLSearchParams(location.search);
    // SLUG is resolved at boot from one of (in priority order):
    //   1. ?ws=<slug>            — explicit query param
    //   2. /resolve-host?host=…  — verified custom-domain claim
    //   3. 'demo'                — fallback for local dev
    // It's a let so the boot path can fill it in before everything
    // else uses it.
    let SLUG = params.get('ws') || null;
    let SESSION_KEY = ''; // re-derived once SLUG is known
    let ARTICLES = [];
    let SESSION = null;       // { token, customer: { id, display_id, name, email } }
    let CURRENT_VIEW = 'help'; // 'help' | 'tickets' | 'ticket-detail'
    let CURRENT_TICKET = null; // display_id when viewing a single ticket

    function escHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[ch]));
    }

    async function api(path, opts = {}) {
      const headers = {};
      if (opts.body) headers['Content-Type'] = 'application/json';
      // Attach session bearer for /customer/* — anon endpoints (KB, ticket
      // submit, kb-suggest, auth/*) ignore the header.
      if (SESSION?.token) headers['Authorization'] = `Bearer ${SESSION.token}`;
      const res = await fetch(`${API_BASE}/api/v1/public/${SLUG}${path}`, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (!res.ok) {
        // 401 on /customer/* → session expired; clear it + drop back to
        // help view so the user can re-sign-in.
        if (res.status === 401 && path.startsWith('/customer/')) {
          SESSION = null;
          localStorage.removeItem(SESSION_KEY);
          renderSessionUi();
          switchView('help');
        }
        const msg = (parsed && parsed.error) || res.statusText || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return parsed;
    }

    function saveSession(s) {
      SESSION = s;
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
      renderSessionUi();
    }
    function clearSession() {
      SESSION = null;
      try { localStorage.removeItem(SESSION_KEY); } catch {}
      renderSessionUi();
    }
    function loadSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (raw) SESSION = JSON.parse(raw);
      } catch {}
    }
    function renderSessionUi() {
      const who = document.getElementById('who');
      const inBtn = document.getElementById('sign-in');
      const outBtn = document.getElementById('sign-out');
      const tabs = document.getElementById('tabs');
      if (SESSION?.customer) {
        who.textContent = `Hi, ${SESSION.customer.name || SESSION.customer.email}`;
        inBtn.style.display  = 'none';
        outBtn.style.display = 'inline-block';
        tabs.style.display = 'flex';
      } else {
        who.textContent = '';
        inBtn.style.display  = 'inline-block';
        outBtn.style.display = 'none';
        tabs.style.display = 'none';
      }
    }
    function switchView(view) {
      CURRENT_VIEW = view;
      document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
      // CSAT view is mutually exclusive with everything else — when active,
      // hide the regular cards and the tabs entirely.
      const csat = view === 'csat';
      document.getElementById('card-csat').style.display            = csat ? 'block' : 'none';
      document.getElementById('card-kb').style.display              = !csat && view === 'help' ? 'block' : 'none';
      document.getElementById('card-form').style.display            = !csat && view === 'help' ? 'block' : 'none';
      document.getElementById('card-my-tickets').style.display      = !csat && view === 'tickets' ? 'block' : 'none';
      document.getElementById('card-ticket-detail').style.display   = !csat && view === 'ticket-detail' ? 'block' : 'none';
      document.getElementById('card-signin').style.display          = !csat && view === 'signin' ? 'block' : 'none';
      const tabs = document.getElementById('tabs');
      if (tabs && csat) tabs.style.display = 'none';
      if (view === 'tickets') refreshMyTickets();
    }
    document.querySelectorAll('#tabs button').forEach(b => {
      b.addEventListener('click', () => switchView(b.dataset.view));
    });

    document.getElementById('sign-in').addEventListener('click', () => switchView('signin'));
    document.getElementById('sign-out').addEventListener('click', () => {
      clearSession();
      switchView('help');
    });
    document.getElementById('si-cancel').addEventListener('click', () => {
      document.getElementById('signin-form').reset();
      document.getElementById('si-msg').style.display = 'none';
      document.getElementById('si-err').style.display = 'none';
      switchView('help');
    });

    document.getElementById('signin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('si-email').value.trim();
      const msgEl = document.getElementById('si-msg');
      const errEl = document.getElementById('si-err');
      msgEl.style.display = 'none';
      errEl.style.display = 'none';
      try {
        await api('/auth/request', { method: 'POST', body: { email, return_to: location.href.split('?')[0] + `?ws=${SLUG}` } });
        msgEl.textContent = `If ${email} is on file, a sign-in link is on the way. Open it on this device to land back here signed in.`;
        msgEl.style.display = 'block';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });

    async function refreshMyTickets() {
      const el = document.getElementById('my-tickets-list');
      el.innerHTML = '<div class="empty">Loading...</div>';
      try {
        const res = await api('/customer/tickets');
        if (!res.tickets || res.tickets.length === 0) {
          el.innerHTML = '<div class="empty">You haven\'t submitted any tickets yet.</div>';
          return;
        }
        el.innerHTML = res.tickets.map(t => `
          <a class="ticket-row" href="#" data-id="${escHtml(t.display_id)}">
            <div class="ticket-row-head">
              <span class="ticket-row-id">${escHtml(t.display_id)}</span>
              <span class="ticket-row-subj">${escHtml(t.subject)}</span>
              <span class="ticket-row-status" style="margin-left:auto">${escHtml(t.status_key)}</span>
            </div>
            <div class="ticket-row-id" style="margin-top:4px">Updated ${(t.updated_at || '').slice(0, 10)}</div>
          </a>`).join('');
        el.querySelectorAll('.ticket-row').forEach(row => {
          row.addEventListener('click', (ev) => { ev.preventDefault(); openCustomerTicket(row.dataset.id); });
        });
      } catch (err) {
        el.innerHTML = `<div class="err">${escHtml(err.message)}</div>`;
      }
    }

    async function openCustomerTicket(displayId) {
      CURRENT_TICKET = displayId;
      switchView('ticket-detail');
      const thread = document.getElementById('td-thread');
      document.getElementById('td-subject').textContent = '';
      document.getElementById('td-meta').textContent = 'Loading...';
      thread.innerHTML = '';
      try {
        const res = await api(`/customer/tickets/${encodeURIComponent(displayId)}`);
        const t = res.ticket;
        document.getElementById('td-subject').textContent = t.subject;
        document.getElementById('td-meta').textContent = `${t.display_id} · status ${t.status_key} · opened ${(t.created_at || '').slice(0, 10)}`;
        thread.innerHTML = (t.messages || []).map(m => `
          <div class="msg msg-${escHtml(m.role)}">
            <div class="msg-head">${escHtml(m.author_label)} · ${(m.created_at || '').slice(0, 16).replace('T', ' ')}</div>
            <div class="msg-body">${escHtml(m.body)}</div>
          </div>`).join('');
      } catch (err) {
        document.getElementById('td-meta').textContent = err.message;
      }
    }

    document.getElementById('td-back').addEventListener('click', () => {
      CURRENT_TICKET = null;
      switchView('tickets');
    });

    document.getElementById('reply-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = document.getElementById('td-submit');
      const errEl  = document.getElementById('td-err');
      const ta     = document.getElementById('td-reply');
      const body   = ta.value.trim();
      if (!body || !CURRENT_TICKET) return;
      errEl.style.display = 'none';
      submit.disabled = true;
      submit.textContent = 'Sending...';
      try {
        await api(`/customer/tickets/${encodeURIComponent(CURRENT_TICKET)}/messages`, { method: 'POST', body: { body } });
        ta.value = '';
        await openCustomerTicket(CURRENT_TICKET);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Send reply';
      }
    });

    // If the URL carries ?token=..., that's a magic link the customer
    // just clicked — verify + drop into the My Tickets view.
    async function maybeConsumeMagicToken() {
      const token = params.get('token');
      if (!token) return;
      try {
        const res = await api('/auth/verify', { method: 'POST', body: { token } });
        saveSession({ token: res.session_token, customer: res.customer });
        // Drop the token from the URL so a refresh doesn't try to re-use
        // the (now-consumed) magic link.
        const clean = new URL(location.href);
        clean.searchParams.delete('token');
        history.replaceState({}, '', clean.toString());
        switchView('tickets');
      } catch (err) {
        // Token expired / already used — surface in the sign-in panel.
        switchView('signin');
        const errEl = document.getElementById('si-err');
        errEl.textContent = `Sign-in link is invalid or expired (${err.message}). Request a new one below.`;
        errEl.style.display = 'block';
      }
    }

    function renderKBList(filter = '') {
      const list = document.getElementById('kb-list');
      const ql = filter.toLowerCase().trim();
      const matches = ql
        ? ARTICLES.filter(a =>
            a.title.toLowerCase().includes(ql) ||
            (a.body || '').toLowerCase().includes(ql) ||
            (a.category || '').toLowerCase().includes(ql))
        : ARTICLES;
      if (matches.length === 0) {
        list.innerHTML = '<div class="empty">No articles match your search.</div>';
        return;
      }
      list.innerHTML = matches.map(a => `
        <div class="kb-row" data-id="${escHtml(a.id)}">
          <div>
            <span class="kb-cat">${escHtml(a.category || 'Help')}</span>
            <span class="kb-title">${escHtml(a.title)}</span>
          </div>
          <div class="kb-meta">${a.view_count || 0} views · last updated ${(a.updated_at || '').slice(0, 10)}</div>
        </div>
        <div class="kb-body-wrap">${escHtml(a.body)}</div>`).join('');
      list.querySelectorAll('.kb-row').forEach(el => {
        el.addEventListener('click', () => el.classList.toggle('open'));
      });
    }

    async function boot() {
      try {
        const [cfg, kb] = await Promise.all([api('/config'), api('/kb-articles')]);
        const ws = cfg.workspace;
        document.getElementById('ws-name').textContent = ws.name;
        document.title = `${ws.name} — Help`;
        if (ws.primary_color) {
          document.documentElement.style.setProperty('--accent', ws.primary_color);
        }
        // Workspace-customizable surface area. Each block falls back to
        // its hardcoded default when the column is null — keeps fresh
        // workspaces from rendering a blank brand.
        if (ws.logo_url) {
          const logoEl = document.getElementById('ws-logo');
          logoEl.src = ws.logo_url;
          logoEl.style.display = 'block';
        }
        if (ws.portal_tagline) {
          document.getElementById('ws-tagline').textContent = ws.portal_tagline;
        }
        if (ws.portal_intro) {
          const introEl = document.getElementById('ws-intro');
          introEl.textContent = ws.portal_intro;
          introEl.style.display = 'block';
        }
        if (ws.portal_footer) {
          document.getElementById('ws-footer').textContent = ws.portal_footer;
        }
        ARTICLES = kb.articles || [];
        renderKBList();
      } catch (err) {
        const el = document.getElementById('boot-err');
        el.textContent = `Couldn't load this workspace: ${err.message}`;
        el.style.display = 'block';
      }
    }

    // ─── CSAT survey flow ───────────────────────────────────────────────
    //
    // Triggered when the URL carries ?csat=<token>. We load the ticket
    // context, render the star picker + comment field, and post the
    // rating to the public CSAT endpoint. Token also serves as the
    // session — no portal sign-in required.
    let CSAT_TOKEN = null;
    let CSAT_SCORE = 0;
    function renderCsatStars() {
      const wrap = document.getElementById('csat-stars');
      wrap.innerHTML = [1,2,3,4,5].map((n) => {
        const filled = n <= CSAT_SCORE;
        return `<span data-score="${n}" style="color:${filled ? 'var(--accent)' : 'var(--rule2)'};transition:color .1s">${filled ? '★' : '☆'}</span>`;
      }).join('');
      wrap.querySelectorAll('[data-score]').forEach((el) => {
        el.addEventListener('click', () => {
          CSAT_SCORE = Number(el.dataset.score);
          renderCsatStars();
          document.getElementById('csat-submit').disabled = false;
        });
      });
    }
    async function loadCsatSurvey(token) {
      CSAT_TOKEN = token;
      switchView('csat');
      try {
        const data = await api(`/csat/${encodeURIComponent(token)}`);
        if (data.ticket.submitted_at) {
          document.getElementById('csat-content').style.display = 'none';
          document.getElementById('csat-thanks').textContent =
            `You already rated this ticket ${data.ticket.score}/5 — thanks!`;
          document.getElementById('csat-thanks').style.display = 'block';
          return;
        }
        const name = data.ticket.customer_name ? `Hi ${data.ticket.customer_name},` : 'Hi,';
        document.getElementById('csat-title').textContent = `${name} how did we do?`;
        document.getElementById('csat-subject').textContent =
          `Ticket ${data.ticket.display_id}: ${data.ticket.subject}`;
        renderCsatStars();
      } catch (err) {
        document.getElementById('csat-content').style.display = 'none';
        document.getElementById('csat-thanks').textContent =
          `This survey link is no longer valid (${err.message}).`;
        document.getElementById('csat-thanks').style.background = 'var(--red-lt)';
        document.getElementById('csat-thanks').style.color = 'var(--red)';
        document.getElementById('csat-thanks').style.display = 'block';
      }
    }
    document.getElementById('csat-submit').addEventListener('click', async () => {
      if (!CSAT_TOKEN || !CSAT_SCORE) return;
      const btn = document.getElementById('csat-submit');
      const errEl = document.getElementById('csat-err');
      errEl.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Submitting...';
      try {
        await api(`/csat/${encodeURIComponent(CSAT_TOKEN)}`, {
          method: 'POST',
          body: { score: CSAT_SCORE, comment: document.getElementById('csat-comment').value.trim() || null },
        });
        document.getElementById('csat-content').style.display = 'none';
        document.getElementById('csat-thanks').style.display = 'block';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Submit rating';
      }
    });

    document.getElementById('kb-search').addEventListener('input', (e) => renderKBList(e.target.value));

    // ─── AI-suggested KB articles ───────────────────────────────────────
    //
    // Fires when subject + body are both non-trivial, debounced so we
    // don't hammer Anthropic on every keystroke. Customer can dismiss
    // ("No, still need help") to hide the panel and proceed to submit,
    // or click an article to expand its full body inline.
    let aiTimer = null;
    let aiLastQuery = '';
    let aiDismissed = false;

    function compositeQuery() {
      const subj = document.getElementById('t-subject').value.trim();
      const body = document.getElementById('t-body').value.trim();
      if (subj.length < 4 || body.length < 12) return null;
      return `${subj}\n\n${body}`;
    }

    function clearAiPanel() {
      const panel = document.getElementById('ai-panel');
      panel.classList.remove('shown', 'thinking');
      document.getElementById('ai-list').innerHTML = '';
    }

    async function fetchAiSuggestions() {
      if (aiDismissed) return;
      const query = compositeQuery();
      if (!query || query === aiLastQuery) return;
      aiLastQuery = query;
      const panel = document.getElementById('ai-panel');
      panel.classList.add('shown', 'thinking');
      document.getElementById('ai-list').innerHTML = '<div style="font-size:12px;color:var(--ink3)">Looking for relevant help articles</div>';
      try {
        const res = await api('/kb-suggest', { method: 'POST', body: { question: query } });
        if (!res.suggestions || res.suggestions.length === 0) {
          clearAiPanel();
          return;
        }
        const byId = Object.fromEntries(ARTICLES.map((a) => [a.display_id, a]));
        const html = res.suggestions.map((s) => {
          const a = byId[s.article_id];
          if (!a) return '';
          return `
            <a class="ai-sugg" href="#" data-id="${escHtml(a.id)}">
              <span class="kb-cat">${escHtml(a.category || 'Help')}</span>
              <span class="ai-sugg-title">${escHtml(a.title)}</span>
              <span class="ai-sugg-conf">${Math.round(s.confidence)}%</span>
              <div class="ai-sugg-reason">${escHtml(s.reason)}</div>
            </a>`;
        }).join('');
        document.getElementById('ai-list').innerHTML = html;
        panel.classList.remove('thinking');
        // Clicking a suggestion scrolls to + expands the matching KB
        // article in the search list above. Lets the customer read the
        // full body without leaving the page or losing their draft.
        panel.querySelectorAll('.ai-sugg').forEach(el => {
          el.addEventListener('click', (ev) => {
            ev.preventDefault();
            const id = el.dataset.id;
            const target = document.querySelector(`.kb-row[data-id="${id}"]`);
            if (target) {
              target.classList.add('open');
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
        });
      } catch (err) {
        clearAiPanel();
      }
    }

    function scheduleAi() {
      if (aiDismissed) return;
      if (aiTimer) clearTimeout(aiTimer);
      aiTimer = setTimeout(fetchAiSuggestions, 800);
    }
    document.getElementById('t-subject').addEventListener('input', scheduleAi);
    document.getElementById('t-body').addEventListener('input', scheduleAi);

    document.getElementById('ai-resolved').addEventListener('click', () => {
      // Wipe the form + show a success state. No ticket is created —
      // the suggestion itself counts as the resolution.
      document.getElementById('ticket-form').reset();
      aiDismissed = false;
      aiLastQuery = '';
      clearAiPanel();
      const okEl = document.getElementById('t-ok');
      okEl.textContent = "Glad we could help. Submit the form below if you need to reach us about anything else.";
      okEl.style.display = 'block';
    });
    document.getElementById('ai-dismiss').addEventListener('click', () => {
      aiDismissed = true;
      clearAiPanel();
    });

    document.getElementById('ticket-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = document.getElementById('t-submit');
      const errEl  = document.getElementById('t-err');
      const okEl   = document.getElementById('t-ok');
      errEl.style.display = 'none';
      okEl.style.display  = 'none';
      submit.disabled = true;
      submit.textContent = 'Sending...';
      try {
        const body = {
          name:    document.getElementById('t-name').value.trim(),
          email:   document.getElementById('t-email').value.trim(),
          subject: document.getElementById('t-subject').value.trim(),
          body:    document.getElementById('t-body').value.trim(),
        };
        const res = await api('/tickets', { method: 'POST', body });
        okEl.textContent = `Got it — your request is logged as ${res.ticket.display_id}. We'll email you back at ${body.email}.`;
        okEl.style.display = 'block';
        document.getElementById('ticket-form').reset();
        aiDismissed = false;
        aiLastQuery = '';
        clearAiPanel();
      } catch (err) {
        errEl.textContent = `Couldn't send: ${err.message}`;
        errEl.style.display = 'block';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Send';
      }
    });

    // Resolve the workspace slug then run the rest of the boot
    // sequence. The /resolve-host call is best-effort: if it 404s
    // (host not claimed) or errors out, we fall back to 'demo' so
    // local dev keeps working without any DNS plumbing.
    async function resolveSlug() {
      if (SLUG) return SLUG;
      try {
        const res = await fetch(`${API_BASE}/api/v1/public/resolve-host?host=${encodeURIComponent(location.host)}`);
        if (res.ok) {
          const data = await res.json();
          if (data?.slug) return data.slug;
        }
      } catch (err) {
        console.warn('[portal] resolve-host failed:', err);
      }
      return 'demo';
    }

    (async () => {
      SLUG = await resolveSlug();
      SESSION_KEY = `maestro_portal_session_${SLUG}`;
      loadSession();
      renderSessionUi();
      // If the URL carries a CSAT token, render the survey instead of
      // the regular help view. boot() still runs so workspace branding
      // loads for the survey header.
      const csatTokenParam = params.get('csat');
      if (csatTokenParam) {
        boot().then(() => loadCsatSurvey(csatTokenParam));
      } else {
        boot().then(maybeConsumeMagicToken);
      }
    })();
