/** Item identity and sync mapping helpers. */

import * as crypto from "node:crypto";
import { JOP_TYPE_NOTE } from "./joplin-types.js";

export function generateId(): string {
  // Joplin uses 22-char base62 IDs (0-9, a-z, A-Z) for the 'id' field
  // Use 22 random bytes (one per char) to avoid repetitive patterns
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(22);
  let id = "";
  for (let i = 0; i < 22; i++) {
    id += chars[bytes[i] % 62];
  }
  return id;
}

export function generateJopId(): string {
  // Joplin Server v3 uses 32-char UUID hex (no dashes) for the 'jop_id' field
  return crypto.randomUUID().replace(/-/g, "");
}

/** Map jop_type (items table) to item_type (changes table). */
export function jopTypeToChangeItemType(jopType: number): number {
  // In items: jop_type 1=note, 2=folder
  // In changes: item_type 2=note, 1=folder (swapped!)
  return jopType === JOP_TYPE_NOTE ? 2 : 1;
}
