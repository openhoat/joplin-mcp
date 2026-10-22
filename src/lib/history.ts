/** Rendering of the server-side note history diffs. */

/**
 * Joplin stores note history changes as diff-match-patch hunks, not as text: an array of
 * `{ diffs: [[op, text], ...], start1, length1, start2, length2 }` where op 1 = inserted,
 * -1 = deleted and 0 = unchanged. Keep the changed fragments only, they read like a patch.
 */
export function renderHistoryDiff(raw: any, maxChars = 240): string[] {
  if (!raw) return [];
  let hunks = raw;
  if (typeof hunks === "string") {
    try {
      hunks = JSON.parse(hunks);
    } catch {
      return [String(hunks).slice(0, maxChars)];
    }
  }
  if (!Array.isArray(hunks)) return [];
  const lines: string[] = [];
  for (const hunk of hunks) {
    const parts = Array.isArray(hunk?.diffs) ? hunk.diffs : [];
    for (const part of parts) {
      const op = Number(Array.isArray(part) ? part[0] : Number.NaN);
      const text = String(Array.isArray(part) ? (part[1] ?? "") : "");
      if (!text.trim()) continue;
      const label = op === 1 ? "+" : op === -1 ? "-" : null;
      if (!label) continue;
      const clean = text.replace(/\s+/g, " ").trim();
      lines.push(`${label} ${clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean}`);
    }
  }
  return lines;
}
