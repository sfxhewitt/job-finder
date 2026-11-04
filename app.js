/* Mobile job search front end for ai-job-search results.
 * No build step, no dependencies. Works two ways:
 *  - with web/server.py: jobs, marks and criteria go through /api/*
 *  - as a static site: jobs from data/jobs.json, marks/criteria in this browser
 */
(() => {
  "use strict";

  const MIN_WAGE = 12.71; // UK National Living Wage (21+) from April 2026
  const LS = { marks: "jf.marks", criteria: "jf.criteria", prefs: "jf.prefs", token: "jf.token", gh: "jf.github", pushAsked: "jf.pushAsked" };
  const GH_DEFAULTS = { owner: "sfxhewitt", repo: "job-searcher", branch: "main", token: "" };
  // Public half of the push-alert key pair (safe to publish); web/data/push_config.json overrides it.
  const VAPID_PUBLIC_KEY = "BO-R6-cReseLgpsr98DUHB-BoIhZTI_dnCTbTM6zxqkI9UcjEcGgReiRPWqEI24JK8p42ASAIDsgs0wFps3qazs";
  const GH_PATHS = { jobs: "web/data/jobs.json", marks: "web/data/marks.json", criteria: "search_criteria.json", docs: "web/data/documents.json", applyStatus: "web/data/apply_status.json", pushConfig: "web/data/push_config.json", pushSubs: "web/data/push_subscriptions.json", docsDir: "documents/applications" };
  const DEFAULT_CRITERIA = {
    // Generic defaults: the real criteria come from search_criteria.json in the private repo.
    candidate: "", locations: [], remote_ok: true, hours: "part-time", contract: "permanent", school_hours: false,
    sectors_include: [], sectors_exclude: [],
    min_hourly_pay: MIN_WAGE, keywords: [], notes: "",
  };

  let docDirs = null;  // cached list of documents/applications folders
  const state = {
    mode: "server",          // "server" | "github" | "static"
    jobs: [],
    source: "",
    sample: false,
    docs: {},
    applyStatus: {},         // job key -> { status, note, updated } written by the apply run
    pushKey: "",             // VAPID public key from web/data/push_config.json (empty = alerts not set up yet)                // job key -> [{ label, path }] prepared CVs / cover letters
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
    state.docs = await gh.read(GH_PATHS.docs, {}).catch(() => ({}));
    state.applyStatus = await gh.read(GH_PATHS.applyStatus, {}).then((x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {})).catch(() => ({}));
    state.pushKey = await gh.read(GH_PATHS.pushConfig, {}).then((c) => (c && c.vapid_public_key) || VAPID_PUBLIC_KEY).catch(() => VAPID_PUBLIC_KEY);
    docDirs = null;
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
    renderPushRow();
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

  // Temporary / seasonal / fixed-term postings (dropped when the contract switch is "permanent").
  const isTemp = (j) => {
    const head = `${j.title || ""} ${j.hours || ""} ${j.contract || ""} ${j.job_type || ""}`;
    return /\b(temporary|temp|seasonal|christmas|xmas|festive|fixed[- ]term|peak)\b/i.test(head)
      || /\b(temporary|fixed[- ]term|seasonal) (contract|role|position|post)\b/i.test(j.description || "");
  };

  function enrich(j) {
    const pay = parsePay(j);
    return {
      ...j,
      _school: schoolHours(j),
      _remote: isRemote(j),
      _fullTime: isFullTime(j),
      _temp: isTemp(j),
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
    if (c.hours === "full-time" && /\bpart[- ]time\b/i.test(`${j.title || ""} ${j.hours || ""}`)) return false;
    if (c.contract === "permanent" && j._temp) return false;
    if (c.min_hourly_pay && j._hourly != null && j._hourly + 0.005 < Number(c.min_hourly_pay)) return false;
    return true;
  }


  // ---------- formatting helpers ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  const mark = (k) => state.marks[k] || {};
  const fmtDate = (d) => {
    if (!d) return "";
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt)) return String(d);
    return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const daysUntil = (d) => { if (!d) return null; const t = new Date(d + "T23:59:59"); return isNaN(t) ? null : Math.ceil((t - Date.now()) / 864e5); };
  const ago = (d) => {
    if (!d) return "";
    const t = new Date(d + "T12:00:00"); if (isNaN(t)) return "";
    const days = Math.round((Date.now() - t) / 864e5);
    if (days <= 0) return "Today"; if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`; if (days < 14) return "1 week ago";
    if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
    return fmtDate(d);
  };
  const fitClass = (j) => {
    if (typeof j.rank_score === "number") return j.rank_score >= 70 ? "fit-high" : j.rank_score >= 50 ? "fit-medium" : "fit-low";
    return { high: "fit-high", medium: "fit-medium", low: "fit-low" }[(j.fit || "").toLowerCase()] || "fit-none";
  };
  const fitText = (j) => {
    if (typeof j.rank_score === "number") return `${Math.round(j.rank_score)}% match`;
    return { "fit-high": "Great match", "fit-medium": "Good match", "fit-low": "Weak match" }[fitClass(j)] || "";
  };
  // Pay shown big on the card: "£13.28" + "/hr", or the original text when it can't be parsed.
  function payParts(j) {
    const p = j._pay;
    if (!p || p.unstated) return null;
    if (p.label === "Minimum wage") return { big: `£${MIN_WAGE.toFixed(2)}`, unit: "/hr" };
    if (p.hourly != null && /hour|\bph\b|p\/h|\bhr\b/i.test(p.label)) {
      const from = /^\s*from\b/i.test(p.label) ? "From " : "";
      const est = /estimat/i.test(p.label) ? " est." : "";
      return { big: `${from}£${p.hourly.toFixed(2)}`, unit: `/hr${est}` };
    }
    const short = p.label.replace(/\s*\(.*?\)\s*/g, " ").trim();
    return { big: short.length > 26 ? short.slice(0, 24) + "…" : short, unit: "" };
  }
  const AV_COLOURS = ["#4B3BF5", "#FF5A36", "#0E9F6E", "#D6336C", "#1C7ED6", "#E67700", "#7048E8", "#0B7285", "#C2255C", "#2F9E44"];
  function avatar(j, cls = "") {
    const name = (j.company || j.title || "?").replace(/^(the|example)\s+/i, "");
    const initials = name.split(/[\s&()-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
    let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="avatar ${cls}" style="--av:${AV_COLOURS[h % AV_COLOURS.length]}" aria-hidden="true">${esc(initials)}</span>`;
  }

  // ---------- list ----------
  function visibleJobs() {
    const q = state.query.trim().toLowerCase();
    let list = state.jobs.filter((j) => j.status !== "expired" || q);
    if (state.tab === "saved") list = list.filter((j) => mark(j.key).state === "saved");
    else if (state.tab === "applied") list = list.filter((j) => mark(j.key).state === "applied").sort((a, b) => String(mark(b.key).applied_at || "").localeCompare(String(mark(a.key).applied_at || "")));
    else {
      if (!state.showHidden) list = list.filter((j) => mark(j.key).state !== "hidden");
      const f = state.filters;
      if (f.has("match")) list = list.filter(matchesCriteria);
      if (f.has("school")) list = list.filter((j) => j._school);
      if (f.has("local")) list = list.filter(isLocal);
      if (f.has("remote")) list = list.filter((j) => j._remote);
      if (f.has("high")) list = list.filter((j) => fitClass(j) === "fit-high");
      if (f.has("new")) list = list.filter((j) => !mark(j.key).seen);
      if (f.has("paid")) list = list.filter((j) => j._pay && !j._pay.unstated);
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

  const I = (d, extra = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
  const ICON = {
    bookmark: I('<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
    x: I('<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
    send: I('<path d="M22 3 11 14M22 3l-7 18-4-7-7-4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>'),
    check: I('<path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    pin: I('<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="9.5" r="2.4" fill="none" stroke="currentColor" stroke-width="2.2"/>'),
    clock: I('<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    sun: I('<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    cal: I('<rect x="4" y="5" width="16" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M4 10h16M9 3v4M15 3v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    home: I('<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>'),
    ext: I('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    doc: I('<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M14 3v4h4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    search: I('<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    spark: I('<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>'),
    key: I('<circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m11 12 9-9M17 6l3 3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  };

  function chips(j, { full = false } = {}) {
    const t = [];
    const am = mark(j.key);
    if (am.state === "saved" && !full && state.mode === "github") t.push(docsReady(j.key) ? `<span class="chip hl">${ICON.doc}Documents ready</span>` : `<span class="chip">${ICON.doc}Preparing documents</span>`);
    const ap = applyInfo(j.key);
    if (ap && !full) t.push(`<span class="chip ${ap.cls}">${ICON.send}${esc(ap.short)}</span>`);
    else if (j.auto_apply && !full) t.push(j.auto_apply.qualifies ? `<span class="chip good">${ICON.spark}Auto-apply eligible</span>` : `<span class="chip">Manual</span>`);
    if (am.state === "applied" && !full) t.push(`<span class="chip brand">${ICON.check}Applied${am.applied_at ? ` ${esc(fmtDate(String(am.applied_at).slice(0, 10)))}` : ""}</span>`);
    if (j.location && !full) t.push(`<span class="chip">${ICON.pin}${esc(j.location)}</span>`);
    if (j._school) t.push(`<span class="chip hl">${ICON.sun}School hours</span>`);
    else if (j.hours && !full) {
      const h = j.hours.split(/[;,]/)[0].trim();
      t.push(`<span class="chip">${ICON.clock}${esc(h.length > 26 ? h.slice(0, 24) + "…" : h)}</span>`);
    }
    if (j._remote && !/remote/i.test(j.location || "")) t.push(`<span class="chip">${ICON.home}Remote</span>`);
    const d = daysUntil(j.deadline);
    if (d != null) t.push(`<span class="chip${d <= 3 ? " warn" : ""}">${ICON.cal}${d < 0 ? "Closed" : d === 0 ? "Closes today" : d <= 7 ? `${d} day${d === 1 ? "" : "s"} left` : `Closes ${esc(fmtDate(j.deadline))}`}</span>`);
    const ex = excludedTerm(j);
    if (ex) t.push(`<span class="chip bad">Mentions “${esc(ex)}”</span>`);
    if (j.status === "expired") t.push('<span class="chip bad">Expired</span>');
    return t.join("");
  }

  function payHtml(j) {
    const p = payParts(j);
    if (!p) return '<span class="pay none">Pay not stated</span>';
    const good = j._hourly != null && j._hourly > MIN_WAGE + 0.25;
    return `<span class="pay${good ? " good" : ""}">${esc(p.big)}${p.unit ? `<small>${esc(p.unit)}</small>` : ""}</span>`;
  }

  function cardHtml(j, i) {
    const m = mark(j.key);
    const saved = m.state === "saved";
    const applied = m.state === "applied";
    const foot = [ago(j.posted_date || j.first_seen), j.portal && j.portal !== "websearch" ? j.portal.replace(/-search$/, "") : ""].filter(Boolean).join(" · ");
    const applyBtn = `<button class="icon-pill ${applied ? "status" : "apply"}" data-act="applied" data-key="${esc(j.key)}" aria-pressed="${applied}">${ICON.check}${applied ? "Applied" : "I've applied"}</button>`;
    return `<li class="swipe" data-key="${esc(j.key)}" style="--i:${Math.min(i, 12)}">
      <div class="swipe-bg" aria-hidden="true"><span class="l">${ICON.bookmark}Save</span><span class="r">Not for me${ICON.x}</span></div>
      <article class="card${m.state === "hidden" ? " is-hidden" : ""}">
        <button class="save-fab" data-act="saved" data-key="${esc(j.key)}" aria-pressed="${saved}" aria-label="${saved ? "Saved" : "Save"}">${ICON.bookmark}</button>
        <button class="card-tap" data-open="${esc(j.key)}">
          <div class="card-top">
            ${avatar(j)}
            <div class="card-titles">
              <p class="card-title">${!m.seen ? '<span class="new-dot" title="New"></span>' : ""}${esc(j.title)}</p>
              <div class="card-company">${esc(j.company || "")}</div>
            </div>
          </div>
          <div class="pay-line">${payHtml(j)}<span class="match ${fitClass(j)}">${esc(fitText(j))}</span></div>
          <div class="chips">${chips(j)}</div>
        </button>
        <div class="card-foot">
          <span class="foot-meta">${esc(foot)}</span>
          <button class="icon-pill" data-act="hidden" data-key="${esc(j.key)}" aria-label="${m.state === "hidden" ? "Show again" : "Not for me"}">${m.state === "hidden" ? "Undo" : ICON.x}</button>
          ${applyBtn}
        </div>
      </article>
    </li>`;
  }

  const EMPTY_ICON = {
    jobs: ICON.search, saved: ICON.bookmark, applied: ICON.send, key: ICON.key,
  };
  function emptyHtml(icon, title, body, btn = "") {
    return `<div class="em-icon">${EMPTY_ICON[icon]}</div><strong>${title}</strong>${body}${btn}`;
  }

  let heroScrolled = false;
  function updateHero() {
    const y = window.scrollY;
    const room = document.documentElement.scrollHeight - window.innerHeight;
    if (!heroScrolled && y > 140 && room > 300) heroScrolled = true;
    else if (heroScrolled && (y < 8 || room < 120)) heroScrolled = false;
    $("#hero").classList.toggle("compact", state.tab !== "all" || heroScrolled);
  }

  function render() {
    const listView = state.tab !== "criteria";
    $("#view-jobs").hidden = !listView;
    $("#view-criteria").hidden = listView;
    $("#list-controls").hidden = !listView;
    $("#scope").hidden = state.tab !== "all";
    updateHero();
    const name = (state.criteria.candidate || "").trim().split(/\s+/)[0];
    const hr = new Date().getHours();
    $("#greeting").textContent = `${hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"}${name ? `, ${name}` : ""}`;
    $("#screen-title").textContent = { all: "Jobs for you", saved: "Saved jobs", applied: "Applications", criteria: "Settings" }[state.tab];
    $$(".tab").forEach((b) => (b.dataset.tab === state.tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));

    const scopeVal = state.filters.has("match") ? "match" : "all";
    $("#scope").dataset.value = scopeVal;
    $$("#scope button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.scope === scopeVal)));
    const extra = [...state.filters].filter((f) => f !== "match").length + (state.sort !== "score" ? 1 : 0);
    const fc = $("#filter-count"); fc.hidden = !extra; fc.textContent = extra;
    $$("#filter-toggles .toggle").forEach((t) => t.setAttribute("aria-pressed", String(state.filters.has(t.dataset.filter))));
    $("#local-label").textContent = (state.criteria.locations && state.criteria.locations[0]) || "Nearby";
    $$('#sort-pills input').forEach((r) => (r.checked = r.value === state.sort));

    const savedN = state.jobs.filter((j) => mark(j.key).state === "saved").length;
    const badge = $("#saved-count"); badge.hidden = !savedN; badge.textContent = savedN;

    if (!listView) return;
    if (state.loading && !state.jobs.length) {
      $("#result-count").textContent = "Loading…"; $("#sort-label").textContent = "";
      $("#job-list").innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
      $("#empty").hidden = true;
      return;
    }
    const list = visibleJobs();
    $("#result-count").textContent = `${list.length} job${list.length === 1 ? "" : "s"}`;
    $("#sort-label").textContent = { score: "Best match first", newest: "Newest first", deadline: "Closing soon first", pay: "Highest pay first" }[state.sort];
    $("#job-list").innerHTML = list.map(cardHtml).join("");

    const empty = $("#empty");
    empty.hidden = list.length > 0;
    if (!list.length) {
      const hiddenN = state.jobs.filter((j) => mark(j.key).state === "hidden").length;
      if (!state.jobs.length && state.mode === "static") empty.innerHTML = emptyHtml("key", "Connect your job list", "Add your access key in Settings to see the real jobs.", '<br><button class="btn btn-primary" data-goto-criteria>Open settings</button>');
      else if (!state.jobs.length) empty.innerHTML = emptyHtml("jobs", "No jobs yet", "They'll appear here after the next search.");
      else if (state.tab === "saved") empty.innerHTML = emptyHtml("saved", "Nothing saved yet", "Tap the bookmark on a job, or swipe it right, to keep it here.");
      else if (state.tab === "applied") empty.innerHTML = emptyHtml("applied", "No applications yet", "When you've applied for a job, tap “I've applied” and it'll be listed here with the date.");
      else empty.innerHTML = emptyHtml("jobs", "No jobs match", "Try fewer filters, or look at all jobs.",
        `<br><button class="btn btn-soft" data-clear-filters>Show all jobs</button>${hiddenN && !state.showHidden ? `<br><button class="link" data-show-hidden>Show ${hiddenN} you hid</button>` : ""}`);
    }
  }

  // ---------- swipe gestures ----------
  // Swipe right to save, left for "not for me". Vertical scrolling stays native (touch-action: pan-y).
  (() => {
    let s = null;
    const list = $("#job-list");
    list.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const li = e.target.closest(".swipe"); if (!li) return;
      s = { li, card: $(".card", li), x0: e.clientX, y0: e.clientY, dx: 0, active: false, id: e.pointerId };
    });
    list.addEventListener("pointermove", (e) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      if (!s.active) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }
        if (Math.abs(dx) < 12) return;
        s.active = true; s.card.classList.add("dragging");
        try { s.card.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      s.dx = dx;
      s.card.style.transform = `translateX(${dx}px) rotate(${dx / 60}deg)`;
      s.li.dataset.dir = dx > 0 ? "right" : "left";
    });
    const end = () => {
      if (!s) return;
      const { li, card, dx, active } = s; s = null;
      if (!active) return;
      card.classList.remove("dragging");
      const key = li.dataset.key;
      const w = li.offsetWidth;
      if (Math.abs(dx) > Math.min(110, w * 0.3)) {
        suppressClick = true; setTimeout(() => (suppressClick = false), 50);
        if (navigator.vibrate) navigator.vibrate(10);
        if (dx > 0) {
          card.style.transform = "";
          delete li.dataset.dir;
          if (mark(key).state !== "saved") toggleState(key, "saved");
          else toast("Already saved");
        } else {
          card.style.transform = `translateX(${-w * 1.2}px) rotate(-8deg)`;
          li.style.setProperty("--leave-x", "-110%");
          setTimeout(() => toggleState(key, "hidden"), 180);
        }
      } else {
        card.style.transform = "";
        setTimeout(() => delete li.dataset.dir, 250);
        if (Math.abs(dx) > 12) { suppressClick = true; setTimeout(() => (suppressClick = false), 50); }
      }
    };
    list.addEventListener("pointerup", end);
    list.addEventListener("pointercancel", () => { if (s) { s.card.style.transform = ""; s.card.classList.remove("dragging"); delete s.li.dataset.dir; s = null; } });
  })();
  let suppressClick = false;

  // ---------- sheets ----------
  function openSheet(dlg) { dlg.classList.remove("closing"); if (!dlg.open) dlg.showModal(); }
  function closeSheet(dlg) {
    if (!dlg.open || dlg.classList.contains("closing")) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { dlg.close(); return; }
    dlg.classList.add("closing");
    setTimeout(() => { dlg.classList.remove("closing"); dlg.close(); }, 220);
  }
  for (const dlg of $$("dialog.sheet")) {
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeSheet(dlg); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeSheet(dlg); });
    let y0 = null;
    const scroller = $(".sheet-scroll", dlg);
    dlg.addEventListener("touchstart", (e) => { y0 = scroller.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    dlg.addEventListener("touchmove", (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0) { dlg.style.transform = `translateY(${dy}px)`; dlg.style.transition = "none"; }
    }, { passive: true });
    dlg.addEventListener("touchend", (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0; y0 = null;
      dlg.style.transition = "transform .25s cubic-bezier(.2,.8,.2,1)";
      if (dy > 110) { dlg.style.transform = "translateY(100%)"; setTimeout(() => { dlg.close(); dlg.style.transform = ""; dlg.style.transition = ""; }, 220); }
      else { dlg.style.transform = ""; }
    });
  }

  // ---------- job detail ----------
  function openDetail(key) {
    const j = state.jobs.find((x) => x.key === key);
    if (!j) return;
    state.openKey = key;
    setMark(key, { seen: true }, false);
    renderDetail(j);
    if (!Array.isArray(state.docs[key])) findDocs(j).then(() => { if (state.openKey === key && $("#docs-box")) $("#docs-box").innerHTML = docsHtml(j); });
    const dlg = $("#detail");
    openSheet(dlg);
    $("#detail .sheet-scroll").scrollTop = 0;
    render();
  }

  function renderDetail(j) {
    const url = safeUrl(j.url);
    const m = mark(j.key);
    const bl = (arr, cls = "") => (Array.isArray(arr) && arr.length ? `<ul class="bullets ${cls}">${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    const p = payParts(j);
    const stats = [
      p ? `<div class="stat pay-stat"><dt>Pay</dt><dd>${esc(p.big)}${esc(p.unit)}</dd></div>` : `<div class="stat"><dt>Pay</dt><dd>Not stated</dd></div>`,
      `<div class="stat"><dt>Match</dt><dd>${esc(fitText(j) || j.rank_verdict || "Not rated")}</dd></div>`,
      j.hours ? `<div class="stat wide"><dt>Hours</dt><dd>${esc(j.hours)}</dd></div>` : "",
      j.location ? `<div class="stat"><dt>Where</dt><dd>${esc(j.location)}</dd></div>` : "",
      `<div class="stat"><dt>Closes</dt><dd>${j.deadline ? esc(fmtDate(j.deadline)) : "No date given"}</dd></div>`,
      j._pay && p && p.big !== j._pay.label && !j._pay.unstated ? `<div class="stat wide"><dt>Pay as advertised</dt><dd>${esc(j._pay.label)}</dd></div>` : "",
    ].join("");
    const posted = [j.posted_date && `Posted ${ago(j.posted_date).toLowerCase()}`, j.portal && j.portal !== "sample" && `via ${j.portal.replace(/-search$/, "")}`].filter(Boolean).join(" · ");
    $("#detail-body").innerHTML = `
      <div class="d-head">${avatar(j)}<div><h2 class="d-title" id="detail-title">${esc(j.title)}</h2><div class="d-company">${esc(j.company || "")}</div></div></div>
      <div class="chips d-chips">${chips(j, { full: true })}</div>
      <dl class="stats">${stats}</dl>
      <div id="apply-box">${applyStatusHtml(j)}</div>
      ${url ? `<a class="btn btn-ghost btn-block open-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ICON.ext} Open the job advert</a>` : ""}
      <div id="docs-box">${docsHtml(j)}</div>
      <div id="autoapply-box">${applyForMeHtml(j)}</div>
      ${j.description ? `<div class="section"><h3>About the job</h3><p>${esc(j.description)}</p></div>` : ""}
      ${bl(j.strengths) ? `<div class="section"><h3>Why it fits</h3>${bl(j.strengths)}</div>` : ""}
      ${bl(j.gaps) ? `<div class="section"><h3>Worth checking</h3>${bl(j.gaps, "warn")}</div>` : ""}
      ${j.language_note ? `<div class="section"><h3>Language</h3><p>${esc(j.language_note)}</p></div>` : ""}
      <div class="section"><h3>Notes</h3><textarea class="notes" data-note="${esc(j.key)}" placeholder="E.g. called the shop, interview Tuesday 10am">${esc(m.note || "")}</textarea></div>
      ${posted ? `<p class="hint center">${esc(posted)}</p>` : ""}`;
    renderDetailBar(j);
  }

  function renderDetailBar(j) {
    const m = mark(j.key);
    const main = m.state === "applied"
      ? `<button class="btn btn-soft grow" data-act="applied" data-key="${esc(j.key)}" aria-pressed="true">${ICON.check}Applied${m.applied_at ? ` ${esc(fmtDate(String(m.applied_at).slice(0, 10)))}` : ""}</button>`
      : `<button class="btn btn-accent grow" data-act="applied" data-key="${esc(j.key)}" aria-pressed="false">${ICON.check}I've applied</button>`;
    $("#detail-bar").innerHTML = `
      <button class="btn btn-ghost square" data-act="hidden" data-key="${esc(j.key)}" aria-pressed="${m.state === "hidden"}" aria-label="Not for me">${ICON.x}</button>
      <button class="btn btn-ghost square" data-act="saved" data-key="${esc(j.key)}" aria-pressed="${m.state === "saved"}" aria-label="${m.state === "saved" ? "Saved" : "Save"}">${ICON.bookmark}</button>
      ${main}`;
  }

  function applyStatusHtml(j) {
    const m = mark(j.key);
    if (m.state !== "applied") return "";
    const when = m.applied_at ? `On ${fmtDate(String(m.applied_at).slice(0, 10))}` : "";
    return `<div class="apply-card"><span class="ac-icon">${ICON.check}</span><div><b>You've applied</b><span>${esc(when || "Good luck!")}</span></div></div>`;
  }

  // ---------- apply for me (Claude applies after Daniel's tap) ----------
  // A tap sets marks[key].apply_requested_at; the apply run reports back in web/data/apply_status.json.
  const APPLY_STATUS = {
    ready_manual: { short: "Apply by hand", title: "Ready to apply by hand", cls: "hl" },
    awaiting_tap: { short: "Needs your OK", title: "Waiting for your OK", cls: "warn" },
    submitted: { short: "Submitted by Claude", title: "Application submitted by Claude", cls: "good" },
    blocked: { short: "Couldn't apply", title: "Claude couldn't apply", cls: "bad" },
  };
  function applyInfo(key) {
    const m = mark(key);
    const st = state.applyStatus[key];
    const req = m.apply_requested_at ? String(m.apply_requested_at) : "";
    if (req && (!st || !st.updated || new Date(req) > new Date(st.updated))) {
      return { pending: true, short: "Apply requested", title: "Requested, waiting for Claude", note: "Claude picks requests up within the hour.", cls: "brand" };
    }
    if (st && APPLY_STATUS[st.status]) return { ...APPLY_STATUS[st.status], status: st.status, note: st.note || "", updated: st.updated };
    if (st && st.status) return { short: st.status, title: st.status, note: st.note || "", cls: "", status: st.status };
    return null;
  }
  function applyForMeHtml(j) {
    if (state.mode !== "github") return "";
    const a = j.auto_apply;
    const ap = applyInfo(j.key);
    const badge = a ? `<span class="chip ${a.qualifies ? "good" : ""}">${a.qualifies ? ICON.spark + "Auto-apply eligible" : "Manual"}</span>` : "";
    const reasons = a && !a.qualifies && Array.isArray(a.reasons) && a.reasons.length
      ? `<details class="why"><summary>Why manual?</summary><ul class="bullets warn">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : "";
    const status = ap ? `<div class="apply-card ${ap.pending ? "pending" : ap.status === "blocked" ? "failed" : ""}"><span class="ac-icon">${ap.status === "blocked" ? ICON.x : ICON.send}</span><div><b>${esc(ap.title)}</b>${ap.note ? `<span>${esc(ap.note)}</span>` : ""}</div></div>` : "";
    const btn = ap && (ap.pending || ap.status === "submitted") ? ""
      : `<button type="button" class="btn btn-soft btn-block" data-apply-me="${esc(j.key)}">${ICON.send}${ap ? "Ask Claude to try again" : "Apply for me"}</button>`;
    return `<div class="section"><h3>Applying</h3><div class="aa-head">${badge}</div>${reasons}${status}${btn}</div>`;
  }
  function askApply(key) {
    const j = state.jobs.find((x) => x.key === key);
    if (!j) return;
    state.confirmKey = key;
    const who = (state.criteria.candidate || "").trim().split(/\s+/)[0] || "the candidate";
    $("#confirm-text").textContent = `Ask Claude to apply for ${who} to ${j.company || "this employer"}? (${j.title}.) Claude uses the prepared CV and letter, and sends it only where the employer's form allows. Otherwise it comes back ready to finish by hand.`;
    openSheet($("#confirm"));
  }
  function requestApply(key) {
    const prev = mark(key);
    setMark(key, { state: prev.state === "applied" ? "applied" : "saved", seen: true, apply_requested_at: new Date().toISOString() });
    refreshDetail();
    toast("Requested. Claude will pick it up shortly.");
  }

  // ---------- prepared documents (CV, cover letter) ----------
  // Listed in web/data/documents.json ({ jobKey: [{ label, path }] }); otherwise found by
  // looking for a documents/applications/<company>_... folder in the private repo.
  const slug = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const docLabel = (name) => /cover/i.test(name) ? "Cover letter" : /cv|_cv_|^cv|cv_draft|resume/i.test(name) ? "CV" : name.replace(/\.[a-z]+$/i, "").replace(/[_-]+/g, " ");
  async function findDocs(j) {
    if (Array.isArray(state.docs[j.key])) return state.docs[j.key];
    if (state.mode !== "github") return [];
    try {
      if (!docDirs) {
        const res = await fetch(`${gh.url(GH_PATHS.docsDir)}?ref=${encodeURIComponent(gh.cfg().branch)}`, { headers: gh.headers(), cache: "no-store" });
        docDirs = res.ok ? (await res.json()).filter((x) => x.type === "dir").map((x) => x.name) : [];
      }
      const co = slug(j.company).split("_").slice(0, 2).join("_");
      const dir = co && docDirs.find((d) => d.startsWith(co));
      if (!dir) return (state.docs[j.key] = []);
      const res = await fetch(`${gh.url(`${GH_PATHS.docsDir}/${dir}`)}?ref=${encodeURIComponent(gh.cfg().branch)}`, { headers: gh.headers(), cache: "no-store" });
      const files = res.ok ? (await res.json()).filter((x) => x.type === "file" && /\.(pdf|docx?)$/i.test(x.name)) : [];
      const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
      return (state.docs[j.key] = (pdfs.length ? pdfs : files).map((f) => ({ label: docLabel(f.name), path: f.path })));
    } catch { return []; }
  }
  const docsReady = (k) => Array.isArray(state.docs[k]) && state.docs[k].length > 0;
  function docsHtml(j) {
    const list = state.docs[j.key];
    if (!Array.isArray(list) || !list.length) {
      // Saving a job asks for a tailored CV and cover letter; they are drafted on the next run.
      if (state.mode === "github" && mark(j.key).state === "saved" && Array.isArray(list)) {
        return `<div class="apply-card pending"><span class="ac-icon">${ICON.doc}</span><div><b>Preparing your documents</b><span>A CV and cover letter for this job usually appear within a few minutes.</span></div></div>`;
      }
      return "";
    }
    return `<div class="section"><h3>Your documents</h3><div class="doc-list">${list.map((d, i) =>
      `<button class="btn btn-ghost btn-block doc-btn" data-doc="${esc(j.key)}" data-doc-i="${i}">${ICON.doc}<span>${esc(d.label || d.path.split("/").pop())}</span></button>`).join("")}</div></div>`;
  }
  async function openDoc(key, i) {
    const d = (state.docs[key] || [])[i];
    if (!d) return;
    const win = window.open("", "_blank"); // open now, so the phone doesn't block it as a pop-up
    try {
      const res = await fetch(`${gh.url(d.path.split("/").map(encodeURIComponent).join("/"))}?ref=${encodeURIComponent(gh.cfg().branch)}`, { headers: { ...gh.headers(), Accept: "application/vnd.github.raw+json" } });
      if (!res.ok) throw new Error(String(res.status));
      const type = /\.pdf$/i.test(d.path) ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
      if (win) win.location.href = url;
      else { const a = document.createElement("a"); a.href = url; a.download = d.path.split("/").pop(); a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { if (win) win.close(); toast("Couldn't open that document. Try again."); }
  }

  function refreshDetail() {
    if (!$("#detail").open || !state.openKey) return;
    const j = state.jobs.find((x) => x.key === state.openKey);
    if (!j) return;
    $("#apply-box").innerHTML = applyStatusHtml(j);
    if ($("#autoapply-box")) $("#autoapply-box").innerHTML = applyForMeHtml(j);
    if ($("#docs-box")) {
      if (!Array.isArray(state.docs[j.key])) findDocs(j).then(() => { if (state.openKey === j.key && $("#docs-box")) $("#docs-box").innerHTML = docsHtml(j); });
      else $("#docs-box").innerHTML = docsHtml(j);
    }
    renderDetailBar(j);
  }

  // ---------- marks ----------
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
    const li = $(`.swipe[data-key="${CSS.escape(key)}"]`);
    const leaving = nextState === "hidden" && li && state.tab === "all" && !state.showHidden;
    const commit = () => {
      const extra = nextState === "applied" ? { applied_at: new Date().toISOString() } : prev === "applied" ? { applied_at: undefined } : {};
      setMark(key, { state: nextState, seen: true, ...extra });
      refreshDetail();
      if (nextState === "saved") { const b = $(`.swipe[data-key="${CSS.escape(key)}"] .save-fab`); if (b) b.classList.add("pop"); }
    };
    if (leaving && !matchMedia("(prefers-reduced-motion: reduce)").matches) { li.classList.add("leaving"); setTimeout(commit, 280); }
    else commit();
    if (nextState === "hidden") toast("Hidden from your list", () => { setMark(key, { state: prev }); refreshDetail(); });
    else if (nextState === "saved") { toast(state.mode === "github" && !docsReady(key) ? "Saved. Preparing your documents." : "Saved"); maybeOfferPush(); }
    else if (nextState === "applied") toast("Marked as applied. Good luck!", () => { setMark(key, { state: prev, applied_at: undefined }); refreshDetail(); });
    else if (prev === "applied") toast("No longer marked as applied");
    else if (prev === "saved") toast("Removed from saved");
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
      else if (el.type === "radio") el.checked = el.value === c[el.name];
      else el.value = Array.isArray(c[el.name]) ? c[el.name].join(", ") : (c[el.name] ?? "");
    }
  }
  // The Hours and Contract switches save straight away, changing only their own key in the file.
  async function saveCriteriaKey(key, value) {
    state.criteria = normaliseCriteria({ ...state.criteria, [key]: value });
    render();
    const status = $("#criteria-status");
    if (state.mode !== "github") { ls.set(LS.criteria, state.criteria); if (state.mode === "server") await api("api/criteria", { method: "PUT", body: JSON.stringify(state.criteria) }).catch(() => {}); toast("Saved"); return; }
    try {
      const remote = await gh.read(GH_PATHS.criteria, {});
      await gh.write(GH_PATHS.criteria, { ...(remote || {}), [key]: value }, `Search criteria: ${key} = ${value} (Job Finder)`, (r) => ({ ...(r || {}), [key]: value }));
      toast("Saved. The next search will use this.");
      status.textContent = "";
    } catch { toast("Couldn't save to GitHub. Try again."); }
  }

  async function saveCriteria(e) {
    e.preventDefault();
    const f = e.target; const data = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === "radio") { if (el.checked) data[el.name] = el.value; continue; }
      data[el.name] = el.type === "checkbox" ? el.checked : el.value;
    }
    state.criteria = normaliseCriteria({ ...state.criteria, ...data });
    const status = $("#criteria-status");
    if (state.mode === "static") {
      ls.set(LS.criteria, state.criteria);
      status.textContent = "Saved on this phone only. Connect your job list below so the search can use it.";
    } else if (state.mode === "github") {
      try {
        await gh.write(GH_PATHS.criteria, state.criteria, "Update search criteria from Job Finder", (remote) => ({ ...(remote || {}), ...state.criteria }));
        status.textContent = "Saved. The next search will use these settings.";
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
    toast("Settings saved");
    render();
  }

  // ---------- banner / toast ----------
  function showBanner(msg) { const b = $("#banner"); b.textContent = msg; b.hidden = !msg; }
  function updateBanner(msg) {
    if (msg) showBanner(msg);
    else if (state.sample) showBanner("These are sample jobs. Connect your job list in Settings to see the real ones.");
    else showBanner("");
  }

  // ---------- GitHub connection ----------
  function fillGithubForm() {
    const f = $("#github-form"); if (!f) return;
    const c = gh.cfg();
    f.elements.repo.value = `${c.owner}/${c.repo}`;
    f.elements.token.value = "";
    f.elements.token.placeholder = c.token ? "Saved on this phone" : "github_pat_…";
    const st = $("#github-status");
    st.textContent = state.mode === "github" ? "Connected" : c.token ? "Key not accepted" : "Not connected";
    st.className = "status-pill" + (state.mode === "github" ? " ok" : c.token ? " bad" : "");
    $("#github-disconnect").hidden = !c.token;
    $("#github-link").hidden = !c.token;
    $("#github-link-hint").hidden = !c.token;
  }
  async function saveGithub(e) {
    e.preventDefault();
    const f = e.target;
    const [owner, repo] = f.elements.repo.value.trim().split("/").map((s) => s.trim());
    const prev = gh.cfg();
    const token = f.elements.token.value.trim() || prev.token;
    if (!owner || !repo || !token) { toast("Enter the repo (owner/name) and an access key."); return; }
    ls.set(LS.gh, { ...prev, owner, repo, token });
    rememberKey(owner, repo, token);
    await loadAll();
    toast(state.mode === "github" ? "Connected. Your jobs are loading." : "Couldn't connect. Check the key.");
    if (state.mode === "github") { state.tab = "all"; render(); window.scrollTo({ top: 0 }); }
  }
  // Keep the key safe across updates and lost browser storage:
  // ask the browser not to evict storage, and offer the key to the password manager.
  function rememberKey(owner, repo, token) {
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* unsupported */ }
    try {
      if (window.PasswordCredential && navigator.credentials) {
        navigator.credentials.store(new PasswordCredential({ id: `${owner}/${repo}`, password: token, name: "Job Finder" })).catch(() => {});
      }
    } catch { /* unsupported */ }
  }
  // A sign-in link (#key=...) restores the key on any phone. The part after # never leaves the phone.
  function consumeKeyLink() {
    const m = location.hash.match(/(?:^#|&)key=([^&]+)/);
    if (!m) return;
    const token = decodeURIComponent(m[1]);
    const r = location.hash.match(/(?:^#|&)repo=([^&]+)/);
    const [owner, repo] = r ? decodeURIComponent(r[1]).split("/") : [gh.cfg().owner, gh.cfg().repo];
    ls.set(LS.gh, { ...gh.cfg(), owner, repo, token });
    rememberKey(owner, repo, token);
    history.replaceState(null, "", location.pathname + location.search);
  }
  function keyLink() {
    const c = gh.cfg();
    return `${location.origin}${location.pathname}#repo=${encodeURIComponent(c.owner + "/" + c.repo)}&key=${encodeURIComponent(c.token)}`;
  }
  let toastTimer = null;
  function toast(msg, undo, label = "Undo") {
    const t = $("#toast");
    // An open sheet makes the rest of the page untappable, so show the toast inside it.
    const host = document.querySelector("dialog[open]") || document.body;
    if (t.parentNode !== host) host.appendChild(t);
    t.hidden = true; void t.offsetWidth; // restart the entry animation
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button type="button">${esc(label)}</button>` : ""}`;
    t.hidden = false;
    if (undo) t.querySelector("button").onclick = () => { undo(); t.hidden = true; };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), undo ? (label === "Undo" ? 5000 : 8000) : 2200);
  }

  // ---------- push alerts ("your documents are ready") ----------
  // Works in Chrome/Android and in the iPhone app once it's added to the Home Screen (iOS 16.4+).
  const push = {
    supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    isIos: () => /iphone|ipad|ipod/i.test(navigator.userAgent),
    standalone: () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    async current() {
      if (!this.supported()) return null;
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.pushManager.getSubscription() : null;
    },
    keyBytes(b64) {
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
      return Uint8Array.from(raw, (c) => c.charCodeAt(0));
    },
    async saveSubs(fn, message) {
      // fn transforms the stored list; re-applied to the latest copy if another device wrote meanwhile.
      const remote = await gh.read(GH_PATHS.pushSubs, []).catch(() => []);
      const list = fn(Array.isArray(remote) ? remote : []);
      await gh.write(GH_PATHS.pushSubs, list, message, (r) => fn(Array.isArray(r) ? r : []));
    },
    async enable() {
      if (!state.pushKey || state.mode !== "github") { toast("Alerts aren't set up yet."); return false; }
      if (!this.supported()) {
        toast(this.isIos() && !this.standalone() ? "On iPhone, add Job Finder to your Home Screen and open it from there to get alerts." : "This browser can't show alerts.");
        return false;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Alerts are off. You can allow them in your phone's settings."); return false; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.keyBytes(state.pushKey) });
      const json = sub.toJSON();
      await this.saveSubs((list) => [...list.filter((x) => x && x.endpoint !== json.endpoint), json], "Turn on Job Finder alerts");
      ls.set(LS.pushAsked, true);
      toast("Alerts on. We'll tell you when documents are ready.");
      return true;
    },
    async disable() {
      const sub = await this.current();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        if (state.mode === "github") await this.saveSubs((list) => list.filter((x) => x && x.endpoint !== endpoint), "Turn off Job Finder alerts");
      }
      toast("Alerts off");
    },
  };
  async function renderPushRow() {
    const row = $("#push-row");
    if (!row) return;
    row.hidden = !(state.mode === "github" && state.pushKey);
    if (row.hidden) return;
    const sub = await push.current().catch(() => null);
    $("#push-toggle").checked = !!sub && Notification.permission === "granted";
  }
  // After the first bookmark, offer alerts once (the tap on "Turn on" lets the phone ask for permission).
  function maybeOfferPush() {
    if (ls.get(LS.pushAsked, false) || !state.pushKey || state.mode !== "github") return;
    if (push.supported() && Notification.permission === "denied") return;
    ls.set(LS.pushAsked, true);
    setTimeout(() => toast("Want a notification when the CV and cover letter are ready?", () => push.enable().then(renderPushRow).catch(() => toast("Couldn't turn on alerts. Try again in Settings.")), "Turn on"), 2400);
  }

  // ---------- events ----------
  function savePrefs() { ls.set(LS.prefs, { filters: [...state.filters], sort: state.sort }); }
  (() => {
    const p = ls.get(LS.prefs, null);
    if (p) { state.filters = new Set(p.filters || []); state.sort = p.sort || "score"; }
  })();

  document.addEventListener("click", (e) => {
    if (suppressClick && e.target.closest("#job-list")) { e.preventDefault(); e.stopPropagation(); return; }
    const am = e.target.closest("[data-apply-me]");
    if (am) { askApply(am.dataset.applyMe); return; }
    const doc = e.target.closest("[data-doc]");
    if (doc) { openDoc(doc.dataset.doc, Number(doc.dataset.docI)); return; }
    const act = e.target.closest("[data-act]");
    if (act) { toggleState(act.dataset.key, act.dataset.act); return; }
    const open = e.target.closest("[data-open]");
    if (open) { openDetail(open.dataset.open); return; }
    const sc = e.target.closest("[data-scope]");
    if (sc) { sc.dataset.scope === "match" ? state.filters.add("match") : state.filters.delete("match"); savePrefs(); render(); return; }
    const tg = e.target.closest("#filter-toggles .toggle");
    if (tg) { const f = tg.dataset.filter; state.filters.has(f) ? state.filters.delete(f) : state.filters.add(f); savePrefs(); render(); return; }
    const tab = e.target.closest(".tab");
    if (tab) {
      if (state.tab === tab.dataset.tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      state.tab = tab.dataset.tab; state.showHidden = false; render(); window.scrollTo({ top: 0 }); return;
    }
    if (e.target.closest("[data-clear-filters]")) { state.filters = new Set(); savePrefs(); render(); return; }
    if (e.target.closest("[data-show-hidden]")) { state.showHidden = true; render(); return; }
    if (e.target.closest("[data-goto-criteria]")) { state.tab = "criteria"; render(); $("#github-form").scrollIntoView(); return; }
  }, true);

  document.addEventListener("change", (e) => {
    if (e.target.name === "sort" && e.target.closest("#sort-pills")) { state.sort = e.target.value; savePrefs(); render(); }
    if ((e.target.name === "hours" || e.target.name === "contract") && e.target.closest("#criteria-form") && e.target.checked) saveCriteriaKey(e.target.name, e.target.value);
  });

  let qTimer = null;
  $("#search").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.query = e.target.value; render(); }, 120); });
  $("#refresh-btn").addEventListener("click", () => loadAll().then(() => toast("Up to date")));
  $("#filter-btn").addEventListener("click", () => openSheet($("#filters")));
  $("#filters-done").addEventListener("click", () => closeSheet($("#filters")));
  $("#filters-clear").addEventListener("click", () => { const keep = state.filters.has("match"); state.filters = new Set(keep ? ["match"] : []); state.sort = "score"; savePrefs(); render(); });
  $("#criteria-form").addEventListener("submit", saveCriteria);
  $("#github-form").addEventListener("submit", saveGithub);
  $("#confirm-no").addEventListener("click", () => closeSheet($("#confirm")));
  $("#confirm-yes").addEventListener("click", () => { const k = state.confirmKey; state.confirmKey = null; closeSheet($("#confirm")); if (k) requestApply(k); });
  $("#push-toggle").addEventListener("change", async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    try { if (on) await push.enable(); else await push.disable(); }
    catch { toast("Couldn't change alerts. Try again."); }
    e.target.disabled = false;
    renderPushRow();
  });
  $("#github-link").addEventListener("click", async () => {
    const link = keyLink();
    try { await navigator.clipboard.writeText(link); toast("Sign-in link copied. Keep it private."); }
    catch { window.prompt("Copy your sign-in link and keep it private:", link); }
  });
  $("#github-disconnect").addEventListener("click", () => {
    ls.set(LS.gh, { ...gh.cfg(), token: "" });
    loadAll().then(() => toast("Disconnected. The key was removed from this phone."));
  });
  $("#detail-close").addEventListener("click", () => closeSheet($("#detail")));
  $("#detail").addEventListener("input", (e) => {
    const ta = e.target.closest("[data-note]");
    if (ta) setMark(ta.dataset.note, { note: ta.value }, false);
  });

  // Shrink the header once the list scrolls. Shrinking makes the page shorter, which can pull
  // the scroll position back up; with a short list that used to flip the header back and forth.
  // So: only shrink when there's plenty of room to scroll, and use separate on/off points.
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => { updateHero(); ticking = false; });
  }, { passive: true });

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.mode !== "static") loadAll(); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Exposed for tests.
  window.__jf = { parsePay, schoolHours, parseTimeRanges, state, mergeMarks };

  consumeKeyLink();
  if (gh.configured()) { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* unsupported */ } }
  state.loading = true;
  render();
  loadAll().finally(() => {
    state.loading = false; render();
    // Deep link from a notification: ?job=<key> opens that job's details.
    const q = new URLSearchParams(location.search).get("job");
    if (q) { history.replaceState(null, "", location.pathname + location.hash); if (state.jobs.some((j) => j.key === q)) openDetail(q); }
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-job" && state.jobs.some((j) => j.key === e.data.key)) loadAll().then(() => openDetail(e.data.key));
  });
})();
