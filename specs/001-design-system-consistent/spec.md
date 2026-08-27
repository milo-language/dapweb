# Design system: one palette, one type scale, one screenshot recipe

## Problem

The UI grew its vocabulary by accident. A value that has a token is written as a
literal next to one that does not, the type scale has ten sizes for five roles,
and the docs images were framed by hand with captions in a colour the UI already
uses for something else. Nothing is broken; the cost is that a reader cannot
learn a rule on one screen and apply it on the next, which is the point of
having a system at all.

## True when this is done

1. Every colour in the UI has a name. No literal hex outside the token block,
   except a tint derived from a token (an rgba of it).
2. A colour means one thing everywhere: green starts the program and marks the
   stack; amber means a program is live under the control, and a changed
   register; blue is the accent, a toggle that is on, and code addresses; pink
   is an agent and nothing else; red is a breakpoint.
3. Type has five roles, not ten sizes: micro badge 9, dense data 10, default 11,
   reading 12, control 14. Icons are 15 and are not text.
4. Radii are 4 / 6 / 8: chip, control, panel. A 7px swatch may be 2.
5. The docs images take their colours from the UI's own tokens, read out of
   styles.css, so a palette change cannot leave the pictures behind.
6. Screenshots are taken one way: same window, same page zoom, cropped to where
   the content ends, captioned by the same code path.

## Out of scope

Light mode, a new brand, any change to what the UI does.
