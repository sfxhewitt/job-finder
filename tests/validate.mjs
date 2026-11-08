#!/usr/bin/env node
// Static, deterministic validators for the Job Finder PWA.
// No network, no browser, no time-dependent assertions. Grounded in the source:
//   - app.js / sw.js must parse (node --check)
//   - manifest.webmanifest required fields + locally existing referenced assets
//   - sample/seen_jobs.sample.json "seen" schema as consumed by app.js toJobList()/enrich()
//
// Usage:
//   node tests/validate.mjs                 run the full positive suite against the repo
//   node tests/validate.mjs --sample <path> validate only one sample file (for fixture checks);
//                                           exits non-zero if that file is invalid
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE); // repo root (parent of tests/)

export class ValidationError extends Error {}

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isHttpUrl = (v) => {
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
};

// ---- JS syntax (parse-only, no execution) ----
export function checkSyntax(file, baseDir = ROOT) {
  const p = resolve(baseDir, file);
  if (!existsSync(p)) throw new ValidationError(`syntax check: file not found: ${file}`);
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.message;
    throw new ValidationError(`syntax error in ${file}:\n${String(msg).trim()}`);
  }
}

// ---- referenced local assets exist ----
export function validateReferencedAssets(
  baseDir = ROOT,
  assets = ["index.html", "app.js", "sw.js", "styles.css", "icon.svg", "manifest.webmanifest"],
) {
  const missing = assets.filter((a) => !existsSync(resolve(baseDir, a)));
  if (missing.length) throw new ValidationError(`referenced local assets missing: ${missing.join(", ")}`);
  return assets.length;
}

// ---- web app manifest ----
// The set of valid "display" members per the Web App Manifest spec (display_override adds more,
// but the plain "display" field is limited to these four).
const DISPLAY_MODES = new Set(["fullscreen", "standalone", "minimal-ui", "browser"]);

// Resolve a manifest URL reference that MUST be a local, relative path contained in baseDir.
// Rejects anything with a scheme (http:, https:, data:, file:, …), an absolute path ("/x"), or a
// protocol-relative URL ("//host"). Then realpath-resolves both the target and baseDir so that
// `..` traversal or a symlink escaping baseDir is rejected, and asserts the filesystem type
// (icons must be files; a start_url/scope ending in "/" must be a directory, otherwise a file).
function resolveLocalRef(baseDir, ref, what, { requireFile = false } = {}) {
  if (!isNonEmptyString(ref)) throw new ValidationError(`manifest ${what} must be a non-empty string`);
  const path = ref.split(/[?#]/)[0];
  if (path.length === 0) throw new ValidationError(`manifest ${what} has an empty path: ${ref}`);
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(path)) {
    throw new ValidationError(`manifest ${what} must be a local relative URL, not a scheme/absolute URL: ${ref}`);
  }
  if (path.startsWith("//")) {
    throw new ValidationError(`manifest ${what} must be a local relative URL, not a protocol-relative URL: ${ref}`);
  }
  if (path.startsWith("/")) {
    throw new ValidationError(`manifest ${what} must be a relative path, not an absolute path: ${ref}`);
  }
  const resolved = resolve(baseDir, path);
  if (!existsSync(resolved)) throw new ValidationError(`manifest ${what} points to a missing local path: ${ref}`);
  // realpath both sides so `..` or symlinks that escape baseDir are caught.
  const realBase = realpathSync(baseDir);
  const real = realpathSync(resolved);
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new ValidationError(`manifest ${what} escapes the manifest directory (traversal/symlink): ${ref}`);
  }
  const st = statSync(real);
  const looksDir = path === "." || path === "./" || path.endsWith("/");
  if (requireFile || !looksDir) {
    if (!st.isFile()) throw new ValidationError(`manifest ${what} must reference a file: ${ref}`);
  } else if (!st.isDirectory()) {
    throw new ValidationError(`manifest ${what} must reference a directory: ${ref}`);
  }
  return real;
}

export function validateManifestFile(file, baseDir = ROOT) {
  const p = resolve(baseDir, file);
  if (!existsSync(p)) throw new ValidationError(`manifest not found: ${file}`);
  let m;
  try { m = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { throw new ValidationError(`manifest is not valid JSON (${file}): ${e.message}`); }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new ValidationError(`manifest must be a JSON object`);
  for (const f of ["name", "short_name", "start_url", "scope"]) {
    if (!isNonEmptyString(m[f])) throw new ValidationError(`manifest missing required non-empty string field: ${f}`);
  }
  if (!isNonEmptyString(m.display) || !DISPLAY_MODES.has(m.display)) {
    throw new ValidationError(`manifest "display" must be one of: ${[...DISPLAY_MODES].join(", ")}`);
  }
  if (!Array.isArray(m.icons) || m.icons.length === 0) throw new ValidationError(`manifest "icons" must be a non-empty array`);
  const dir = dirname(p);
  m.icons.forEach((icon, i) => {
    if (!icon || typeof icon !== "object" || Array.isArray(icon)) {
      throw new ValidationError(`manifest icons[${i}] must be an object`);
    }
    for (const f of ["src", "sizes", "type"]) {
      if (!isNonEmptyString(icon[f])) throw new ValidationError(`manifest icons[${i}] missing non-empty string "${f}"`);
    }
    resolveLocalRef(dir, icon.src, `icons[${i}].src`, { requireFile: true });
  });
  resolveLocalRef(dir, m.start_url, "start_url");
  resolveLocalRef(dir, m.scope, "scope");
  return m;
}

// ---- sample seen_jobs schema ----
// The data is consumed by app.js via data.seen (a key -> job object map). We require a non-empty
// `seen` object (no fallback to the raw top-level map) and validate EVERY entry — a non-object
// entry is a hard failure, never filtered away. Required fields are the ones the UI relies on;
// optional fields are type-checked only when present, matching the sample's shape.
export const DATE_FIELDS = ["first_seen", "posted_date", "rank_date", "deadline"];

// Deterministic YYYY-MM-DD calendar-date check. Unlike Date.parse, this rejects impossible days
// (e.g. 2026-02-30 or 2026-11-31) that would otherwise roll over to a valid date. No reference to
// the current date, so results never depend on when the test runs.
export function isValidCalendarDate(v) {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d >= 1 && d <= daysInMonth[mo - 1];
}

export function validateSampleData(data, label = "sample") {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError(`${label}: top-level must be a JSON object`);
  }
  const seen = data.seen;
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
    throw new ValidationError(`${label}: "seen" must be a non-empty object of jobs`);
  }
  const entries = Object.entries(seen);
  if (entries.length === 0) throw new ValidationError(`${label}: "seen" has no job entries`);

  const stringFields = [
    "location", "salary", "hours", "description", "fit", "status", "source",
    "rank_verdict", "language_note", "location_verdict", "language_gate",
  ];
  for (const [key, j] of entries) {
    const where = `${label} job "${key}"`;
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      throw new ValidationError(`${where}: each "seen" entry must be a job object`);
    }
    if (!isNonEmptyString(j.title)) throw new ValidationError(`${where}: "title" must be a non-empty string`);
    if (!isNonEmptyString(j.company)) throw new ValidationError(`${where}: "company" must be a non-empty string`);
    if (!isNonEmptyString(j.url)) throw new ValidationError(`${where}: "url" must be a non-empty string`);
    if (!isHttpUrl(j.url)) throw new ValidationError(`${where}: "url" must be an http(s) URL`);
    if (j.portal !== "sample") throw new ValidationError(`${where}: "portal" must be "sample"`);
    if (j.rank_score !== undefined && (typeof j.rank_score !== "number" || !Number.isFinite(j.rank_score))) {
      throw new ValidationError(`${where}: "rank_score" must be a finite number when present`);
    }
    for (const f of stringFields) {
      if (j[f] !== undefined && j[f] !== null && typeof j[f] !== "string") {
        throw new ValidationError(`${where}: "${f}" must be a string when present`);
      }
    }
    // Date fields (including the nullable `deadline`) must be a real calendar date when non-null.
    for (const f of DATE_FIELDS) {
      if (j[f] !== undefined && j[f] !== null && !isValidCalendarDate(j[f])) {
        throw new ValidationError(`${where}: "${f}" must be a valid YYYY-MM-DD calendar date when present`);
      }
    }
    for (const f of ["strengths", "gaps"]) {
      if (j[f] !== undefined && (!Array.isArray(j[f]) || !j[f].every(isNonEmptyString))) {
        throw new ValidationError(`${where}: "${f}" must be an array of strings when present`);
      }
    }
  }
  return entries.length;
}

export function validateSampleFile(file, baseDir = ROOT) {
  const p = resolve(baseDir, file);
  let raw;
  try { raw = readFileSync(p, "utf8"); }
  catch { throw new ValidationError(`sample file not found: ${file}`); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new ValidationError(`sample file is not valid JSON (${file}): ${e.message}`); }
  return validateSampleData(data, file);
}

// ---- CLI ----
function parseArgs(argv) {
  const out = { sample: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sample") out.sample = argv[++i];
    else throw new ValidationError(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`FAIL ${e.message}`); process.exit(2); }

  const ok = (m) => console.log(`  ok  ${m}`);

  // Fixture mode: validate only the given sample copy. The orchestrator points this at a
  // copied (possibly malformed) fixture; a malformed file makes this exit non-zero without
  // touching the originals.
  if (args.sample) {
    try {
      const n = validateSampleFile(args.sample, process.cwd());
      ok(`sample fixture valid: ${args.sample} (${n} job${n === 1 ? "" : "s"})`);
    } catch (e) {
      console.error(`FAIL ${e.message}`);
      process.exit(1);
    }
    return;
  }

  console.log("validate.mjs — static Job Finder checks");
  const steps = [
    ["node --check app.js", () => checkSyntax("app.js")],
    ["node --check sw.js", () => checkSyntax("sw.js")],
    ["referenced local assets exist", () => `${validateReferencedAssets()} files`],
    ["manifest.webmanifest fields + assets", () => { validateManifestFile("manifest.webmanifest"); }],
    ["sample/seen_jobs.sample.json schema", () => `${validateSampleFile("sample/seen_jobs.sample.json")} jobs`],
  ];
  const errors = [];
  for (const [name, fn] of steps) {
    try { const info = fn(); ok(`${name}${info ? ` — ${info}` : ""}`); }
    catch (e) { errors.push(e); console.error(`FAIL ${name}: ${e.message}`); }
  }
  if (errors.length) {
    console.error(`\n${errors.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll static checks passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
