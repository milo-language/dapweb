// Editor tab labels: pure, so tested without a browser.
// Usage: bun tests/tablabels.ts

import { tabLabels } from "../src/web/ui/src/tabLabels";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}
const labels = (ps: string[]) => ps.map((p) => tabLabels(ps).get(p));

ok(labels(["examples/nested/main.c"])[0] === "main.c", "a lone file shows its basename");
{
  const l = labels(["examples/nested/main.c", "examples/nested/shapes.c"]);
  ok(l[0] === "main.c" && l[1] === "shapes.c", "distinct basenames stay bare", l);
}
{
  const l = labels(["examples/nested/main.c", "/tmp/main.c"]);
  ok(l[0] === "nested/main.c" && l[1] === "tmp/main.c", "same basename gets its parent dir", l);
}
{
  const l = labels(["/a/x/src/main.c", "/b/y/src/main.c", "/b/y/util.c"]);
  ok(l[0] === "x/src/main.c" && l[1] === "y/src/main.c" && l[2] === "util.c",
     "a shared parent dir walks up until the labels differ; unrelated tabs stay bare", l);
}
{
  const l = labels(["src/main.c", "/repo/src/main.c"]);
  ok(l[0] !== l[1], "a path that is a suffix of another still gets a distinct label", l);
}

console.log(`\n${pass} passed`);
