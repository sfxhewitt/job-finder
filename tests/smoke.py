#!/usr/bin/env python3
"""Browser smoke test for the static Job Finder PWA.

Serves the repo over a stdlib HTTP server on an ephemeral 127.0.0.1 port and drives a fresh
Chromium context with the Playwright synchronous API. External (non-local) network requests are
blocked and recorded; the test asserts that nothing outside the known allow-list (the Google
Fonts hosts referenced in index.html) was attempted. It never contacts GitHub, never opens a
live apply/external link, and never skips: a missing browser or a JS page error fails the run.

Selectors used are read straight from index.html / app.js (no guessed selectors).

Startup flow being exercised (sample mode): with no server API and no data/jobs.json, app.js
falls back to sample/seen_jobs.sample.json (the data/jobs.json 404 is expected), shows the
sample banner, and renders the sample job cards.

Run locally:
    python3 tests/smoke.py
    CHROME_EXECUTABLE=/opt/google/chrome/chrome python3 tests/smoke.py
"""
import functools
import http.server
import os
import sys
import threading
from urllib.parse import urlparse

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
# Referenced from index.html (<link rel="preconnect"> + the fonts stylesheet). These are the only
# external hosts the page is expected to touch; everything else is an unexpected attempt.
ALLOWED_EXTERNAL = {"fonts.googleapis.com", "fonts.gstatic.com"}


def log(step):
    print(f"[smoke] {step}", flush=True)


def fail(msg):
    print(f"[smoke] FAIL: {msg}", flush=True)
    sys.exit(1)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def log_message(self, *args):  # keep test output clean
        pass


def start_server():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def main():
    try:
        from playwright.sync_api import sync_playwright, Error as PlaywrightError
    except ImportError as exc:
        fail(f"Playwright is not installed ({exc}). Install with: python3 -m pip install playwright==1.56.0")

    httpd, port = start_server()
    base = f"http://127.0.0.1:{port}/"
    log(f"serving {APP_DIR} at {base}")

    external_attempts = set()
    page_errors = []

    try:
        with sync_playwright() as pw:
            launch_kwargs = {"args": ["--no-sandbox", "--disable-dev-shm-usage"]}
            exe = os.environ.get("CHROME_EXECUTABLE")
            if exe:
                launch_kwargs["executable_path"] = exe
                log(f"using CHROME_EXECUTABLE={exe}")
            else:
                log("using Playwright's bundled Chromium")

            try:
                browser = pw.chromium.launch(**launch_kwargs)
            except PlaywrightError as exc:
                fail(f"could not launch Chromium (browser missing?): {exc}")

            # Fresh context; reduced motion makes the dialog open/close deterministic.
            context = browser.new_context(reduced_motion="reduce")

            def route_handler(route):
                host = urlparse(route.request.url).hostname
                if host is None or host in LOCAL_HOSTS:
                    route.continue_()
                else:
                    external_attempts.add(host)
                    route.abort()

            context.route("**/*", route_handler)

            page = context.new_page()
            page.on("pageerror", lambda err: page_errors.append(str(err)))

            log("step 1: load app (sample mode startup)")
            page.goto(base, wait_until="domcontentloaded")

            # Sample jobs render as <li class="swipe"> cards (skeletons are <li class="skeleton">).
            page.wait_for_selector("#job-list li.swipe", timeout=20000)
            page.wait_for_selector("#banner:not([hidden])", timeout=20000)

            banner_text = page.locator("#banner").inner_text().strip()
            log(f"   banner: {banner_text!r}")
            if "sample" not in banner_text.lower():
                fail(f"expected a sample banner, got: {banner_text!r}")

            card_count = page.locator("#job-list li.swipe").count()
            log(f"   rendered {card_count} job card(s)")
            if card_count < 1:
                fail("no job cards rendered in sample mode")
            if page.get_by_text("(Sample)").count() < 1:
                fail("expected sample job titles containing '(Sample)'")

            log("step 2: navigate to Settings")
            page.click('.tab[data-tab="criteria"]')
            page.wait_for_selector("#view-criteria:not([hidden])", timeout=10000)
            title = page.locator("#screen-title").inner_text().strip()
            log(f"   screen title: {title!r}")
            if title != "Settings":
                fail(f"expected Settings screen, got title {title!r}")
            if not page.locator("#criteria-form").is_visible():
                fail("criteria form not visible on Settings screen")

            log("step 3: back to the job list")
            page.click('.tab[data-tab="all"]')
            page.wait_for_selector("#view-jobs:not([hidden])", timeout=10000)
            page.wait_for_selector("#job-list li.swipe", timeout=10000)

            log("step 4: open a job detail (card tap, not the external apply link)")
            page.locator("#job-list .card-tap[data-open]").first.click()
            page.wait_for_selector("#detail[open]", timeout=10000)
            detail_title = page.locator("#detail-title").inner_text().strip()
            log(f"   detail title: {detail_title!r}")
            if not detail_title:
                fail("job detail opened without a title")

            log("step 5: close the detail, back to the list")
            page.click("#detail-close")
            # A closed <dialog> drops [open] and becomes display:none, i.e. hidden. Waiting with the
            # default "visible" state would hang, so assert the closed dialog with state="hidden"
            # (matches #detail:not([open]) AND is not visible), then confirm the list is visible.
            page.wait_for_selector("#detail:not([open])", state="hidden", timeout=10000)
            page.wait_for_selector("#view-jobs:not([hidden])", timeout=10000)
            if not page.locator("#job-list li.swipe").first.is_visible():
                fail("job list not visible after closing the detail dialog")

            context.close()
            browser.close()
    finally:
        httpd.shutdown()

    log(f"external requests observed: {sorted(external_attempts) or 'none'}")
    unexpected = external_attempts - ALLOWED_EXTERNAL
    if unexpected:
        fail(f"unexpected external network attempts: {sorted(unexpected)}")

    if page_errors:
        fail("JS page errors:\n  - " + "\n  - ".join(page_errors))

    log("PASS: sample startup, banner, Settings round-trip, job detail, no unexpected network, no JS errors")


if __name__ == "__main__":
    main()
