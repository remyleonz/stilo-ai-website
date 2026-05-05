#!/usr/bin/env python3
"""Build STILO logo SVGs by outlining Bodoni 72 glyphs to <path> data.

Outputs:
  - /Users/remyleon/Desktop/AI Agency/STILO AI PARTNERS LOGO.svg     (256x256, dark plate, "STILO" Bold)
  - /Users/remyleon/Desktop/AI Agency/sites/stilo-ai/favicon.svg     (identical to above)
  - /Users/remyleon/Desktop/AI Agency/STILO AI PARTNERS WORDMARK.svg (1200x400, transparent, stacked Book)

Run:  python3 sites/stilo-ai/scripts/build-logo.py
Dep:  pip install fonttools
"""

from pathlib import Path
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen

REPO_ROOT = Path("/Users/remyleon/Desktop/AI Agency")
FONT_PATH = Path("/System/Library/Fonts/Supplemental/Bodoni 72.ttc")

COLOR_BG = "#0A0A0A"
COLOR_FG = "#2563EB"

OUT_LOGO = REPO_ROOT / "STILO AI PARTNERS LOGO.svg"
OUT_FAVICON = REPO_ROOT / "sites/stilo-ai/favicon.svg"
OUT_WORDMARK = REPO_ROOT / "STILO AI PARTNERS WORDMARK.svg"


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
    font = load_face("Bold")
    # cap=56 + zero letter-spacing fits "STILO" Bold at ~216px wide in a 256 box
    # (Bodoni Bold advance sum = 2692 units, scale = 56/698 = 0.0802 → 216px).
    glyphs, total_units, scale = render_line(font, "STILO", cap_height_px=56, spacing_ratio=0.0)
    # Baseline placed so the cap-block (top of caps to baseline) is vertically centered.
    baseline_y = (256 + 56) / 2  # cap-top at 100, baseline at 156
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
    font = load_face("Book")
    big_glyphs, big_units, big_scale = render_line(font, "STILO", cap_height_px=200, spacing_ratio=0.04)
    small_glyphs, small_units, small_scale = render_line(font, "AI PARTNERS", cap_height_px=56, spacing_ratio=0.30)

    # Stack: top padding 52, STILO baseline at 52+200=252, gap 40, AI PARTNERS baseline at 252+40+56=348.
    big_block = line_group(big_glyphs, big_scale, big_units, viewbox_width=1200, baseline_y_px=252, fill=COLOR_FG)
    small_block = line_group(small_glyphs, small_scale, small_units, viewbox_width=1200, baseline_y_px=348, fill=COLOR_FG)

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400">\n'
        f'{big_block}\n'
        f'{small_block}\n'
        '</svg>\n'
    )
    OUT_WORDMARK.write_text(svg)
    print(f"wrote {OUT_WORDMARK}")


if __name__ == "__main__":
    build_compact_square()
    build_wordmark()
