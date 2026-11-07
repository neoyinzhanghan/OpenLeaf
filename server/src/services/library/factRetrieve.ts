/**
 * AI-assisted fact retrieval from a paper's PDF text layer.
 * Uses the same OpenAI-compatible chat completions env as claim-check.ts.
 */
import type { FactType } from "./facts.js";
import type { PdfTextPage } from "./pdfText.js";

export type FactRetrieveResult = {
  answer: string;
  /** Exact quotes the model claims appear in the PDF (must match text layer). */
  quotes: string[];
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function llmEndpoint(): { url: string; apiKey: string; model: string } | null {
  const url =
    process.env.OPENLEAF_CLAIM_CHECK_URL ??
    (process.env.OPENLEAF_OPENAI_API_KEY ? "https://api.openai.com/v1/chat/completions" : "");
  const apiKey =
    process.env.OPENLEAF_CLAIM_CHECK_API_KEY ?? process.env.OPENLEAF_OPENAI_API_KEY ?? "";
  const model = process.env.OPENLEAF_CLAIM_CHECK_MODEL ?? "gpt-4o-mini";
  if (!url || !apiKey) return null;
  return { url, apiKey, model };
}

function pageExcerpt(pages: PdfTextPage[], maxChars = 48_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const p of pages) {
    const header = `\n--- Page ${p.page} ---\n`;
    const body = p.text;
    if (used + header.length + body.length > maxChars) {
      const remain = Math.max(0, maxChars - used - header.length);
      if (remain > 200) parts.push(header + body.slice(0, remain));
      break;
    }
    parts.push(header + body);
    used += header.length + body.length;
  }
  return parts.join("");
}

function systemPrompt(type: FactType): string {
  const quoteRules = [
    "You MUST quote supporting text EXACTLY as it appears in the PDF text (copy verbatim).",
    "Never paraphrase inside quotes. Prefer short contiguous passages (1–3 sentences).",
    "Return JSON only, no markdown fences.",
  ].join(" ");

  switch (type) {
    case "statement":
      return [
        "You check whether a research paper supports a user's claim.",
        "Given the PDF text and a claim, decide supported or not_supported,",
        "and quote the exact passage(s) that justify that decision.",
        quoteRules,
        'Schema: {"answer":"supported"|"not_supported","quotes":["exact text",...]}',
        "If the paper does not address the claim, use not_supported with empty quotes.",
      ].join(" ");
    case "value":
      return [
        "You extract a named quantity from a research paper's PDF text.",
        "Given the PDF text and a value name (e.g. a metric on a dataset), fill in the value",
        "and quote the exact passage where that value appears.",
        quoteRules,
        'Schema: {"answer":"<the value as a short string>","quotes":["exact text",...]}',
        "If the value cannot be found, return empty answer and empty quotes.",
      ].join(" ");
    case "question":
      return [
        "You answer a question about a research paper using only its PDF text.",
        "Quote the exact passage(s) your answer is based on.",
        quoteRules,
        'Schema: {"answer":"<concise answer>","quotes":["exact text",...]}',
        "If the paper does not contain enough information, return empty answer and empty quotes.",
      ].join(" ");
    case "tag":
      return [
        "You locate a labeled part of a research paper (theorem, proposition, section, figure, etc.).",
        "Do not answer anything beyond finding where it appears.",
        "Quote the exact heading or first sentence that marks that location.",
        quoteRules,
        'Schema: {"answer":"","quotes":["exact text",...]}',
        "If the label cannot be found, return empty quotes.",
      ].join(" ");
  }
}

function userPrompt(type: FactType, input: string, paperTitle: string, excerpt: string): string {
  const label =
    type === "statement"
      ? "Claim"
      : type === "value"
        ? "Value to extract"
        : type === "question"
          ? "Question"
          : "Tag / label to locate";
  return [
    `Paper title: ${paperTitle}`,
    `${label}: ${input}`,
    "",
    "PDF text:",
    excerpt,
  ].join("\n");
}

function parseModelJson(raw: string): FactRetrieveResult {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]!.trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(body.slice(start, end + 1));
      } catch {
        return { answer: "", quotes: [] };
      }
    } else {
      return { answer: "", quotes: [] };
    }
  }
  if (!parsed || typeof parsed !== "object") return { answer: "", quotes: [] };
  const obj = parsed as Record<string, unknown>;
  let answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
  const quotes: string[] = [];
  const quotesRaw = obj.quotes;
  if (Array.isArray(quotesRaw)) {
    for (const q of quotesRaw) {
      if (typeof q === "string" && q.trim()) quotes.push(q.trim());
    }
  } else if (typeof obj.quote === "string" && obj.quote.trim()) {
    quotes.push(obj.quote.trim());
  }
  if (answer === "not supported") answer = "not_supported";
  return { answer, quotes };
}

async function chatComplete(messages: ChatMessage[]): Promise<string> {
  const endpoint = llmEndpoint();
  if (!endpoint) {
    throw Object.assign(
      new Error("AI API key is not configured (OPENLEAF_CLAIM_CHECK_* / OPENLEAF_OPENAI_API_KEY)"),
      { status: 503 },
    );
  }
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: endpoint.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`AI request failed (${res.status})${detail ? `: ${detail.slice(0, 400)}` : ""}`),
      { status: 502 },
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

export async function retrieveFactFromPdf(args: {
  type: FactType;
  input: string;
  paperTitle: string;
  pages: PdfTextPage[];
}): Promise<FactRetrieveResult> {
  const excerpt = pageExcerpt(args.pages);
  if (!excerpt.trim()) return { answer: "", quotes: [] };

  const content = await chatComplete([
    { role: "system", content: systemPrompt(args.type) },
    { role: "user", content: userPrompt(args.type, args.input, args.paperTitle, excerpt) },
  ]);

  const result = parseModelJson(content);
  if (args.type === "statement") {
    if (result.answer !== "supported" && result.answer !== "not_supported") {
      result.answer = result.quotes.length ? "supported" : "not_supported";
    }
  } else if (args.type === "tag") {
    result.answer = "";
  }
  return result;
}
