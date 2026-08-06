#!/usr/bin/env python3
"""
Rebuild og-image.png (1200x630) from the live hero.

Two passes, both through the local preview on :8081 so what ships on the share
card is literally what is on the page:

  1. screenshot the real #gcal calendar   -> og-cal.png
  2. screenshot og-template.html          -> og-image.png

Playwright's bundled chromium is usually not installed on this machine, so we
fall back to the system Chrome channel the same way render_prep.py does.

    node sites/stilo-ai/serve.js &          # or the stilo-preview launch config
    python3 sites/stilo-ai/scripts/build_og_image.py
"""
import os
import sys

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("STILO_PREVIEW", "http://localhost:8081")
CAL = os.path.join(ROOT, "og-cal.png")
OUT = os.path.join(ROOT, "og-image.png")


def launch(p):
    try:
        return p.chromium.launch()
    except Exception:
        return p.chromium.launch(channel="chrome")


def main():
    with sync_playwright() as p:
        b = launch(p)

        # --- pass 1: the calendar, fully populated -------------------------
        pg = b.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        pg.goto(BASE + "/", wait_until="networkidle")
        pg.wait_for_timeout(1200)
        # Clone-and-replace detaches the plate from its IntersectionObserver and
        # the landing timer, which would otherwise keep rewriting the counter
        # back to whatever step the animation is on when the shutter fires.
        pg.evaluate(
            """() => {
                document.querySelectorAll('.rv').forEach(e => e.classList.add('in'));
                const g = document.getElementById('gcal');
                const frozen = g.cloneNode(true);
                g.parentNode.replaceChild(frozen, g);
                frozen.querySelectorAll('.gev').forEach(e => e.classList.add('on'));
                const c = frozen.querySelector('#gcalCount');
                if (c) c.textContent = '16';
            }"""
        )
        pg.wait_for_timeout(700)
        pg.locator("#gcal").screenshot(path=CAL)
        pg.close()

        # --- pass 2: compose the card -------------------------------------
        pg = b.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=2)
        pg.goto(BASE + "/og-template.html", wait_until="networkidle")
        pg.wait_for_timeout(900)          # let Bodoni land before the shot
        pg.screenshot(path=OUT, clip={"x": 0, "y": 0, "width": 1200, "height": 630})
        b.close()

    print("wrote", OUT)


if __name__ == "__main__":
    sys.exit(main())
