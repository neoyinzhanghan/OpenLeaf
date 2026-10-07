/** Shared labels & helpers for Paperpile/Zotero-style library organization. */
import type { LibrarySort, PaperRecord } from "../api/types";

export const SORT_OPTIONS: Array<{ id: LibrarySort; label: string }> = [
  { id: "added", label: "Recently updated" },
  { id: "title", label: "Title" },
  { id: "year", label: "Year" },
  { id: "rating", label: "Rating" },
  { id: "starred", label: "Starred first" },
];

/** Topic suggestions (subject matter — not workflow labels). */
export const TOPIC_SUGGESTIONS = [
  "machine-learning",
  "statistics",
  "calibration",
  "label-shift",
  "hematology",
  "pathology",
  "deep-learning",
  "imaging",
  "clinical",
  "theory",
  "methods",
  "benchmark",
];

/** @deprecated Use TOPIC_SUGGESTIONS */
export const QUICK_TAGS = TOPIC_SUGGESTIONS;

export function normalizePaper(p: PaperRecord): PaperRecord {
  return {
    ...p,
    starred: Boolean(p.starred),
    status: p.status ?? "unread",
    rating: typeof p.rating === "number" ? p.rating : 0,
    tags: p.tags ?? [],
    collections: p.collections ?? [],
  };
}

export function ratingStars(rating: number): string {
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export function slugCollectionId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || `collection-${Date.now()}`;
}
