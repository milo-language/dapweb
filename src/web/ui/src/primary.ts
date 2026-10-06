// The header's one filled button: what it says and does follows session state,
// so the next step is always the most visible thing on screen.

export type Phase = "idle" | "running" | "stopped" | "done";
export type PrimaryKind = "run" | "pause" | "continue";

export function primaryAction(o: { phase: Phase; hasTarget: boolean; attach?: boolean }):
    { kind: PrimaryKind; label: string; tip: string; disabled: boolean } {
  if (o.phase === "stopped") return { kind: "continue", label: "Continue", tip: "Continue to the next breakpoint (F5)", disabled: false };
  if (o.phase === "running") return { kind: "pause", label: "Pause", tip: "Pause the program where it is (F6)", disabled: false };
  // Disabled rather than hidden: a missing button explains nothing, a greyed one
  // with a tooltip says what to do.
  if (!o.hasTarget) return {
    kind: "run", label: "Run", disabled: true,
    tip: o.attach ? "Nothing to attach to: type a pid or process name in the target bar"
                  : "Nothing to run: type a program path in the target bar, or start dapweb with one",
  };
  return { kind: "run", label: "Run", disabled: false,
           tip: o.attach ? "Run: attach to the process (F5)" : "Run: start the program (F5)" };
}
