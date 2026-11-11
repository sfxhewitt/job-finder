#!/usr/bin/env node
// Automated negative assertions for the validators in validate.mjs.
// Writes malformed fixtures to a temporary directory (the tracked originals are never touched)
// and asserts the validator REJECTS each one. If any malformed input is accepted, this process
// exits non-zero. Positive sanity checks confirm the real fixtures (and a constructed valid
// manifest) are still accepted, so the rejections mean something.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSampleFile, validateManifestFile, ROOT } from "./validate.mjs";

const dir = mkdtempSync(join(tmpdir(), "jf-negative-"));
let failures = 0;

const firstLine = (s) => String(s).split("\n")[0];

function expectReject(label, fn) {
  try {
    fn();
    console.error(`FAIL ${label}: malformed input was ACCEPTED`);
    failures++;
  } catch (e) {
    console.log(`  ok  rejected: ${label} (${firstLine(e.message)})`);
  }
}

// Write a sample file containing a single job (wrapped in the "seen" map) and validate it.
let n = 0;
function badSample(label, jobOrRaw, raw = false) {
  const file = join(dir, `sample-${n++}.json`);
  writeFileSync(file, raw ? jobOrRaw : JSON.stringify({ seen: { "x-job": jobOrRaw } }));
  expectReject(label, () => validateSampleFile(file, dir));
}

const goodJob = { title: "Shop Assistant", company: "Example Co", url: "https://example.com/jobs/1", portal: "sample" };

// --- malformed JSON / structure ---
badSample("malformed JSON syntax", "{ not: valid json ", true);
badSample("top-level is an array", "[]", true);
badSample("missing seen key", JSON.stringify({ jobs: {} }), true);
badSample("seen is a string", JSON.stringify({ seen: "nope" }), true);
badSample("seen is an array", JSON.stringify({ seen: [] }), true);
badSample("empty seen map", JSON.stringify({ seen: {} }), true);

// --- primitive / non-object job entries (must not be filtered away) ---
badSample("numeric job entry", 5);
badSample("string job entry", "not-a-job");
badSample("null job entry", null);
badSample("array job entry", []);

// --- missing required fields ---
badSample("missing title", { company: "Example Co", url: "https://example.com/1", portal: "sample" });
badSample("missing company", { title: "Shop Assistant", url: "https://example.com/1", portal: "sample" });
badSample("missing url", { title: "Shop Assistant", company: "Example Co", portal: "sample" });
badSample("missing portal (not sample)", { title: "Shop Assistant", company: "Example Co", url: "https://example.com/1" });

// --- wrong types / values ---
badSample("company not a string", { ...goodJob, company: 123 });
badSample("url not http(s)", { ...goodJob, url: "ftp://example.com/1" });
badSample("url not a URL", { ...goodJob, url: "not a url" });
badSample("portal not sample", { ...goodJob, portal: "indeed" });
badSample("rank_score as string", { ...goodJob, rank_score: "86" });
badSample("location wrong type", { ...goodJob, location: 10 });
badSample("strengths not an array of strings", { ...goodJob, strengths: "daytime" });

// --- invalid calendar dates (Date.parse would roll these over) ---
badSample("invalid calendar date (Feb 30)", { ...goodJob, first_seen: "2026-02-30" });
badSample("invalid month (13)", { ...goodJob, posted_date: "2026-13-01" });
badSample("invalid day (Nov 31)", { ...goodJob, deadline: "2026-11-31" });
badSample("non-date string in date field", { ...goodJob, rank_date: "not-a-date" });

// --- manifest negatives (base is valid; one thing broken at a time) ---
// A real local icon the valid cases can reference.
writeFileSync(join(dir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
const goodManifest = {
  name: "Job Finder", short_name: "Jobs", display: "standalone",
  start_url: "./", scope: "./",
  icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
};
let mn = 0;
function badManifest(label, obj) {
  const name = `manifest-${mn++}.webmanifest`;
  writeFileSync(join(dir, name), JSON.stringify(obj));
  expectReject(label, () => validateManifestFile(name, dir));
}

badManifest("manifest missing name", { ...goodManifest, name: undefined });
badManifest("manifest empty short_name", { ...goodManifest, short_name: "" });
badManifest("manifest missing short_name", { ...goodManifest, short_name: undefined });
badManifest("manifest invalid display", { ...goodManifest, display: "window" });
badManifest("manifest missing display", { ...goodManifest, display: undefined });
badManifest("manifest icons empty", { ...goodManifest, icons: [] });
badManifest("icon missing src", { ...goodManifest, icons: [{ sizes: "any", type: "image/svg+xml" }] });
badManifest("icon missing sizes", { ...goodManifest, icons: [{ src: "icon.svg", type: "image/svg+xml" }] });
badManifest("icon missing type", { ...goodManifest, icons: [{ src: "icon.svg", sizes: "any" }] });
badManifest("icon file missing", { ...goodManifest, icons: [{ src: "nope.svg", sizes: "any", type: "image/svg+xml" }] });
badManifest("icon traversal path", { ...goodManifest, icons: [{ src: "../escape.svg", sizes: "any", type: "image/svg+xml" }] });
badManifest("icon absolute path", { ...goodManifest, icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] });
badManifest("icon remote url", { ...goodManifest, icons: [{ src: "https://evil.example/icon.svg", sizes: "any", type: "image/svg+xml" }] });
badManifest("icon protocol-relative url", { ...goodManifest, icons: [{ src: "//evil.example/icon.svg", sizes: "any", type: "image/svg+xml" }] });
badManifest("start_url remote", { ...goodManifest, start_url: "https://evil.example/" });
badManifest("scope absolute path", { ...goodManifest, scope: "/" });
badManifest("start_url traversal", { ...goodManifest, start_url: "../" });

// --- positive sanity: valid inputs must still be accepted ---
try {
  const count = validateSampleFile("sample/seen_jobs.sample.json");
  console.log(`  ok  real sample fixture accepted (${count} jobs)`);
} catch (e) {
  console.error(`FAIL real sample fixture was rejected: ${e.message}`);
  failures++;
}

try {
  validateManifestFile("manifest.webmanifest", ROOT);
  console.log("  ok  real manifest.webmanifest accepted");
} catch (e) {
  console.error(`FAIL real manifest was rejected: ${e.message}`);
  failures++;
}

try {
  writeFileSync(join(dir, "good.webmanifest"), JSON.stringify(goodManifest));
  validateManifestFile("good.webmanifest", dir);
  console.log("  ok  constructed valid manifest accepted");
} catch (e) {
  console.error(`FAIL constructed valid manifest was rejected: ${e.message}`);
  failures++;
}

rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} negative assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll negative assertions passed.");
