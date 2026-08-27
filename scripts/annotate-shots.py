#!/usr/bin/env python3
"""Annotate dapweb screenshots for the README.

A raw screenshot of a debugger is a wall of panes, and a reader cannot tell which
part the surrounding paragraph is about. This outlines the regions of interest and
labels them, so the picture makes the same point the prose does. The rest of the
frame is left at full brightness: a reader wants to see the whole debugger, and
dimming it hides the very thing the screenshot is there to show.

Only needed to REGENERATE docs/images; nothing in the build or test path imports
it. It wants Pillow, which is not a dependency of this repo:

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install Pillow
    /tmp/venv/bin/python scripts/annotate-shots.py spec.json

The spec is JSON so the call sites stay readable:

    {"src": "raw.jpg", "out": "docs/images/x.png",
     "regions": [{"box": [x, y, w, h], "label": "what this is", "side": "below"}],
     "gif": {"out": "docs/images/x.gif", "focus": 0}}
"""
import json
import re
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
    out = _compose(img, spec)
    out.save(spec["out"])
    print(f"wrote {spec['out']}  ({img.width}x{img.height})")
    if "gif" in spec:
        _gif(img, out, spec["regions"][spec["gif"].get("focus", 0)]["box"], spec["gif"])
    if "reveal" in spec:
        _reveal(img, out, spec["reveal"])

def _compose(img, spec):
    W, H = img.size
    regions = spec["regions"]

    out = img.copy()
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

    return out

def _reveal(raw, annotated, r):
    """Cross-fade the plain screenshot into the annotated one, and back.

    Fading in from the plain screenshot makes the callout obviously a highlight OF
    something rather than a different picture, and looping it means the reader can
    look at either state for as long as they want.
    """
    outw = int(r.get("width", 900))
    def scaled(im):
        return im.resize((outw, int(outw * im.height / im.width)), Image.LANCZOS)
    a, b = scaled(raw), scaled(annotated)

    # Hold with a long DURATION on one frame, never by repeating a frame: GIF
    # optimisation drops consecutive identical frames, which silently turned a
    # 2.5s hold into three frames and made the whole thing pulse without ever
    # resting long enough to read the labels.
    fade = r.get("fade", 9)
    step = r.get("step", 60)
    frames, durations = [a], [r.get("hold_raw_ms", 1400)]
    for i in range(1, fade + 1):
        t = i / fade
        frames.append(Image.blend(a, b, t * t * (3 - 2 * t)))   # smoothstep, as above
        durations.append(step)
    durations[-1] = r.get("hold_ann_ms", 2800)                  # rest on the callout
    for i in range(1, fade):
        t = 1 - i / fade
        frames.append(Image.blend(a, b, t * t * (3 - 2 * t)))
        durations.append(step)

    pal = b.quantize(colors=255, method=Image.MEDIANCUT)
    frames = [f.quantize(palette=pal, dither=Image.NONE) for f in frames]
    frames[0].save(r["out"], save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, optimize=True)
    print(f"wrote {r['out']}  ({len(frames)} frames, "
          f"{sum(durations)/1000:.1f}s loop)")

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

# ── side-by-side: a terminal transcript beside the browser it is driving ──

TERM_BG = (11, 14, 20)
TERM_FG = (201, 209, 217)
TERM_KEY = (121, 192, 255)
TERM_STR = (165, 214, 255)
TERM_NUM = (242, 204, 96)
TERM_PUNCT = (110, 118, 129)
TERM_PROMPT = (63, 185, 80)

# Spans of one JSON line, as (text, color). Keys and values get different colors
# for the same reason the UI highlights them: the reader is meant to match
# "sum": "42" against the locals pane next to it, not to read a wall of text.
def _json_spans(line):
    out, i = [], 0
    for m in re.finditer(r'"(?:[^"\\]|\\.)*"(\s*:)?|-?\d+(?:\.\d+)?', line):
        if m.start() > i:
            out.append((line[i:m.start()], TERM_PUNCT))
        tok = m.group(0)
        if tok.startswith('"'):
            out.append((tok, TERM_KEY if m.group(1) else TERM_STR))
        else:
            out.append((tok, TERM_NUM))
        i = m.end()
    if i < len(line):
        out.append((line[i:], TERM_PUNCT))
    return out or [(line, TERM_FG)]

def _terminal(lines, font, width, height, pad, line_h):
    img = Image.new("RGB", (width, height), TERM_BG)
    d = ImageDraw.Draw(img)
    y = pad
    for line in lines:
        if line.startswith("$ "):
            d.text((pad, y), "$", font=font, fill=TERM_PROMPT)
            w = d.textlength("$ ", font=font)
            d.text((pad + w, y), line[2:], font=font, fill=TERM_FG)
        else:
            x = pad
            for text, color in _json_spans(line):
                d.text((x, y), text, font=font, fill=color)
                x += d.textlength(text, font=font)
        y += line_h
    return img

def pair(spec):
    """A terminal transcript and the browser tab it drives, side by side.

    The claim "an agent and your tab share one session" is not something a
    screenshot of either half can make: the picture has to show the command and
    the window at the same moment, with the same values in both.
    """
    shot = Image.open(spec["shot"]).convert("RGB")
    lines = open(spec["transcript"]).read().rstrip("\n").split("\n")
    if "command" in spec:
        lines = ["$ " + spec["command"], ""] + lines

    H = shot.height
    pad = int(spec.get("pad", 26))
    line_h = (H - 2 * pad) / max(len(lines), 1)
    size = int(line_h * spec.get("line_ratio", 0.74))
    font = _font(size)
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    text_w = max(probe.textlength(l, font=font) for l in lines)
    term_w = int(text_w) + 2 * pad

    cap_font = _font(int(spec.get("label_size", 30)))
    cap_h = cap_font.size + 2 * PAD + 14
    gap = int(spec.get("gap", 24))
    out = Image.new("RGB", (term_w + gap + shot.width, H + cap_h), (13, 17, 23))
    out.paste(_terminal(lines, font, term_w, H, pad, line_h), (0, cap_h))
    out.paste(shot, (term_w + gap, cap_h))

    d = ImageDraw.Draw(out)
    # Outlines in FINAL-image coordinates, tying a value on the left to the same
    # value on the right. Without them a reader sees two dark rectangles and has
    # to hunt for the correspondence the picture exists to make.
    for box in spec.get("boxes", []):
        x, y, w, h = box
        d.rounded_rectangle([x - 2, y - 2, x + w + 2, y + h + 2],
                            radius=RADIUS, outline=ACCENT, width=3)
    for x, label in ((0, spec["left_label"]), (term_w + gap, spec["right_label"])):
        tw = d.textlength(label, font=cap_font)
        d.rounded_rectangle([x, 0, x + tw + 2 * PAD, cap_font.size + 2 * PAD],
                            radius=6, fill=ACCENT)
        d.text((x + PAD, PAD - 1), label, font=cap_font, fill=(20, 12, 20))

    out.save(spec["out"])
    print(f"wrote {spec['out']}  ({out.width}x{out.height})")

def story(spec):
    """One GIF walking a real session: each step is a screenshot with the control
    you press called out, held long enough to read, cross-fading to the next.

    A gallery of feature screenshots makes a reader assemble the workflow
    themselves. A sequence shows them the four buttons that actually matter and
    the order to press them in.
    """
    steps = spec["steps"]
    outw = int(spec.get("width", 880))
    step_ms = int(spec.get("step_ms", 55))
    fade = int(spec.get("fade", 6))

    shots = []
    for i, st in enumerate(steps, 1):
        sub = {"src": st["src"], "out": "/dev/null",
               "regions": st["regions"], "label_size": spec.get("label_size", 17)}
        img = Image.open(st["src"]).convert("RGB")
        ann = _compose(img, sub)
        shots.append(ann.resize((outw, int(outw * ann.height / ann.width)), Image.LANCZOS))

    frames, durations = [], []
    for i, sh in enumerate(shots):
        frames.append(sh)
        durations.append(int(steps[i].get("hold_ms", spec.get("hold_ms", 2600))))
        nxt = shots[(i + 1) % len(shots)]
        for k in range(1, fade + 1):
            t = k / (fade + 1)
            frames.append(Image.blend(sh, nxt, t * t * (3 - 2 * t)))
            durations.append(step_ms)

    pal = shots[0].quantize(colors=255, method=Image.MEDIANCUT)
    frames = [f.quantize(palette=pal, dither=Image.NONE) for f in frames]
    frames[0].save(spec["out"], save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, optimize=True)
    print(f"wrote {spec['out']}  ({len(frames)} frames, {sum(durations)/1000:.1f}s loop)")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    for spec in json.load(open(sys.argv[1])):
        if "shot" in spec:
            pair(spec)
        elif "steps" in spec:
            story(spec)
        else:
            annotate(spec)
