// Threads panel row text: pure, so tested without a browser.
// Usage: bun tests/threadlabel.ts

import { threadLabel } from "../src/web/ui/src/threadLabel";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

{
  const t = threadLabel("Thread 3 Queue: com.apple.main-thread (serial)", 3);
  ok(t.label === "Thread 3", "the queue leaves the row", t);
  ok(t.tip.includes("Queue: com.apple.main-thread (serial)") && t.tip.includes("thread id 3"), "and lands in the tooltip", t);
}
{
  const t = threadLabel("Thread 2 worker Queue: com.example.q (concurrent)", 2);
  ok(t.label === "Thread 2 worker", "a real thread name stays on the row", t);
}
ok(threadLabel("Thread 1", 1).label === "Thread 1", "a bare lldb name is untouched");
ok(threadLabel("MainThread", 5).label === "MainThread", "another adapter's name is untouched");
ok(threadLabel("", 7).label === "thread 7", "no name falls back to the id");

console.log(`threadlabel: ${pass} assertions passed`);
