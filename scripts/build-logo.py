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
from pathlib import Path
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen

REPO_ROOT = Path("/Users/remyleon/Desktop/AI Agency")
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
    """Single-letter 'S' monogram in Avenir Next Bold on the dark plate.

    Avenir Next gives a modern geometric-humanist S — clean curves, slightly
    warmer than Helvetica or Futura. Airbnb / Whole Foods territory.
    """
    ttc = TTCollection(str(MONOGRAM_FONT_PATH))
    font = ttc.fonts[0]  # index 0 = Avenir Next Bold (verified via name table)
    # Cap-height 144 fills the 256 plate generously (~56% of plate height).
    # Avenir's S advance is narrower than Bodoni's so this stays well-padded.
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
    """Full STILO + AI PARTNERS wordmark in Avenir Next Bold, transparent bg."""
    ttc = TTCollection(str(MONOGRAM_FONT_PATH))
    font = ttc.fonts[0]  # Avenir Next Bold
    big_glyphs, big_units, big_scale = render_line(font, "STILO", cap_height_px=180, spacing_ratio=0.0)
    small_glyphs, small_units, small_scale = render_line(font, "AI PARTNERS", cap_height_px=44, spacing_ratio=0.30)

    # Stack centered: STILO cap=180 + gap=40 + AI PARTNERS cap=44 = 264px content. Top pad (400-264)/2 = 68.
    big_baseline = 68 + 180          # 248
    small_baseline = big_baseline + 40 + 44  # 332
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
    """1200x630 OG share image: dark plate, centered wordmark in Avenir Next Bold."""
    ttc = TTCollection(str(MONOGRAM_FONT_PATH))
    font = ttc.fonts[0]  # Avenir Next Bold
    big_glyphs, big_units, big_scale = render_line(font, "STILO", cap_height_px=160, spacing_ratio=0.0)
    small_glyphs, small_units, small_scale = render_line(font, "AI PARTNERS", cap_height_px=40, spacing_ratio=0.34)

    # Vertical stack centered in 630px frame.
    # Content block: STILO cap=160, gap 36, AI PARTNERS cap=40 → total 236px.
    top_pad = (630 - 236) / 2  # = 197
    big_baseline = top_pad + 160             # 357
    small_baseline = big_baseline + 36 + 40  # 433

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


if __name__ == "__main__":
    build_compact_square()
    build_wordmark()
    build_og_svg()
    build_pngs()
