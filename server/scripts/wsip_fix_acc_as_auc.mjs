/**
 * Retarget WSIP AUROC facts that were curated/highlighted on Accuracy (or F1)
 * instead of the TCGA-NSCLC AUC cell.
 *
 * Usage (from server/): node scripts/wsip_fix_acc_as_auc.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
if (!process.env.OPENLEAF_LIBRARY_ROOT) {
  process.env.OPENLEAF_LIBRARY_ROOT = path.resolve(serverRoot, "../library");
}

const { loadConfig } = await import("../dist/config.js");
loadConfig(true);

const { createFact, listFacts, deleteFact } = await import("../dist/services/library/facts.js");
const { getPdfTextForPaper, locateQuoteInPages, pdfTextCapability } =
  await import("../dist/services/library/pdfText.js");

const NSCLC_CTX = /NSCLC|TCGA[-\s]?NSCLC|TCGA[-\s]?LUNG|TCGA Lung|Lung Cancer|LUAD|LUSC/i;

/** citekey → rows to replace (delete existing AUROC fact for that model, recreate). */
const FIXES = {
  // Table 1 TCGA Lung: Acc AUC F1 — previous answers were Acc.
  fang2024sam: [
    { model: "Max-pooling", auroc: 0.9389, prefer: ["93.89"] },
    { model: "Mean-pooling", auroc: 0.9267, prefer: ["92.67"] },
    { model: "AB-MIL", auroc: 0.9439, prefer: ["94.39"] },
    { model: "DSMIL", auroc: 0.9503, prefer: ["95.03"] },
    { model: "CLAM-SB", auroc: 0.9453, prefer: ["94.53"] },
    { model: "CLAM-MB", auroc: 0.9442, prefer: ["94.42"] },
    { model: "TransMIL", auroc: 0.9471, prefer: ["94.71"] },
    { model: "DTFD-MIL", auroc: 0.9539, prefer: ["95.39"] },
    { model: "IBMIL", auroc: 0.9459, prefer: ["94.59"] },
    { model: "MHIM-MIL", auroc: 0.9577, prefer: ["95.77"] },
    { model: "SAM-MIL", auroc: 0.9601, prefer: ["96.01"] },
  ],
  // Table 1 TCGA: Max Acc 81.49 / AUC 86.45; Mean Acc… / AUC 90.13 (was Camelyon F1).
  tang2023multiple: [
    { model: "Max-pooling", auroc: 0.8645, prefer: ["86.45"] },
    { model: "Mean-pooling", auroc: 0.9013, prefer: ["90.13"] },
  ],
  // Table 2 TCGA-NSCLC ResNet block: DTFD Acc 89.85 / AUC 95.55.
  tang2025mhim: [{ model: "DTFD-MIL", auroc: 0.9555, prefer: ["95.55"] }],
};

function numberVariants(auroc) {
  const out = new Set();
  const d = Number(auroc);
  if (!Number.isFinite(d)) return [];
  out.add(d.toFixed(4));
  out.add(d.toFixed(3));
  out.add(d.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
  out.add(d.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));
  out.add(d.toFixed(2));
  out.add(String(d));
  const pct = d * 100;
  out.add(pct.toFixed(2));
  out.add(pct.toFixed(1));
  out.add(pct.toFixed(0));
  return [...out].filter((s) => s && s.length >= 3).sort((a, b) => b.length - a.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactNumber(text, auroc) {
  const forms = numberVariants(auroc).filter((s) => s.length >= 4 || /^\d{2}\.\d{2}$/.test(s));
  for (const v of forms) {
    const re = new RegExp(`(?<!\\d)${v.replace(/\./g, "\\.")}(?!\\d)`);
    if (re.test(text)) return v;
  }
  return null;
}

function findTightQuote(pages, model, auroc, preferQuotes = []) {
  const variants = numberVariants(auroc);
  const modelPat = new RegExp(escapeRegExp(model).replace(/ /g, "\\s+"), "i");

  for (const pref of preferQuotes) {
    for (const page of pages) {
      if (!NSCLC_CTX.test(page.text) && !preferQuotes.length) continue;
      const mi = page.text.search(modelPat);
      const vi = page.text.indexOf(pref);
      if (mi < 0 || vi < 0) continue;
      if (Math.abs(mi - vi) > 320) continue;
      const a = Math.min(mi, vi);
      const b = Math.max(mi + model.length, vi + pref.length);
      const raw = page.text.slice(Math.max(0, a - 1), Math.min(page.text.length, b + 1));
      const hits = locateQuoteInPages(pages, raw);
      if (!hits.length) continue;
      // Tighten to the preferred AUC token when possible
      for (const hit of hits) {
        const exact = hasExactNumber(hit.quote, auroc) || (hit.quote.includes(pref) ? pref : null);
        if (!exact) continue;
        const at = page.text.indexOf(exact, hit.start);
        if (at >= 0) {
          return {
            quote: page.text.slice(at, at + exact.length),
            page: page.page,
            start: at,
            end: at + exact.length,
            reason: "prefer-auc-token",
          };
        }
        return { quote: hit.quote, page: hit.page, reason: "prefer-combo" };
      }
    }
    // Prefer token alone on an NSCLC page near the model
    for (const page of pages) {
      if (!NSCLC_CTX.test(page.text)) continue;
      if (page.text.search(modelPat) < 0) continue;
      for (const hit of locateQuoteInPages(pages, pref)) {
        if (hit.page !== page.page) continue;
        const exact = hasExactNumber(hit.quote, auroc);
        if (!exact && !hit.quote.includes(pref)) continue;
        return { quote: hit.quote.includes(pref) ? pref : hit.quote, page: hit.page, reason: "prefer-value" };
      }
    }
  }

  let best = null;
  for (const page of pages) {
    if (!NSCLC_CTX.test(page.text)) continue;
    for (const m of page.text.matchAll(new RegExp(modelPat.source, "gi"))) {
      const mi = m.index ?? 0;
      const win = page.text.slice(Math.max(0, mi - 40), Math.min(page.text.length, mi + m[0].length + 220));
      for (const v of variants) {
        if (!hasExactNumber(win, auroc)) continue;
        const matched = hasExactNumber(win, auroc);
        const vi = win.indexOf(matched);
        if (vi < 0) continue;
        const raw = win.slice(Math.min(win.search(modelPat), vi), Math.max(win.search(modelPat) + m[0].length, vi + matched.length));
        const hits = locateQuoteInPages(pages, matched);
        if (!hits.length) continue;
        // Prefer the hit closest to this model mention
        const hit = hits.find((h) => h.page === page.page) ?? hits[0];
        const score = Math.abs((hit.start ?? 0) - mi) + matched.length;
        if (!best || score < best.score) best = { quote: matched, page: hit.page, score, reason: "window" };
      }
    }
  }
  return best;
}

function isAucFact(f) {
  return f.type === "value" && /AUROC|AUC/i.test(f.input) && /NSCLC|TCGA-LUNG|Lung/i.test(f.input);
}

function modelsMatch(factInput, model) {
  const got = factInput.replace(/^AUROC of\s+/i, "").replace(/\s+on\s+.*/i, "").trim();
  return got.toLowerCase() === model.toLowerCase();
}

const report = [];
let created = 0;
let deleted = 0;

for (const [citekey, rows] of Object.entries(FIXES)) {
  const cap = await pdfTextCapability(citekey);
  if (!cap.ok) {
    console.log(`SKIP ${citekey}: ${cap.reason}`);
    continue;
  }
  const cache = await getPdfTextForPaper(citekey);
  const existing = await listFacts(citekey);
  console.log(`\n=== ${citekey} ===`);

  for (const row of rows) {
    for (const f of existing) {
      if (!isAucFact(f)) continue;
      if (!modelsMatch(f.input, row.model)) continue;
      await deleteFact(citekey, f.id);
      deleted++;
      console.log(`  deleted old ${row.model}=${f.answer} «${f.highlights?.[0]?.quote ?? ""}»`);
    }

    const found = findTightQuote(cache.pages, row.model, row.auroc, row.prefer ?? []);
    if (!found) {
      console.log(`  FAIL ${row.model}=${row.auroc}`);
      report.push({ citekey, model: row.model, auroc: row.auroc, ok: false });
      continue;
    }
    const answer = String(row.auroc);
    const fact = await createFact(
      citekey,
      { type: "value", input: `AUROC of ${row.model} on TCGA-NSCLC (LUAD vs LUSC, slide-level)` },
      { retrieve: async () => ({ answer, quotes: [found.quote] }) },
    );
    console.log(
      `  OK ${row.model}=${answer} p.${fact.highlights[0]?.page ?? "?"} «${fact.highlights[0]?.quote ?? ""}» [${found.reason}]`,
    );
    created++;
    report.push({
      citekey,
      model: row.model,
      auroc: answer,
      ok: true,
      page: fact.highlights[0]?.page,
      quote: fact.highlights[0]?.quote,
    });
  }
}

console.log(`\nDone. created=${created} deleted=${deleted}`);
fs.writeFileSync(
  path.resolve(serverRoot, "../projects/WSIP Paper/misc/wsip_acc_as_auc_fix_report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
