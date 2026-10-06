// Follow the agent: which server pushes should bring a file and line into view
// and flash it. Pure, so tests/follow.ts checks the decision without a browser.
import { hasSrc } from "./session";

export type FollowTarget = { path: string; line: number; flash: boolean };

// Only what an agent did (the server's `by`, see Attribution in state.milo):
// the user's own clicks already put the line where they are looking. A stop
// has no `by` from a server older than the field, and is not followed.
export function followTarget(m: any, follow: boolean): FollowTarget | null {
  if (!follow || m?.by !== "agent") return null;
  if (m.type === "stopped") {
    const f0 = m.frames?.[0];
    const path: string = f0?.path || m.path || "";
    const line: number = f0?.line || m.line || 0;
    return hasSrc(path) && line > 0 ? { path, line, flash: true } : null;
  }
  // Set and clear both: a breakpoint vanishing is as much the agent's doing.
  if (m.type === "breakpoint") {
    return m.path && m.line > 0 ? { path: m.path, line: m.line, flash: true } : null;
  }
  // openSource names a file, not a line: show it, nothing to flash.
  if (m.type === "source") {
    return hasSrc(m.path || "") ? { path: m.path, line: 0, flash: false } : null;
  }
  return null;
}

const FOLLOW_KEY = "dapweb.followAgent";
export const loadFollow = () => { try { return localStorage.getItem(FOLLOW_KEY) !== "0"; } catch { return true; } };
export const saveFollow = (on: boolean) => { try { localStorage.setItem(FOLLOW_KEY, on ? "1" : "0"); } catch {} };
