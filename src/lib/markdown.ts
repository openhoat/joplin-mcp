/** Markdown links used inside note bodies. */

export function escapeMarkdownLabel(label: string): string {
  return label.replace(/([[\]\\])/g, "\\$1");
}

export function buildResourceLink(label: string, resourceJopId: string, asImage: boolean): string {
  return `${asImage ? "!" : ""}[${escapeMarkdownLabel(label)}](:/${resourceJopId})`;
}
