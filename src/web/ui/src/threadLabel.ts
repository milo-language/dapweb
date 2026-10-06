// Threads panel row text. lldb names a thread "Thread 3 Queue: com.apple.main-thread
// (serial)": the queue is what truncates the row and pushes the frame location off
// the edge, so it moves to the tooltip and the row keeps "Thread 3" plus any real
// name the thread was given.

export function threadLabel(name: string, id: number): { label: string; tip: string } {
  const full = (name || "").trim();
  const tip = full ? `${full} (thread id ${id})` : `thread id ${id}`;
  if (!full) return { label: `thread ${id}`, tip };
  const q = full.search(/\s*Queue:\s/);
  const label = (q >= 0 ? full.slice(0, q) : full).trim();
  return { label: label || `thread ${id}`, tip };
}
