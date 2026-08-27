# Plan

## Approach

styles.css `:root` is the single source of truth. Everything else reads it,
including the screenshot tool, so there is no second copy to drift.

## Steps

1. **Name the unnamed.** Add tokens for the values already in use as literals:
   `--surface` (#21262d, the control face), `--surface-hi` (#2d333b, hover),
   `--row-hover` (#1c2430, dense rows), `--agent` (#ff7bd5), `--ok-hi` /
   `--ok-dim` for the run button's pressed states, `--chip-bg` / `--chip-fg`
   for a caption chip that carries no signal.
2. **Replace literals** with those tokens, leaving rgba tints alone.
3. **Collapse the type scale** to 9 / 10 / 11 / 12 / 14: 8→9, 11.5→11,
   12.5→12, 13→14.
4. **Collapse radii** to 4 / 6 / 8, keeping 2 for the region swatch.
5. **Screenshot tool reads the tokens**: annotate-shots parses styles.css for
   `--agent` (callout outline) and `--chip-bg`/`--chip-fg` (captions).
6. **Write it down** in docs/design-system.md, including the screenshot recipe.
7. Regenerate every docs image from its spec; rebuild the UI; run the gates.

## Risks

Font-size changes move layout. 13→14 is the only one that grows; it is a single
button on the sessions page.
