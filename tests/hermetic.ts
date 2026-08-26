// The README promises "Fully self-hosted: no CDN assets", and a release is a
// single binary people run on machines that may have no internet at all. That
// promise is one <link rel=stylesheet href=https://…> away from being false, and
// nothing would fail — the page would just look right on the developer's machine
// and wrong on an air-gapped one.
//
// So: scan the built bundle for references the browser would actually FETCH.
// Bare URLs inside error strings, XML namespace identifiers and JSON-Schema
// $schema ids are not fetches and are expected in vendored code, so matching
// "https://" anywhere would only teach people to ignore this check.
//
// Usage: bun tests/hermetic.ts

const dist = import.meta.dir + "/../src/web/ui/dist";
let pass = 0, fail = 0;
function ok(cond: any, label: string, detail?: string) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? "\n      " + detail : ""}`); }
}

const files = ["index.html", "app.css", "app.js", "editor.worker.js", "json.worker.js"];
for (const f of files) {
  const path = `${dist}/${f}`;
  const text = await Bun.file(path).text().catch(() => null);
  if (text === null) { ok(false, `${f} exists (run src/web/ui/build.sh)`); continue; }

  // Positions a browser loads from: element src/href, CSS url(), @import.
  const hits: string[] = [];
  const patterns: [RegExp, string][] = [
    [/\b(?:src|href)\s*=\s*["']?(https?:)\/\/[^"'\s>]+/gi, "src/href attribute"],
    [/url\(\s*["']?(https?:)\/\/[^)"']+/gi, "css url()"],
    [/@import\s+(?:url\()?\s*["']?(https?:)\/\/[^)"';]+/gi, "css @import"],
    [/importScripts\(\s*["'](https?:)\/\/[^"']+/gi, "importScripts"],
    // A literal fetch/XHR to an absolute external URL. Same-origin paths and
    // template literals against location.host are fine and are what we use.
    [/\b(?:fetch|open)\(\s*["'](https?:)\/\/[^"']+/gi, "fetch/XHR to an absolute URL"],
  ];
  for (const [re, what] of patterns) {
    for (const m of text.matchAll(re)) hits.push(`${what}: ${m[0].slice(0, 120)}`);
  }
  ok(hits.length === 0, `${f} loads nothing from an external host`, hits.join("\n      "));
}

// The one font we ship must be inlined, not linked: a codicon fetched from a CDN
// is how the toolbar silently turns into empty boxes offline.
{
  const css = await Bun.file(`${dist}/app.css`).text().catch(() => "");
  ok(/url\(data:font\/(ttf|woff2?);base64,/.test(css),
     "the codicon font is inlined as a data: URI");
}

// Everything the server can serve must be compiled in, or a release run from
// another directory 404s on its own UI.
{
  const server = await Bun.file(import.meta.dir + "/../src/web/server.milo").text();
  const embedded = [...server.matchAll(/@embedFile\("ui\/dist\/([^"]+)"\)/g)].map((m) => m[1]);
  const onDisk = [...new Bun.Glob("*").scanSync(dist)].filter((f) => !f.startsWith("."));
  const missing = onDisk.filter((f) => !embedded.includes(f));
  ok(missing.length === 0,
     `every built asset is embedded in the binary (${embedded.length} embedded)`,
     missing.length ? `not embedded: ${missing.join(", ")}` : "");
}

console.log(`\nhermetic: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
