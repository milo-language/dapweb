// Editor tab labels, VS Code style: each tab shows the shortest trailing path
// suffix no other open tab shares, so two main.c files read as nested/main.c
// and tmp/main.c instead of two identical tabs.

const tail = (segs: string[], k: number) => segs.slice(-k).join("/");

export function tabLabels(paths: string[]): Map<string, string> {
  const split = paths.map((p) => p.split("/").filter(Boolean));
  const out = new Map<string, string>();
  paths.forEach((p, i) => {
    const segs = split[i];
    for (let k = 1; k <= segs.length; k++) {
      const suf = tail(segs, k);
      if (!split.some((o, j) => j !== i && tail(o, k) === suf)) { out.set(p, suf); return; }
    }
    // Every suffix is shared: p is itself a suffix of a longer open path
    // (src/main.c vs /repo/src/main.c). The longer one gets a longer label, so
    // the whole of p is already distinct.
    out.set(p, p);
  });
  return out;
}
