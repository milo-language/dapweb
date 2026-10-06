import React from "react";

// The wordmark. A bolt said "fast", which every tool claims and this one does
// not particularly promise. Three stacked bars say what is actually on the
// screen: a call stack, indented the way frames are, in the region colours the
// memory view uses. Geometry, not illustration, so the mark is an SVG in the
// source rather than an asset and it still reads at 16px.
export function Mark({ size = 17 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="6" width="26" height="5.5" rx="2" fill="var(--r-code)" />
      <rect x="6" y="13.5" width="23" height="5.5" rx="2" fill="var(--r-heap)" />
      <rect x="9" y="21" width="20" height="5.5" rx="2" fill="var(--r-stack)" />
    </svg>
  );
}
