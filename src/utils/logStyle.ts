export function divider(label?: string): string {
  const bar = "-----------";
  // Single leading bar only (no trailing/closing bar).
  return label ? `${bar} ${label}` : `${bar}`;
}

export function fmtBps(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  return `${x.toFixed(0)}bps`;
}

export function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(2)}%`;
}

