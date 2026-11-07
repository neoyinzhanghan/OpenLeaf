/**
 * Extract readable plain text from HTML for web-source facts. Zero deps.
 */

export function extractTitleFromHtml(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return decodeEntities(m[1]!).replace(/\s+/g, " ").trim();
}

export function htmlToReadableText(html: string): string {
  let s = html;
  // Drop non-content blocks first.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Block breaks → newlines
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|br|hr)[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s.trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}
