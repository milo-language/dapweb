#!/usr/bin/env python3
"""Annotate dapweb screenshots for the README.

A raw screenshot of a debugger is a wall of panes, and a reader cannot tell which
part the surrounding paragraph is about. This dims everything outside the regions
of interest, outlines them, and labels them, so the picture makes the same point
the prose does.

Only needed to REGENERATE docs/images; nothing in the build or test path imports
it. It wants Pillow, which is not a dependency of this repo:

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install Pillow
    /tmp/venv/bin/python scripts/annotate-shots.py spec.json

The spec is JSON so the call sites stay readable:

    {"src": "raw.jpg", "out": "docs/images/x.png", "dim": 0.62,
     "regions": [{"box": [x, y, w, h], "label": "what this is", "side": "below"}],
     "gif": {"out": "docs/images/x.gif", "focus": 0}}
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

ACCENT = (255, 123, 213)      # matches the UI's agent magenta
RADIUS = 10
PAD = 6

def _font(size):
    for p in ("/System/Library/Fonts/Supplemental/Menlo.ttc",
              "/System/Library/Fonts/Menlo.ttc",
              "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()

def annotate(spec):
    img = Image.open(spec["src"]).convert("RGB")
    W, H = img.size
    dim = float(spec.get("dim", 0.62))
    regions = spec["regions"]

    # Dim the whole frame, then paste the regions of interest back at full
    # brightness. Compositing this way (rather than drawing four dark rectangles
    # around each region) keeps overlapping regions from double-darkening.
    out = Image.blend(img, Image.new("RGB", img.size, (0, 0, 0)), dim)
    for r in regions:
        x, y, w, h = r["box"]
        out.paste(img.crop((x, y, x + w, y + h)), (x, y))

    d = ImageDraw.Draw(out)
    label_font = _font(int(spec.get("label_size", 17)))
    for r in regions:
        x, y, w, h = r["box"]
        color = tuple(r.get("color", ACCENT))
        d.rounded_rectangle([x - 2, y - 2, x + w + 2, y + h + 2],
                            radius=RADIUS, outline=color, width=3)
        label = r.get("label")
        if not label:
            continue
        tw = d.textlength(label, font=label_font)
        th = label_font.size + 2 * PAD
        # Default below the box; flip above when that would fall off the frame.
        side = r.get("side", "below")
        ly = y + h + 10 if side == "below" else y - th - 10
        if ly + th > H:
            ly = y - th - 10
        if ly < 0:
            ly = y + h + 10
        lx = min(max(x, 8), W - tw - 2 * PAD - 8)
        d.rounded_rectangle([lx, ly, lx + tw + 2 * PAD, ly + th], radius=6, fill=color)
        d.text((lx + PAD, ly + PAD - 1), label, font=label_font, fill=(20, 12, 20))

    out.save(spec["out"])
    print(f"wrote {spec['out']}  ({W}x{H})")

    if "gif" in spec:
        _gif(img, out, regions[spec["gif"].get("focus", 0)]["box"], spec["gif"])

def _gif(raw, annotated, box, g):
    """Zoom from the full annotated frame into one region and back out.

    Frames are cropped from the ANNOTATED image so the outline and label stay
    visible while zooming; the crop window eases between the full frame and a
    padded region, which reads as a camera move rather than a jump cut.
    """
    W, H = raw.size
    x, y, w, h = box
    pad = int(g.get("pad", 60))
    # Target window, expanded to the frame's aspect so nothing squashes.
    tx0, ty0 = max(0, x - pad), max(0, y - pad)
    tx1, ty1 = min(W, x + w + pad), min(H, y + h + pad)
    tw, th = tx1 - tx0, ty1 - ty0
    if tw / th > W / H:
        need = tw * H / W
        cy = (ty0 + ty1) / 2
        ty0, ty1 = max(0, cy - need / 2), min(H, cy + need / 2)
    else:
        need = th * W / H
        cx = (tx0 + tx1) / 2
        tx0, tx1 = max(0, cx - need / 2), min(W, cx + need / 2)

    hold_out, zoom, hold_in = g.get("hold_out", 8), g.get("zoom", 14), g.get("hold_in", 18)
    outw = int(g.get("width", 900))
    frames = []

    def frame(t):
        # smoothstep: no abrupt start or stop
        e = t * t * (3 - 2 * t)
        cx0 = 0 + (tx0 - 0) * e
        cy0 = 0 + (ty0 - 0) * e
        cx1 = W + (tx1 - W) * e
        cy1 = H + (ty1 - H) * e
        c = annotated.crop((int(cx0), int(cy0), int(cx1), int(cy1)))
        return c.resize((outw, int(outw * c.height / c.width)), Image.LANCZOS)

    frames += [frame(0)] * hold_out
    frames += [frame(i / (zoom - 1)) for i in range(zoom)]
    frames += [frames[-1]] * hold_in
    frames += [frame(1 - i / (zoom - 1)) for i in range(zoom)]

    # A GIF is 256 colors; quantize once against a shared palette so the frames
    # do not shimmer as the palette is recomputed per frame.
    pal = frames[0].quantize(colors=255, method=Image.MEDIANCUT)
    frames = [f.quantize(palette=pal, dither=Image.NONE) for f in frames]
    frames[0].save(g["out"], save_all=True, append_images=frames[1:],
                   duration=g.get("duration", 90), loop=0, optimize=True)
    print(f"wrote {g['out']}  ({len(frames)} frames)")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    for spec in json.load(open(sys.argv[1])):
        annotate(spec)
