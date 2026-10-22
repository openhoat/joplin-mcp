/** Todo due-date normalisation. */

/**
 * Normalise a todo due date: epoch ms (number or numeric string) or an ISO 8601
 * string. Returns undefined when the caller did not provide a value, 0 when the
 * value must be cleared, NaN when it cannot be parsed.
 */
export function parseDueDate(value: string | number | null | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? NaN : parsed;
}
