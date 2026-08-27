# Design system

One palette, one type scale, one way to take a screenshot. `styles.css :root` is
the source: the UI reads it, and so does `scripts/annotate-shots.py`, so a
palette change cannot leave the docs images behind.

## Colour means one thing

| token | hex | what it says |
| --- | --- | --- |
| `--ok` / `--r-stack` | `#3fb950` | this starts the program; and the stack |
| `--stop` / `--r-heap`… | `#d29922` | a program is live under this control; a register changed since the last stop |
| `--accent` / `--r-code` | `#58a6ff` `#79c0ff` | the accent; a toggle that is on; code addresses |
| `--agent` | `#ff7bd5` | an agent did this. Nothing else is ever this colour |
| `--bp` | `#f85149` | a breakpoint |
| `--r-heap` `--r-const` `--r-data` | `#f778ba` `#56d4dd` `#ff9e64` | the region an address lands in, in the dump and on the register that points there |
| `--go` | `#238636` | the one filled button in the app (New session) |
| `--chip-bg` / `--chip-fg` | `#21262d` `#c9d1d9` | a label that carries no signal: a caption, a name chip |

Hover is not a state and gets no colour: it lifts the surface
(`--surface` → `--surface-hi`) and nothing else.

Surfaces stack in one order: `--bg` (page) → `--panel` → `--surface` (a control
on it) → `--surface-hi` (that control under the cursor). `--row-hover` is for a
dense row that should highlight without becoming a control. `--tooltip-bg` sits
above all of them.

No literal hex outside the `:root` block. A tint of a token (`rgba(...)` of its
value) is fine where a fill needs to be transparent.

## Type

`--mono` is a claim that the characters line up and each one matters: paths,
identifiers, addresses, registers, program output. Everything else is `--ui`.

| px | role |
| --- | --- |
| 9 | micro badge: a status pill, a mark, a group letter |
| 10 | dense data: a second column that must not compete with the first |
| 11 | default |
| 12 | reading: a paragraph a person is meant to read, not scan |
| 14 | control: a real button with a real label |
| 15 | icon glyphs. Not text |

## Shape

Radii are `4` (chip), `6` (control), `8` (panel). The 7px region swatch is `2`.

## Screenshots

Every image in `docs/images/` is generated from a raw shot in `docs/shots/` and
a JSON spec in `docs/`, by `scripts/annotate-shots.py`:

```sh
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install Pillow
/tmp/venv/bin/python scripts/annotate-shots.py docs/langs.json
```

The recipe for a raw shot:

- One browser window, 1400x1000, and the same one for every shot in a set.
- Page zoom 1.35 for a whole-window shot, so the source and the panels are
  readable at README width. 1.0 for a pane that is already dense.
- Park the cursor in a corner: a pointer mid-frame highlights a row and dates
  the picture.
- Drive the session from `dapweb api`, never by hand, so the stop in the picture
  is reproducible.

The spec then crops per tile to where the content ends, sizes each grid row to
its own tallest tile, and captions with `--chip-bg`. A caption is never a signal
colour; the callout outline (`--agent`) is, and is spent on one thing per frame.
