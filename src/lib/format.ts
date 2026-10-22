/** Human-readable formatting of timestamps, byte sizes and mime types. */

/**
 * Format an epoch-ms value as UTC "YYYY-MM-DD HH:MM:SS".
 * `pg` returns bigint columns as strings, so both shapes are accepted.
 */
export function formatTimestamp(tsMs: number | string): string {
  if (!tsMs) return "N/A";
  try {
    // pg returns bigint columns as strings: coerce before building the Date
    const value = typeof tsMs === "string" ? parseInt(tsMs, 10) : tsMs;
    if (!Number.isFinite(value) || value <= 0) return "N/A";
    return new Date(value).toISOString().replace("T", " ").substring(0, 19);
  } catch {
    return String(tsMs);
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileExtensionFromName(name: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
}

export const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

export function guessMime(filename: string): string {
  return MIME_BY_EXTENSION[fileExtensionFromName(filename)] || "application/octet-stream";
}
