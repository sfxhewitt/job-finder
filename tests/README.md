# Job Finder — CI tests

Real tests for the static Job Finder PWA. No build step, no app changes. Everything here only
reads the app source; it never edits tracked files, never reaches the network beyond the local
test server, and never contacts GitHub or submits a live application.

## What runs

| File | What it checks |
| --- | --- |
| `tests/validate.mjs` | `node --check` on `app.js` and `sw.js`; `manifest.webmanifest` required non-empty strings (`name`, `short_name`, `start_url`, `scope`), a `display` from the Web App Manifest enum (`fullscreen`/`standalone`/`minimal-ui`/`browser`), and `icons` entries each with non-empty string `src`/`sizes`/`type`. All referenced `start_url`/`scope`/icon `src` paths must be **local relative** URLs (no scheme, absolute, or protocol-relative), are realpath-resolved to reject `..`/symlink escapes of the manifest directory, must exist, and must be the right type (icons = files, a trailing-`/` `start_url`/`scope` = directory). `sample/seen_jobs.sample.json` requires a non-empty `seen` object (no raw-map fallback) where **every** entry is a job object (non-objects are hard failures, never filtered), each with `title`/`company`/`url` non-empty strings, an http(s) `url`, `portal` of `"sample"`, optional finite `rank_score`, optional string/array fields type-checked when present, and date fields (`first_seen`/`posted_date`/`rank_date`/`deadline`) validated as real `YYYY-MM-DD` calendar dates (rejecting rollovers like `2026-02-30`). Deterministic, no current-date conditions. |
| `tests/negative.mjs` | Automated negative assertions: writes malformed fixtures to a **temp dir** (originals untouched) and asserts the validator **rejects** them — malformed JSON, missing/malformed `seen`, primitive/non-object job entries, missing or wrong-typed required fields, non-`sample` portal, invalid calendar dates, an invalid `short_name`/`display`, and icons that are missing or use traversal/absolute/protocol-relative/remote paths. Also confirms the real sample fixture, the real `manifest.webmanifest`, and a constructed valid manifest are still accepted. Fails if any malformed input is accepted. |
| `tests/smoke.py` | Chromium smoke test via Playwright (sync API) over a stdlib HTTP server on an ephemeral `127.0.0.1` port, fresh context. Verifies sample-mode startup (sample banner + sample job cards), Settings navigation and back, opening a job detail and back. External requests are blocked/recorded and asserted against an allow-list (the Google Fonts hosts in `index.html`). Fails on JS page errors; fails (never skips) if the browser is missing. The `data/jobs.json` 404 fallback is expected. |

## Local commands

Static validators (positive) and the automated negative assertions:

```sh
node tests/validate.mjs
node tests/negative.mjs
```

Browser smoke test. Create a virtualenv, install the pinned Playwright + Chromium once, then run
it with the same interpreter (mirrors CI):

```sh
python3 -m venv /tmp/job-finder-ci-venv
/tmp/job-finder-ci-venv/bin/pip install playwright==1.56.0
/tmp/job-finder-ci-venv/bin/python -m playwright install --with-deps chromium

/tmp/job-finder-ci-venv/bin/python tests/smoke.py
# or point at a system Chrome:
CHROME_EXECUTABLE=/opt/google/chrome/chrome /tmp/job-finder-ci-venv/bin/python tests/smoke.py
```

If local sandboxing blocks Chromium, the smoke test already passes `--no-sandbox`.

### Negative copied-fixture check (originals never modified)

`validate.mjs --sample <path>` validates a single sample file and exits non-zero if it is invalid,
so an orchestrator can copy the fixture elsewhere, break the copy, and confirm the validator
rejects it — without editing the tracked original:

```sh
# positive: the real fixture validates
node tests/validate.mjs --sample sample/seen_jobs.sample.json

# negative: a broken copy must make the process exit non-zero
cp sample/seen_jobs.sample.json /tmp/bad.json
printf '{ not valid json ' > /tmp/bad.json
node tests/validate.mjs --sample /tmp/bad.json   # exits 1
```

## CI

`.github/workflows/pr-ci.yml` runs on `pull_request` (and `push` to `main` for bootstrap) with
`contents: read` only. It checks out the actual PR head
(`github.event.pull_request.head.sha || github.sha`, `persist-credentials: false`), pins
`actions/checkout` and `actions/setup-node` by SHA, uses Node 22, has a job timeout, and runs the
positive validators, the negative assertions, and the browser smoke test. The smoke step creates a
`python3 -m venv /tmp/job-finder-ci-venv`, installs the pinned `playwright==1.56.0` with the venv
pip, runs `playwright install --with-deps chromium`, and then executes `tests/smoke.py` with that
same venv interpreter. No secrets are used and no step is skipped.

## Files

- `tests/validate.mjs`
- `tests/negative.mjs`
- `tests/smoke.py`
- `tests/README.md`
- `.github/workflows/pr-ci.yml`

> Note: these tests have not been executed here (no shell is available in this environment). The
> orchestrator runs the commands above.
