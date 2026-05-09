#!/usr/bin/env python3
"""Build STILO logo SVGs by outlining Bodoni 72 glyphs to <path> data,
then rasterize PNGs via headless Chrome.

Outputs:
  SVG (committed source of truth):
    - /Users/remyleon/Desktop/AI Agency/STILO AI PARTNERS LOGO.svg     (256x256, dark plate, "STILO" Bold)
    - /Users/remyleon/Desktop/AI Agency/sites/stilo-ai/favicon.svg     (identical to above)
    - /Users/remyleon/Desktop/AI Agency/STILO AI PARTNERS WORDMARK.svg (1200x400, transparent, stacked Book)
    - /Users/remyleon/Desktop/AI Agency/sites/stilo-ai/og-image.svg    (1200x630, dark plate, wordmark, OG share)

  PNG (rasterized, deployed to live site root):
    - /Users/remyleon/Desktop/AI Agency/sites/stilo-ai/logo.png        (1024x1024, schema.org logo)
    - /Users/remyleon/Desktop/AI Agency/sites/stilo-ai/og-image.png    (1200x630, OG share)

Run:  python3 sites/stilo-ai/scripts/build-logo.py
Deps: fonttools, headless Chrome at standard macOS path.
"""

import subprocess
import datetime
import shutil
from pathlib import Path
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen

REPO_ROOT = Path("/Users/remyleon/Desktop/AI Agency")
ARCHIVE = REPO_ROOT / "Archive" / "logo-history"
FONT_PATH = Path("/System/Library/Fonts/Supplemental/Bodoni 72.ttc")  # serif, used for wordmark + og-image
MONOGRAM_FONT_PATH = Path("/System/Library/Fonts/Avenir Next.ttc")    # modern sans, used for S monogram
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

COLOR_BG = "#0A0A0A"
COLOR_FG = "#2563EB"

OUT_LOGO = REPO_ROOT / "STILO AI PARTNERS LOGO.svg"
OUT_FAVICON = REPO_ROOT / "sites/stilo-ai/favicon.svg"
OUT_WORDMARK = REPO_ROOT / "STILO AI PARTNERS WORDMARK.svg"
OUT_OG_SVG = REPO_ROOT / "sites/stilo-ai/og-image.svg"
OUT_LOGO_PNG = REPO_ROOT / "sites/stilo-ai/logo.png"
OUT_OG_PNG = REPO_ROOT / "sites/stilo-ai/og-image.png"


def load_face(target_style: str):
    ttc = TTCollection(str(FONT_PATH))
    available = []
    for font in ttc.fonts:
        style = (font['name'].getDebugName(2) or "").strip()
        available.append(style)
        if style.lower() == target_style.lower():
            return font
    raise RuntimeError(f"No Bodoni 72 face with style {target_style!r}; saw {available}")


def render_line(font, text, cap_height_px, spacing_ratio):
    """Return (glyph_records, total_width_units, scale_px_per_unit).

    glyph_records is a list of (path_d, cursor_units, advance_units).
    cursor advances in font units; baseline lives at unit y=0, glyph y axis points up.
    """
    upem = font['head'].unitsPerEm
    cap_units = font['OS/2'].sCapHeight
    scale = cap_height_px / cap_units
    spacing_units = spacing_ratio * cap_units

    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    space_advance = glyph_set[cmap[ord(' ')]].width if ord(' ') in cmap else int(upem * 0.3)

    glyphs = []
    cursor = 0
    last_advance = 0
    for ch in text:
        if ch == ' ':
            cursor += space_advance + spacing_units
            last_advance = 0
            continue
        gname = cmap[ord(ch)]
        glyph = glyph_set[gname]
        pen = SVGPathPen(glyph_set)
        glyph.draw(pen)
        path_d = pen.getCommands()
        glyphs.append((path_d, cursor, glyph.width))
        cursor += glyph.width + spacing_units
        last_advance = glyph.width

    total_units = cursor - spacing_units
    return glyphs, total_units, scale


def line_group(glyphs, scale, total_units, viewbox_width, baseline_y_px, fill):
    start_x_px = (viewbox_width - total_units * scale) / 2
    parts = [
        f'  <g transform="translate({start_x_px:.3f} {baseline_y_px:.3f}) '
        f'scale({scale:.6f} {-scale:.6f})" fill="{fill}">'
    ]
    for path_d, cursor, _ in glyphs:
        if cursor:
            parts.append(f'    <path transform="translate({cursor} 0)" d="{path_d}"/>')
        else:
            parts.append(f'    <path d="{path_d}"/>')
    parts.append('  </g>')
    return "\n".join(parts)


def build_compact_square():
    """Single-letter 'S' monogram in Bodoni 72 Bold on the dark plate.

    High-contrast serif — the ball terminals on the S top and bottom give it
    that Vogue / Sotheby's / luxury house energy.
    """
    font = load_face("Bold")  # Bodoni 72 Bold
    # Cap-height 144 fills the 256 plate generously (~56% of plate height).
    glyphs, total_units, scale = render_line(font, "S", cap_height_px=144, spacing_ratio=0.0)
    # Center vertically by cap-block: cap-top at (256-144)/2 = 56, baseline at 56+144 = 200.
    baseline_y = (256 + 144) / 2
    body = line_group(glyphs, scale, total_units, viewbox_width=256, baseline_y_px=baseline_y, fill=COLOR_FG)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">\n'
        f'  <rect width="256" height="256" rx="48" fill="{COLOR_BG}"/>\n'
        f'{body}\n'
        '</svg>\n'
    )
    OUT_LOGO.write_text(svg)
    OUT_FAVICON.parent.mkdir(parents=True, exist_ok=True)
    OUT_FAVICON.write_text(svg)
    print(f"wrote {OUT_LOGO}")
    print(f"wrote {OUT_FAVICON}")


def build_wordmark():
    """Full STILO + AI PARTNERS wordmark in Bodoni 72 Book, transparent bg."""
    font = load_face("Book")  # Bodoni 72 Book — thin verticals, Vogue masthead
    big_glyphs, big_units, big_scale = render_line(font, "STILO", cap_height_px=200, spacing_ratio=0.04)
    small_glyphs, small_units, small_scale = render_line(font, "AI PARTNERS", cap_height_px=56, spacing_ratio=0.30)

    # Stack centered: STILO cap=200 + gap=40 + AI PARTNERS cap=56 = 296px content. Top pad (400-296)/2 = 52.
    big_baseline = 52 + 200          # 252
    small_baseline = big_baseline + 40 + 56  # 348
    big_block = line_group(big_glyphs, big_scale, big_units, viewbox_width=1200, baseline_y_px=big_baseline, fill=COLOR_FG)
    small_block = line_group(small_glyphs, small_scale, small_units, viewbox_width=1200, baseline_y_px=small_baseline, fill=COLOR_FG)

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400">\n'
        f'{big_block}\n'
        f'{small_block}\n'
        '</svg>\n'
    )
    OUT_WORDMARK.write_text(svg)
    print(f"wrote {OUT_WORDMARK}")


def build_og_svg():
    """1200x630 OG share image: dark plate, centered wordmark in Bodoni 72 Book."""
    font = load_face("Book")
    big_glyphs, big_units, big_scale = render_line(font, "STILO", cap_height_px=180, spacing_ratio=0.04)
    small_glyphs, small_units, small_scale = render_line(font, "AI PARTNERS", cap_height_px=44, spacing_ratio=0.34)

    # Vertical stack centered in 630px frame.
    # Content block: STILO cap=180, gap 36, AI PARTNERS cap=44 → total 260px.
    top_pad = (630 - 260) / 2  # = 185
    big_baseline = top_pad + 180             # 365
    small_baseline = big_baseline + 36 + 44  # 445

    big_block = line_group(big_glyphs, big_scale, big_units, viewbox_width=1200, baseline_y_px=big_baseline, fill=COLOR_FG)
    small_block = line_group(small_glyphs, small_scale, small_units, viewbox_width=1200, baseline_y_px=small_baseline, fill=COLOR_FG)

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">\n'
        f'  <rect width="1200" height="630" fill="{COLOR_BG}"/>\n'
        f'{big_block}\n'
        f'{small_block}\n'
        '</svg>\n'
    )
    OUT_OG_SVG.write_text(svg)
    print(f"wrote {OUT_OG_SVG}")


def render_png(svg_path: Path, png_path: Path, width: int, height: int):
    """Use headless Chrome to rasterize an SVG file at exact dimensions."""
    if not Path(CHROME).exists():
        print(f"SKIP png: Chrome not at {CHROME}; install or adjust CHROME constant")
        return
    cmd = [
        CHROME,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        f"--window-size={width},{height}",
        "--default-background-color=00000000",
        f"--screenshot={png_path}",
        f"file://{svg_path}",
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    print(f"wrote {png_path}")


def build_pngs():
    # logo.png — high-res square logo for schema.org / Google knowledge panel
    render_png(OUT_LOGO, OUT_LOGO_PNG, 1024, 1024)
    # og-image.png — 1200x630 social share preview (LinkedIn / Twitter / Facebook)
    render_png(OUT_OG_SVG, OUT_OG_PNG, 1200, 630)


def archive_current():
    """Snapshot the current favicon + wordmark to Archive/logo-history/ before
    overwriting. Runs once at the top of every build so we never lose a version.
    Uses date-prefixed filenames; if a snapshot for today already exists with
    identical bytes, skip (avoid duplicates on same-day re-runs).
    """
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    today = datetime.date.today().isoformat()
    targets = [
        (OUT_FAVICON, f"{today} pre-build favicon.svg"),
        (OUT_WORDMARK, f"{today} pre-build wordmark.svg"),
    ]
    for src, archive_name in targets:
        if not src.exists():
            continue
        dst = ARCHIVE / archive_name
        # If today's snapshot already matches, skip (no churn on re-runs).
        if dst.exists() and dst.read_bytes() == src.read_bytes():
            continue
        # If today's snapshot exists but differs, suffix with a counter so we
        # keep the earlier one too.
        if dst.exists():
            n = 2
            while (ARCHIVE / f"{today}-{n} pre-build {src.name}").exists():
                n += 1
            dst = ARCHIVE / f"{today}-{n} pre-build {src.name}"
        shutil.copy2(src, dst)
        print(f"archived {src.name} → {dst.name}")


if __name__ == "__main__":
    archive_current()
    build_compact_square()
    build_wordmark()
    build_og_svg()
    build_pngs()
