/* Mobile job search front end for ai-job-search results.
 * No build step, no dependencies. Works two ways:
 *  - with web/server.py: jobs, marks and criteria go through /api/*
 *  - as a static site: jobs from data/jobs.json, marks/criteria in this browser
 */
(() => {
  "use strict";

  const MIN_WAGE = 12.71; // UK National Living Wage (21+) from April 2026
  const LS = { marks: "jf.marks", criteria: "jf.criteria", prefs: "jf.prefs", token: "jf.token", gh: "jf.github" };
  const GH_DEFAULTS = { owner: "sfxhewitt", repo: "job-searcher", branch: "main", token: "" };
  const GH_PATHS = { jobs: "web/data/jobs.json", marks: "web/data/marks.json", criteria: "search_criteria.json", apply: "web/data/apply_requests.json" };
  // "Apply for me" requests: [{ key, url, title, company, requested_at, updated_at, status, note? }]
  // status: requested -> drafted -> applied (set by the apply workflow), or cancelled / failed.
  const APPLY_LABEL = { requested: "Apply requested", drafted: "Application drafted", applied: "Applied for you", failed: "Couldn't apply", cancelled: "" };
  const DEFAULT_CRITERIA = {
    // Generic defaults: the real criteria come from search_criteria.json in the private repo.
    candidate: "", locations: [], remote_ok: true, hours: "any", school_hours: false,
    sectors_include: [], sectors_exclude: [],
    min_hourly_pay: MIN_WAGE, keywords: [], notes: "",
  };

  const state = {
    mode: "server",          // "server" | "github" | "static"
    jobs: [],
    source: "",
    sample: false,
    applyRequests: [],
    marks: {},               // key -> { state: "saved"|"applied"|"hidden"|undefined, seen: bool, note: string, updated: iso }
    criteria: { ...DEFAULT_CRITERIA },
    tab: "all",
    query: "",
    sort: "score",
    filters: new Set(["match"]),
    showHidden: false,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------- storage helpers ----------
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // Access token: ?token=... on first visit is remembered and then removed from the URL.
  (() => {
    const params = new URLSearchParams(location.search);
    const t = params.get("token");
    if (t) {
      ls.set(LS.token, t);
      params.delete("token");
      history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : "") + location.hash);
    }
  })();

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = ls.get(LS.token, "");
    if (token) headers["X-Access-Token"] = token;
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...opts, headers, cache: "no-store" });
    if (!res.ok) throw Object.assign(new Error(`${path}: ${res.status}`), { status: res.status });
    return res.json();
  }

  // ---------- GitHub backend ----------
  // The hosted page holds no personal data. Jobs, marks and criteria live in the
  // private repo and are read/written with a fine-grained token kept on this device.
  const gh = {
    cfg() { return { ...GH_DEFAULTS, ...ls.get(LS.gh, {}) }; },
    configured() { return !!this.cfg().token; },
    shas: {},
    url(path) {
      const c = this.cfg();
      return `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${path}`;
    },
    headers() {
      return { Authorization: `Bearer ${this.cfg().token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    },
    async read(path, fallback) {
      const res = await fetch(`${this.url(path)}?ref=${encodeURIComponent(this.cfg().branch)}&t=${Date.now()}`, { headers: this.headers(), cache: "no-store" });
      if (res.status === 404) { delete this.shas[path]; return fallback; }
      if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
      const meta = await res.json();
      this.shas[path] = meta.sha;
      let textContent;
      if (meta.content && meta.encoding === "base64") {
        const bin = atob(meta.content.replace(/\n/g, ""));
        textContent = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
      } else if (meta.download_url) { // files over 1 MB come without inline content
        const raw = await fetch(this.url(path) + `?ref=${encodeURIComponent(this.cfg().branch)}`, { headers: { ...this.headers(), Accept: "application/vnd.github.raw+json" } });
        textContent = await raw.text();
      }
      try { return JSON.parse(textContent); } catch { return fallback; }
    },
    async write(path, data, message, merge) {
      const body = (content, sha) => JSON.stringify({
        message, branch: this.cfg().branch, sha,
        content: toBase64(JSON.stringify(content, null, 2) + "\n"),
      });
      let content = data;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(this.url(path), { method: "PUT", headers: { ...this.headers(), "Content-Type": "application/json" }, body: body(content, this.shas[path]) });
        if (res.ok) { this.shas[path] = (await res.json()).content.sha; return; }
        if (res.status === 409 || res.status === 422) {
          // Someone else (another phone) changed it: re-read, merge, retry.
          const remote = await this.read(path, {});
          content = merge ? merge(remote, content) : content;
          continue;
        }
        throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
      }
      throw new Error("GitHub: too many conflicting edits");
    },
  };

  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // Newest edit per job wins when two devices save marks at the same time.
  // Merge apply requests by job key; whichever side touched an entry last wins,
  // so status updates from the apply workflow are never overwritten by an older copy.
  function mergeApply(remote, local) {
    const byKey = new Map();
    for (const r of Array.isArray(remote) ? remote : []) if (r && r.key) byKey.set(r.key, r);
    for (const l of Array.isArray(local) ? local : []) {
      if (!l || !l.key) continue;
      const r = byKey.get(l.key);
      const t = (x) => String(x.updated_at || x.requested_at || "");
      if (!r || t(l) > t(r)) byKey.set(l.key, l);
    }
    return [...byKey.values()];
  }

  function mergeMarks(remote, local) {
    const out = { ...(remote || {}) };
    for (const [k, v] of Object.entries(local || {})) {
      if (!out[k] || String(v.updated || "") >= String(out[k].updated || "")) out[k] = v;
    }
    return out;
  }

  async function loadGithub() {
    const [jobs, marks, criteria] = await Promise.all([
      gh.read(GH_PATHS.jobs, null), gh.read(GH_PATHS.marks, {}), gh.read(GH_PATHS.criteria, {}),
    ]);
    state.applyRequests = await gh.read(GH_PATHS.apply, []).catch(() => []);
    state.mode = "github";
    if (jobs) applyJobs({ jobs: toJobList(jobs), source: `${gh.cfg().repo}/${GH_PATHS.jobs}`, sample: false });
    else applyJobs({ jobs: [], source: "", sample: false });
    state.marks = marks && typeof marks === "object" ? marks : {};
    state.criteria = normaliseCriteria(criteria);
  }

  async function loadAll() {
    $("#refresh-btn").classList.add("spinning");
    let banner = null;
    try {
      if (gh.configured()) {
        try { await loadGithub(); }
        catch (err) {
          banner = err.status === 401 || err.status === 403 || err.status === 404
            ? "GitHub didn't accept the access key. Check it under Criteria → Connect to GitHub."
            : "Couldn't reach GitHub. Showing what's saved on this phone.";
          await loadStatic();
        }
      } else {
        try {
          const [jobs, marks, criteria] = await Promise.all([api("api/jobs"), api("api/marks"), api("api/criteria")]);
          state.applyRequests = await api("api/apply").catch(() => []);
          state.mode = "server";
          applyJobs(jobs);
          state.marks = marks && typeof marks === "object" ? marks : {};
          state.criteria = normaliseCriteria(criteria);
        } catch (err) {
          if (err.status === 401) {
            banner = "This list is protected. Open the link with ?token=… that the server printed.";
            state.jobs = [];
          } else {
            await loadStatic();
          }
        }
      }
    } finally {
      $("#refresh-btn").classList.remove("spinning");
    }
    updateBanner(banner);
    fillCriteriaForm();
    fillGithubForm();
    render();
  }

  async function loadStatic() {
    state.mode = "static";
    let data = null;
    for (const [url, sample] of [["data/jobs.json", false], ["sample/seen_jobs.sample.json", true]]) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) { data = await res.json(); data = { raw: data, source: url, sample }; break; }
      } catch { /* try next */ }
    }
    if (data) applyJobs({ jobs: toJobList(data.raw), source: data.source, sample: data.sample });
    state.marks = ls.get(LS.marks, {});
    state.criteria = normaliseCriteria(ls.get(LS.criteria, null) || {});
  }

  function toJobList(raw) {
    const seen = raw && !Array.isArray(raw) ? (raw.seen || raw) : raw;
    if (Array.isArray(seen)) return seen.map((j, i) => ({ key: j.key || j.url || String(i), ...j }));
    if (seen && typeof seen === "object") {
      return Object.entries(seen).filter(([, v]) => v && typeof v === "object").map(([key, v]) => ({ key, ...v }));
    }
    return [];
  }

  function applyJobs(payload) {
    state.jobs = (payload.jobs || []).filter((j) => j && j.title).map(enrich);
    state.source = payload.source || "";
    state.sample = !!payload.sample;
  }

  let saveTimer = null;
  function saveMarks() {
    if (state.mode === "static") { ls.set(LS.marks, state.marks); return; }
    clearTimeout(saveTimer);
    if (state.mode === "github") {
      // Each save is a commit, so batch quick taps and typing into one.
      saveTimer = setTimeout(() => {
        gh.write(GH_PATHS.marks, state.marks, "Update saved jobs from Job Finder", mergeMarks)
          .then(() => {})
          .catch(() => { ls.set(LS.marks, state.marks); toast("Couldn't save to GitHub. Kept on this phone for now."); });
      }, 2500);
      return;
    }
    saveTimer = setTimeout(() => {
      api("api/marks", { method: "PUT", body: JSON.stringify(state.marks) })
        .catch(() => { ls.set(LS.marks, state.marks); toast("Couldn't reach the server. Saved on this phone for now."); });
    }, 300);
  }

  // ---------- job text analysis ----------
  const text = (j) => [j.title, j.hours, j.description, j.salary, j.location].filter(Boolean).join(" \n ");

  function parseTimeRanges(s) {
    const out = [];
    const re = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b|\b(\d{1,2})[:.](\d{2})\s*(?:-|–|—|to|until)\s*(\d{1,2})[:.](\d{2})\b/gi;
    let m;
    while ((m = re.exec(s))) {
      let h1, m1, ap1, h2, m2, ap2;
      if (m[1] !== undefined) { [h1, m1, ap1, h2, m2, ap2] = [+m[1], +(m[2] || 0), m[3], +m[4], +(m[5] || 0), m[6]]; }
      else { [h1, m1, h2, m2] = [+m[7], +m[8], +m[9], +m[10]]; }
      ap1 = ap1 && ap1.toLowerCase(); ap2 = ap2 && ap2.toLowerCase();
      if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) continue;
      const to24 = (h, ap, isEnd, other) => {
        if (ap === "pm" && h < 12) return h + 12;
        if (ap === "am" && h === 12) return 0;
        if (ap) return h;
        if (h >= 13) return h;
        // No am/pm: shop hours. Small end times are afternoon; start inherits sensible daytime.
        if (isEnd) return h <= 8 ? h + 12 : h;
        return other === "pm" && h < 12 && h <= 8 ? h + 12 : h;
      };
      const start = to24(h1, ap1 || (ap2 === "am" ? "am" : undefined), false, ap2) + m1 / 60;
      const end = to24(h2, ap2, true, ap1) + m2 / 60;
      out.push([start, end]);
    }
    return out;
  }

  function schoolHours(j) {
    const s = text(j).toLowerCase();
    if (/\b(evening|night|overnight|late shift|weekends? only)\b/.test(s)) return false;
    if (/school hours|term[- ]time|school[- ]friendly|parent[- ]friendly|around the school run/.test(s)) return true;
    const ranges = parseTimeRanges(s);
    return ranges.length > 0 && ranges.every(([a, b]) => a >= 8.75 && b <= 15.25 && b > a);
  }

  function parsePay(j) {
    const s = String(j.salary || j.pay || "");
    if (!s) return null;
    const low = s.toLowerCase();
    if (/^\s*(not stated|not specified|competitive|n\/a|unknown)/.test(low)) return { hourly: null, label: s, unstated: true };
    if (/minimum wage|living wage|\bnmw\b|\bnlw\b/.test(low) && !/£\s*\d/.test(low)) {
      return { hourly: MIN_WAGE, label: "Minimum wage" };
    }
    const nums = [...s.matchAll(/£\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s*(k)?/gi)]
      .map((m) => parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1));
    if (!nums.length) {
      const bare = [...s.matchAll(/(\d+(?:\.\d{1,2})?)/g)].map((m) => parseFloat(m[1]));
      if (bare.length && /hour|ph\b|p\/h|hr\b/.test(low)) nums.push(...bare);
    }
    if (!nums.length) return { hourly: null, label: s };
    const top = Math.max(...nums);
    const hourlyHint = /hour|\bph\b|p\/h|\/hr|\bhr\b/.test(low);
    const annualHint = /year|annum|\bpa\b|p\.a\.|annual/.test(low) || top >= 1000;
    let hourly = null;
    // Use the top of a range: UK ranges usually start at youth rates ("£8.28 - £12.71, age dependent").
    if (hourlyHint || (!annualHint && top < 100)) hourly = top;
    else if (annualHint) hourly = top / (52 * 37.5); // full-time equivalent estimate
    return { hourly, label: s };
  }

  const isRemote = (j) => /\b(remote|work from home|home[- ]based|wfh|hybrid)\b/i.test(`${j.location || ""} ${j.title || ""}`);
  const isFullTime = (j) => /\bfull[- ]time\b/i.test(`${j.title || ""} ${j.hours || ""}`) && !/\bpart[- ]time\b/i.test(`${j.title || ""} ${j.hours || ""}`);

  function enrich(j) {
    const pay = parsePay(j);
    return {
      ...j,
      _school: schoolHours(j),
      _remote: isRemote(j),
      _fullTime: isFullTime(j),
      _pay: pay,
      _hourly: pay && pay.hourly,
      _haystack: [j.title, j.company, j.location, j.description, j.hours, j.salary].filter(Boolean).join(" ").toLowerCase(),
    };
  }

  const isLocal = (j) => {
    const loc = (j.location || "").toLowerCase();
    return (state.criteria.locations || []).some((l) => l && loc.includes(l.toLowerCase()));
  };
  const excludedTerm = (j) => {
    const hay = `${j.title || ""} ${j.company || ""} ${j.description || ""}`.toLowerCase();
    return (state.criteria.sectors_exclude || []).find((t) => t && new RegExp(`\\b${escapeRe(t.toLowerCase())}`).test(hay));
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function matchesCriteria(j) {
    const c = state.criteria;
    if (excludedTerm(j)) return false;
    if (j.location_verdict === "FAIL" || j.language_gate === "FAIL") return false;
    const placeOk = isLocal(j) || (c.remote_ok && j._remote) || !(c.locations || []).length;
    if (!placeOk) return false;
    if (c.hours === "part-time" && j._fullTime) return false;
    if (c.min_hourly_pay && j._hourly != null && j._hourly + 0.005 < Number(c.min_hourly_pay)) return false;
    return true;
  }

  // ---------- rendering ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  const mark = (k) => state.marks[k] || {};
  const applyReq = (k) => (Array.isArray(state.applyRequests) ? state.applyRequests : []).find((r) => r.key === k && r.status !== "cancelled");
  const fmtDate = (d) => {
    if (!d) return "";
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt)) return esc(d);
    return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const daysUntil = (d) => { if (!d) return null; const t = new Date(d + "T23:59:59"); return isNaN(t) ? null : Math.ceil((t - Date.now()) / 864e5); };
  const fitClass = (j) => {
    if (typeof j.rank_score === "number") return j.rank_score >= 70 ? "fit-high" : j.rank_score >= 50 ? "fit-medium" : "fit-low";
    return { high: "fit-high", medium: "fit-medium", low: "fit-low" }[(j.fit || "").toLowerCase()] || "fit-none";
  };
  const fitLabel = (j) => (typeof j.rank_score === "number" ? String(Math.round(j.rank_score)) : (j.fit ? j.fit[0].toUpperCase() + j.fit.slice(1) : "–"));
  const payText = (j) => {
    if (!j._pay || j._pay.unstated) return "";
    if (j._pay.hourly != null && /hour|minimum|living/i.test(j._pay.label)) return j._pay.label.length > 28 ? `£${j._pay.hourly.toFixed(2)}/hr` : j._pay.label;
    return j._pay.label.length > 28 ? j._pay.label.slice(0, 26) + "…" : j._pay.label;
  };

  function visibleJobs() {
    const q = state.query.trim().toLowerCase();
    let list = state.jobs.filter((j) => j.status !== "expired" || q);
    if (state.tab === "saved") list = list.filter((j) => mark(j.key).state === "saved");
    else if (state.tab === "applied") list = list.filter((j) => mark(j.key).state === "applied" || applyReq(j.key));
    else {
      if (!state.showHidden) list = list.filter((j) => mark(j.key).state !== "hidden");
      const f = state.filters;
      if (f.has("match")) list = list.filter(matchesCriteria);
      if (f.has("school")) list = list.filter((j) => j._school);
      if (f.has("local")) list = list.filter(isLocal);
      if (f.has("remote")) list = list.filter((j) => j._remote);
      if (f.has("high")) list = list.filter((j) => fitClass(j) === "fit-high");
      if (f.has("new")) list = list.filter((j) => !mark(j.key).seen);
    }
    if (q) list = list.filter((j) => q.split(/\s+/).every((w) => j._haystack.includes(w)));

    const score = (j) => (typeof j.rank_score === "number" ? j.rank_score : { high: 60, medium: 45, low: 25 }[(j.fit || "").toLowerCase()] ?? 0)
      + (state.criteria.school_hours && j._school ? 8 : 0);
    const date = (j) => j.posted_date || j.first_seen || "";
    const sorters = {
      score: (a, b) => score(b) - score(a) || date(b).localeCompare(date(a)),
      newest: (a, b) => date(b).localeCompare(date(a)) || score(b) - score(a),
      deadline: (a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999") || score(b) - score(a),
      pay: (a, b) => (b._hourly ?? -1) - (a._hourly ?? -1) || score(b) - score(a),
    };
    return list.sort(sorters[state.sort] || sorters.score);
  }

  const ICON = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l5 5L20 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.8 3.3M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a8.7 8.7 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px"><path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9.5" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  function actionButtons(j) {
    const s = mark(j.key).state;
    return `
      <button class="act" data-act="saved" data-key="${esc(j.key)}" aria-pressed="${s === "saved"}">${ICON.star}<span>${s === "saved" ? "Saved" : "Save"}</span></button>
      <button class="act" data-act="applied" data-key="${esc(j.key)}" aria-pressed="${s === "applied"}">${ICON.check}<span>${s === "applied" ? "Applied" : "Applied?"}</span></button>
      <button class="act" data-act="hidden" data-key="${esc(j.key)}" aria-pressed="${s === "hidden"}">${ICON.hide}<span>${s === "hidden" ? "Hidden" : "Not for me"}</span></button>`;
  }

  function tags(j) {
    const t = [];
    const ar = applyReq(j.key);
    if (ar && APPLY_LABEL[ar.status]) t.push(`<span class="tag ${ar.status === "failed" ? "warn" : "good"}">${esc(APPLY_LABEL[ar.status])}</span>`);
    if (j.location) t.push(`<span class="tag">${ICON.pin}${esc(j.location)}</span>`);
    const pay = payText(j);
    if (pay) t.push(`<span class="tag${j._hourly != null && j._hourly > MIN_WAGE + 0.25 ? " good" : ""}">${esc(pay)}</span>`);
    if (j._school) t.push('<span class="tag good">School hours</span>');
    else if (j.hours) t.push(`<span class="tag">${esc(j.hours.length > 30 ? j.hours.slice(0, 28) + "…" : j.hours)}</span>`);
    if (j._remote && !/remote/i.test(j.location || "")) t.push('<span class="tag">Remote</span>');
    const d = daysUntil(j.deadline);
    if (d != null) t.push(`<span class="tag${d <= 3 ? " warn" : ""}">${d < 0 ? "Closed" : d === 0 ? "Closes today" : `Closes ${fmtDate(j.deadline)}`}</span>`);
    const ex = excludedTerm(j);
    if (ex) t.push(`<span class="tag warn">Mentions “${esc(ex)}”</span>`);
    if (j.status === "expired") t.push('<span class="tag warn">Expired</span>');
    return t.join("");
  }

  function render() {
    const listView = state.tab !== "criteria";
    $("#view-jobs").hidden = !listView;
    $("#view-criteria").hidden = listView;
    $("#list-controls").hidden = !listView;
    $("#filter-chips").hidden = state.tab !== "all";
    $("#screen-title").textContent = { all: "Jobs", saved: "Saved", applied: "Applied", criteria: "Search criteria" }[state.tab];
    $$(".tab").forEach((b) => (b.dataset.tab === state.tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    $$(".chip").forEach((c) => c.setAttribute("aria-pressed", state.filters.has(c.dataset.filter)));
    const local = $('[data-filter="local"]');
    if (local) local.textContent = (state.criteria.locations && state.criteria.locations[0]) || "Local";

    const savedN = state.jobs.filter((j) => mark(j.key).state === "saved").length;
    const badge = $("#saved-count");
    badge.hidden = !savedN; badge.textContent = savedN;

    if (!listView) return;
    const list = visibleJobs();
    $("#result-count").textContent = `${list.length} job${list.length === 1 ? "" : "s"}`;
    $("#job-list").innerHTML = list.map((j) => {
      const m = mark(j.key);
      return `<li class="card${m.state === "hidden" ? " is-hidden" : ""}">
        <button class="card-main" data-open="${esc(j.key)}">
          <div class="card-head">
            ${!m.seen ? '<span class="dot-new" title="Not opened yet"></span>' : ""}
            <div style="flex:1;min-width:0">
              <p class="card-title">${esc(j.title)}</p>
              <div class="card-company">${esc(j.company || "")}</div>
            </div>
            <span class="score ${fitClass(j)}" title="Match">${esc(fitLabel(j))}</span>
          </div>
          <div class="meta">${tags(j)}</div>
        </button>
        <div class="card-actions">${actionButtons(j)}</div>
      </li>`;
    }).join("");

    const empty = $("#empty");
    empty.hidden = list.length > 0;
    if (!list.length) {
      const hiddenN = state.jobs.filter((j) => mark(j.key).state === "hidden").length;
      if (!state.jobs.length && state.mode === "static") empty.innerHTML = '<strong>Connect to see jobs</strong>Add your GitHub access key under <button class="link-btn" data-goto-criteria>Criteria</button>.';
      else if (!state.jobs.length) empty.innerHTML = "<strong>No jobs yet</strong>They'll appear here after the next search.";
      else if (state.tab === "saved") empty.innerHTML = "<strong>Nothing saved yet</strong>Tap Save on a job to keep it here.";
      else if (state.tab === "applied") empty.innerHTML = "<strong>No applications yet</strong>Tap Applied? on a job once you've applied.";
      else empty.innerHTML = `<strong>No jobs match</strong>Try turning off a filter.${state.filters.size ? '<br><button class="link-btn" data-clear-filters>Clear filters</button>' : ""}${hiddenN && !state.showHidden ? `<br><button class="link-btn" data-show-hidden>Show ${hiddenN} hidden</button>` : ""}`;
    }
  }

  function openDetail(key) {
    const j = state.jobs.find((x) => x.key === key);
    if (!j) return;
    setMark(key, { seen: true }, false);
    const url = safeUrl(j.url);
    const list = (arr) => (Array.isArray(arr) && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    const facts = [
      ["Where", j.location],
      ["Pay", j._pay && j._pay.label],
      ["Hours", j.hours],
      ["Posted", j.posted_date && fmtDate(j.posted_date)],
      ["Closes", j.deadline ? fmtDate(j.deadline) : null],
      ["Found", j.first_seen && fmtDate(j.first_seen)],
      ["Fit", j.rank_verdict || j.fit],
      ["Source", j.portal],
    ].filter(([, v]) => v);
    $("#detail-body").innerHTML = `
      <h2 id="detail-title">${esc(j.title)}</h2>
      <div class="card-company">${esc(j.company || "")}</div>
      <div class="meta">${j._school ? '<span class="tag good">School hours</span>' : ""}${j._remote ? '<span class="tag">Remote</span>' : ""}<span class="tag score ${fitClass(j)}" style="height:auto">${typeof j.rank_score === "number" ? `Match ${Math.round(j.rank_score)}/100` : `Fit: ${esc(j.fit || "not rated")}`}</span></div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${j.description ? `<h3>About the job</h3><p>${esc(j.description)}</p>` : ""}
      ${list(j.strengths) ? `<h3>Why it fits</h3>${list(j.strengths)}` : ""}
      ${list(j.gaps) ? `<h3>Watch out for</h3>${list(j.gaps)}` : ""}
      ${j.language_note ? `<h3>Language</h3><p>${esc(j.language_note)}</p>` : ""}
      ${url ? `<a class="primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ICON.ext} Open job advert</a>` : ""}
      <div id="apply-box">${applyBox(j)}</div>
      <div class="sheet-actions card-actions" style="border:0">${actionButtons(j)}</div>
      <h3>Notes</h3>
      <textarea class="notes" data-note="${esc(j.key)}" placeholder="E.g. called the shop, interview Tuesday 10am">${esc(mark(key).note || "")}</textarea>`;
    const dlg = $("#detail");
    if (!dlg.open) dlg.showModal();
    $("#detail .sheet-inner").scrollTop = 0;
    render();
  }

  function applyBox(j) {
    const r = applyReq(j.key);
    if (state.mode === "static") return "";
    if (!r) return `<button type="button" class="secondary" data-apply="${esc(j.key)}">I like this job, apply for me</button>`;
    const msg = {
      requested: "Application requested. It'll be drafted on the next run, and you'll see it change here.",
      drafted: "Application drafted. Check it before it's sent.",
      applied: "Applied for you.",
      failed: "Couldn't apply automatically" + (r.note ? `: ${r.note}` : "."),
    }[r.status] || `Status: ${r.status}`;
    return `<p class="apply-status ${r.status === "failed" ? "is-warn" : ""}">${esc(msg)}</p>`
      + (r.status === "requested" ? `<button type="button" class="link-btn" data-apply-cancel="${esc(j.key)}">Cancel request</button>` : "");
  }

  let applySaving = Promise.resolve();
  function saveApply() {
    const data = state.applyRequests;
    const run = async () => {
      if (state.mode === "github") await gh.write(GH_PATHS.apply, data, "Apply-for-me request from Job Finder", mergeApply);
      else await api("api/apply", { method: "PUT", body: JSON.stringify(data) });
    };
    applySaving = applySaving.then(run, run);
    return applySaving;
  }

  async function requestApply(key) {
    const j = state.jobs.find((x) => x.key === key);
    if (!j) return;
    if (!confirm(`Ask for an application to ${j.title}${j.company ? ` at ${j.company}` : ""}?`)) return;
    const now = new Date().toISOString();
    const entry = { key, url: j.url || "", title: j.title, company: j.company || "", requested_at: now, updated_at: now, status: "requested" };
    state.applyRequests = mergeApply(state.applyRequests, [entry]);
    refreshApplyBox(key);
    try { await saveApply(); toast("Application requested"); }
    catch { state.applyRequests = state.applyRequests.filter((r) => r !== entry); refreshApplyBox(key); toast("Couldn't send the request. Try again."); }
  }

  async function cancelApply(key) {
    const r = applyReq(key);
    if (!r || r.status !== "requested") return;
    const cancelled = { ...r, status: "cancelled", updated_at: new Date().toISOString() };
    state.applyRequests = mergeApply(state.applyRequests, [cancelled]);
    refreshApplyBox(key);
    try { await saveApply(); toast("Request cancelled"); }
    catch { toast("Couldn't cancel. Try again."); }
  }

  function refreshApplyBox(key) {
    const box = $("#apply-box");
    const j = state.jobs.find((x) => x.key === key);
    if (box && j) box.innerHTML = applyBox(j);
    render();
  }

  function setMark(key, patch, rerender = true) {
    const prev = state.marks[key] || {};
    const next = { ...prev, ...patch, updated: new Date().toISOString() };
    if (!next.state) delete next.state;
    state.marks[key] = next;
    saveMarks();
    if (rerender) render();
    return prev;
  }

  function toggleState(key, s) {
    const prev = mark(key).state;
    const nextState = prev === s ? undefined : s;
    setMark(key, { state: nextState, seen: true });
    if ($("#detail").open) refreshDetailActions(key);
    if (nextState === "hidden") toast("Hidden from your list", () => { setMark(key, { state: prev }); if ($("#detail").open) refreshDetailActions(key); });
    else if (nextState === "saved") toast("Saved");
    else if (nextState === "applied") toast("Marked as applied. Good luck!");
  }

  function refreshDetailActions(key) {
    const j = state.jobs.find((x) => x.key === key);
    const box = $("#detail .sheet-actions");
    if (j && box) box.innerHTML = actionButtons(j);
  }

  // ---------- criteria ----------
  const toList = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
  function normaliseCriteria(c) {
    const out = { ...DEFAULT_CRITERIA, ...(c || {}) };
    for (const k of ["locations", "sectors_include", "sectors_exclude", "keywords"]) out[k] = toList(out[k]);
    out.min_hourly_pay = out.min_hourly_pay === "" || out.min_hourly_pay == null ? null : Number(out.min_hourly_pay);
    out.remote_ok = !!out.remote_ok; out.school_hours = !!out.school_hours;
    return out;
  }
  function fillCriteriaForm() {
    const f = $("#criteria-form"); const c = state.criteria;
    for (const el of f.elements) {
      if (!el.name || !(el.name in c)) continue;
      if (el.type === "checkbox") el.checked = !!c[el.name];
      else el.value = Array.isArray(c[el.name]) ? c[el.name].join(", ") : (c[el.name] ?? "");
    }
  }
  async function saveCriteria(e) {
    e.preventDefault();
    const f = e.target; const data = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      data[el.name] = el.type === "checkbox" ? el.checked : el.value;
    }
    state.criteria = normaliseCriteria(data);
    const status = $("#criteria-status");
    if (state.mode === "static") {
      ls.set(LS.criteria, state.criteria);
      status.textContent = "Saved on this phone only. Connect to GitHub below so the search can use it.";
    } else if (state.mode === "github") {
      try {
        await gh.write(GH_PATHS.criteria, state.criteria, "Update search criteria from Job Finder");
        status.textContent = "Saved to GitHub. The next search will use these settings.";
      } catch {
        ls.set(LS.criteria, state.criteria);
        status.textContent = "Couldn't save to GitHub, so this is saved on this phone only.";
      }
    } else {
      try {
        await api("api/criteria", { method: "PUT", body: JSON.stringify(state.criteria) });
        status.textContent = "Saved. The next search will use these settings.";
      } catch {
        ls.set(LS.criteria, state.criteria);
        status.textContent = "Couldn't reach the server, so this is saved on this phone only.";
      }
    }
    toast("Criteria saved");
    render();
  }

  // ---------- banner / toast ----------
  function showBanner(msg) { const b = $("#banner"); b.textContent = msg; b.hidden = !msg; }
  function updateBanner(msg) {
    if (msg) showBanner(msg);
    else if (state.sample) showBanner("Showing sample jobs. Connect to GitHub (Criteria tab) to see the real list.");
    else showBanner("");
  }

  // ---------- GitHub connection form ----------
  function fillGithubForm() {
    const f = $("#github-form"); if (!f) return;
    const c = gh.cfg();
    f.elements.repo.value = `${c.owner}/${c.repo}`;
    f.elements.token.value = "";
    f.elements.token.placeholder = c.token ? "Saved on this phone (enter a new one to replace)" : "github_pat_…";
    $("#github-status").textContent = state.mode === "github"
      ? `Connected to ${c.owner}/${c.repo}.`
      : c.token ? "Not connected: GitHub didn't accept the key." : "Not connected.";
    $("#github-disconnect").hidden = !c.token;
  }
  async function saveGithub(e) {
    e.preventDefault();
    const f = e.target;
    const [owner, repo] = f.elements.repo.value.trim().split("/").map((s) => s.trim());
    const prev = gh.cfg();
    const token = f.elements.token.value.trim() || prev.token;
    if (!owner || !repo || !token) { $("#github-status").textContent = "Enter the repo (owner/name) and an access key."; return; }
    ls.set(LS.gh, { ...prev, owner, repo, token });
    await loadAll();
    toast(state.mode === "github" ? "Connected to GitHub" : "Couldn't connect. Check the key.");
  }
  let toastTimer = null;
  function toast(msg, undo) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? "<button type=\"button\">Undo</button>" : ""}`;
    t.hidden = false;
    if (undo) t.querySelector("button").onclick = () => { undo(); t.hidden = true; };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), undo ? 5000 : 2200);
  }

  // ---------- events ----------
  function savePrefs() { ls.set(LS.prefs, { filters: [...state.filters], sort: state.sort }); }
  (() => {
    const p = ls.get(LS.prefs, null);
    if (p) { state.filters = new Set(p.filters || []); state.sort = p.sort || "score"; }
    $("#sort").value = state.sort;
  })();

  document.addEventListener("click", (e) => {
    const ap = e.target.closest("[data-apply]");
    if (ap) { requestApply(ap.dataset.apply); return; }
    const apc = e.target.closest("[data-apply-cancel]");
    if (apc) { cancelApply(apc.dataset.applyCancel); return; }
    const act = e.target.closest("[data-act]");
    if (act) { toggleState(act.dataset.key, act.dataset.act); return; }
    const open = e.target.closest("[data-open]");
    if (open) { openDetail(open.dataset.open); return; }
    const chip = e.target.closest(".chip");
    if (chip) {
      const f = chip.dataset.filter;
      state.filters.has(f) ? state.filters.delete(f) : state.filters.add(f);
      savePrefs(); render(); return;
    }
    const tab = e.target.closest(".tab");
    if (tab) { state.tab = tab.dataset.tab; state.showHidden = false; render(); window.scrollTo({ top: 0 }); return; }
    if (e.target.closest("[data-clear-filters]")) { state.filters.clear(); savePrefs(); render(); return; }
    if (e.target.closest("[data-show-hidden]")) { state.showHidden = true; render(); return; }
    if (e.target.closest("[data-goto-criteria]")) { state.tab = "criteria"; render(); $("#github-form").scrollIntoView(); return; }
  });

  let qTimer = null;
  $("#search").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.query = e.target.value; render(); }, 120); });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; savePrefs(); render(); });
  $("#refresh-btn").addEventListener("click", () => loadAll().then(() => toast("Up to date")));
  $("#criteria-form").addEventListener("submit", saveCriteria);
  $("#github-form").addEventListener("submit", saveGithub);
  $("#github-disconnect").addEventListener("click", () => {
    ls.set(LS.gh, { ...gh.cfg(), token: "" });
    loadAll().then(() => toast("Disconnected. The key was removed from this phone."));
  });

  const dlg = $("#detail");
  $("#detail-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("input", (e) => {
    const ta = e.target.closest("[data-note]");
    if (ta) setMark(ta.dataset.note, { note: ta.value }, false);
  });
  // Swipe down on the sheet handle area to close.
  let y0 = null;
  dlg.addEventListener("touchstart", (e) => { const inner = $(".sheet-inner", dlg); y0 = inner.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  dlg.addEventListener("touchend", (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) dlg.close(); y0 = null; });

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.mode !== "static") loadAll(); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Exposed for tests.
  window.__jf = { parsePay, schoolHours, parseTimeRanges, state, mergeMarks, mergeApply };

  loadAll();
})();
