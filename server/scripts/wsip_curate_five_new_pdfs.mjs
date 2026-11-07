/**
 * Curate NSCLC AUROC facts for the five WSIP papers that just got PDFs.
 * Does NOT wipe other papers' facts.
 *
 * Usage (from server/): node scripts/wsip_curate_five_new_pdfs.mjs
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

/** { model, auroc, searchModel?, prefer? } — searchModel overrides PDF token used for locate */
const CURATED = {
  // Table 2 TCGA-NSCLC (percent AUCs)
  bi2025a: [
    { model: "Max-pooling", auroc: 0.9721, searchModel: "Max Pooling", prefer: ["97.21"] },
    { model: "Mean-pooling", auroc: 0.9707, searchModel: "Mean Pooling", prefer: ["97.07"] },
    { model: "TransMIL", auroc: 0.9706, prefer: ["97.06"] },
    { model: "S4MIL", auroc: 0.9743, prefer: ["97.43"] },
    { model: "MambaMIL", auroc: 0.9734, prefer: ["97.34"] },
    { model: "R2TMIL", auroc: 0.9729, searchModel: "R2TMIL", prefer: ["97.29"] },
    { model: "ConvMixerSSM", auroc: 0.9783, prefer: ["97.83"] },
  ],
  // Table 1 ResNet-50 — first AUC column is TCGA-NSCLC
  ding2025classification: [
    { model: "Max-pooling", auroc: 0.928, searchModel: "Max-Pooling", prefer: ["0.928"] },
    { model: "Mean-pooling", auroc: 0.907, searchModel: "Mean-Pooling", prefer: ["0.907"] },
    { model: "ABMIL", auroc: 0.918, prefer: ["0.918"] },
    { model: "CLAM", auroc: 0.927, prefer: ["0.927"] },
    { model: "TransMIL", auroc: 0.909, prefer: ["0.909"] },
    { model: "S4MIL", auroc: 0.9, prefer: ["0.900"] },
    { model: "MambaMIL", auroc: 0.907, prefer: ["0.907"] },
    { model: "DG-SSM-MIL", auroc: 0.936, prefer: ["0.936"] },
  ],
  // Table 2 — take 20× rows for baselines; CFAMIL multi-scale
  jiang2025non: [
    { model: "ABMIL", auroc: 0.967, prefer: ["0.967"] },
    { model: "CLAM-SB", auroc: 0.975, prefer: ["0.975"] },
    { model: "CLAM-MB", auroc: 0.972, prefer: ["0.972"] },
    { model: "DS-MIL", auroc: 0.928, prefer: ["0.928"] },
    { model: "DTFD-MIL", auroc: 0.969, prefer: ["0.969"] },
    { model: "FR-MIL", auroc: 0.88, prefer: ["0.880"] },
    { model: "WIKG-MIL", auroc: 0.96, prefer: ["0.960"] },
    { model: "CFAMIL", auroc: 0.978, prefer: ["0.978"] },
  ],
  // Table 2 ResNet50 / ImageNet pretrained block (TCGA-NSCLC AUC)
  mao2025camil: [
    { model: "ABMIL", auroc: 0.9064, prefer: ["0.9064"] },
    { model: "DSMIL", auroc: 0.9494, prefer: ["0.9494"] },
    { model: "CLAM-SB", auroc: 0.9395, prefer: ["0.9395"] },
    { model: "CLAM-MB", auroc: 0.9411, prefer: ["0.9411"] },
    { model: "TransMIL", auroc: 0.9414, prefer: ["0.9414"] },
    { model: "DTFD", auroc: 0.9457, prefer: ["0.9457"] },
    { model: "IBMIL", auroc: 0.9423, prefer: ["0.9423"] },
    { model: "MHIM", auroc: 0.9495, prefer: ["0.9495"] },
    { model: "CAMIL", auroc: 0.9578, searchModel: "CAMILa", prefer: ["0.9578"] },
  ],
  // Table 3(a) CTransPath — TCGA AUC column (headline NSCLC numbers)
  zheng2025fouriermil: [
    { model: "ABMIL", auroc: 0.949, prefer: ["0.949"] },
    { model: "CLAM-SB", auroc: 0.975, prefer: ["0.975"] },
    { model: "CLAM-MB", auroc: 0.976, prefer: ["0.976"] },
    { model: "Patch-GCN", auroc: 0.975, prefer: ["0.975"] },
    { model: "GTP", auroc: 0.969, prefer: ["0.969"] },
    { model: "TransMIL", auroc: 0.973, prefer: ["0.973"] },
    { model: "DTFD-MIL", auroc: 0.97, prefer: ["0.970"] },
    // Table row is "Ours"; prose states AUC of 0.977 on TCGA-NSCLC
    {
      model: "FourierMIL",
      auroc: 0.977,
      searchModel: "Ours",
      prefer: ["0.9770.008", "AUC of 0.977", "0.977"],
    },
  ],
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
  out.add(`${pct.toFixed(2)}%`);
  out.add(`${pct.toFixed(1)}%`);
  return [...out].filter((s) => s && s.length >= 3).sort((a, b) => b.length - a.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWs(s) {
  return s.replace(/\s+/g, " ").trim();
}

function findTightQuote(pages, model, auroc, preferQuotes = []) {
  const variants = numberVariants(auroc);
  const modelPat = new RegExp(escapeRegExp(model).replace(/\\ /g, "\\s+"), "i");

  for (const pref of preferQuotes) {
    for (const hit of locateQuoteInPages(pages, pref)) {
      const hasVal = variants.some((v) => hit.quote.includes(v));
      if (hasVal && modelPat.test(hit.quote)) {
        return { quote: hit.quote, page: hit.page, reason: "prefer-both" };
      }
    }
  }

  let best = null;

  for (const page of pages) {
    const text = page.text;
    const pageNsclc = NSCLC_CTX.test(text);
    const modelMatches = [...text.matchAll(new RegExp(modelPat.source, "gi"))];
    for (const m of modelMatches) {
      const mi = m.index ?? 0;
      const mLen = m[0].length;
      const left = Math.max(0, mi - 120);
      const right = Math.min(text.length, mi + mLen + 240);
      const window = text.slice(left, right);
      for (const v of variants) {
        const vi = window.indexOf(v);
        if (vi < 0) continue;
        const wide = text.slice(Math.max(0, mi - 600), Math.min(text.length, mi + 600));
        if (!pageNsclc && !NSCLC_CTX.test(wide)) continue;

        const modelInWin = window.search(modelPat);
        if (modelInWin < 0) continue;
        const a = Math.min(modelInWin, vi);
        const b = Math.max(modelInWin + mLen, vi + v.length);
        const padL = Math.max(0, a - 2);
        const padR = Math.min(window.length, b + 2);
        let quote = normalizeWs(window.slice(padL, padR));
        if (!modelPat.test(quote)) continue;
        if (![...variants].some((vv) => quote.includes(vv))) continue;
        if (quote.length > 220) quote = normalizeWs(window.slice(a, b));
        if (quote.length < 5 || quote.length > 220) continue;

        const hits = locateQuoteInPages(pages, quote);
        if (!hits.length) {
          const rawQuote = window.slice(padL, padR);
          const hits2 = locateQuoteInPages(pages, rawQuote);
          if (!hits2.length) continue;
          quote = hits2[0].quote;
        } else {
          quote = hits[0].quote;
        }

        const nearCamelyon = /Camelyon/i.test(wide) && !/TCGA[-\s]?NSCLC/i.test(window);
        const nearNsclcTable = /TCGA[-\s]?NSCLC/i.test(wide);
        const longerVariantBonus = Math.max(0, 12 - v.length);
        const score =
          quote.length +
          (pageNsclc ? 0 : 80) +
          (nearCamelyon ? 160 : 0) +
          (nearNsclcTable ? -40 : 0) +
          longerVariantBonus;
        if (!best || score < best.score) {
          best = { quote, page: page.page, score, reason: "window" };
        }
      }
    }
  }

  for (const pref of preferQuotes) {
    for (const page of pages) {
      const mi = page.text.search(modelPat);
      const vi = page.text.indexOf(pref);
      if (mi < 0 || vi < 0) continue;
      if (Math.abs(mi - vi) > 280) continue;
      const a = Math.min(mi, vi);
      const b = Math.max(mi + model.length, vi + pref.length);
      const raw = page.text.slice(Math.max(0, a - 1), Math.min(page.text.length, b + 1));
      const hits = locateQuoteInPages(pages, raw);
      if (!hits.length) continue;
      const quote = hits[0].quote;
      if (!modelPat.test(quote)) continue;
      if (!variants.some((v) => quote.includes(v)) && !quote.includes(pref)) continue;
      const score = quote.length;
      if (!best || score < best.score) best = { quote, page: page.page, score, reason: "prefer-combo" };
    }
  }

  return best;
}

function isAucFact(f) {
  if (f.type !== "value") return false;
  return /AUROC|AUC/i.test(f.input) && /NSCLC|TCGA-LUNG|Lung/i.test(f.input);
}

const TARGETS = Object.keys(CURATED);
const report = [];
let created = 0;
let skipped = 0;
let deleted = 0;

for (const citekey of TARGETS) {
  const rows = CURATED[citekey];
  const existing = await listFacts(citekey);
  for (const f of existing) {
    if (!isAucFact(f)) continue;
    await deleteFact(citekey, f.id);
    deleted++;
  }

  const cap = await pdfTextCapability(citekey);
  if (!cap.ok) {
    console.log(`SKIP ${citekey}: ${cap.reason}`);
    for (const row of rows) {
      skipped++;
      report.push({ citekey, model: row.model, auroc: row.auroc, ok: false, reason: cap.reason });
    }
    continue;
  }

  console.log(`\n=== ${citekey}: extracting PDF text ===`);
  const cache = await getPdfTextForPaper(citekey);
  console.log(`=== ${citekey} (${rows.length} curated, ${cache.pages.length} pages) ===`);

  for (const row of rows) {
    const searchModel = row.searchModel ?? row.model;
    const found = findTightQuote(cache.pages, searchModel, row.auroc, row.prefer ?? []);
    if (!found) {
      console.log(`  FAIL ${row.model}=${row.auroc} — no model+value quote (search=${searchModel})`);
      skipped++;
      report.push({ citekey, model: row.model, auroc: row.auroc, ok: false });
      continue;
    }
    const variants = numberVariants(row.auroc);
    if (!variants.some((v) => found.quote.includes(v))) {
      console.log(`  FAIL ${row.model}=${row.auroc} — quote lacks number: ${JSON.stringify(found.quote.slice(0, 80))}`);
      skipped++;
      report.push({ citekey, model: row.model, auroc: row.auroc, ok: false, quote: found.quote });
      continue;
    }

    const answer = String(row.auroc);
    const input = `AUROC of ${row.model} on TCGA-NSCLC (LUAD vs LUSC, slide-level)`;
    const fact = await createFact(
      citekey,
      { type: "value", input },
      {
        retrieve: async () => ({
          answer,
          quotes: [found.quote],
        }),
      },
    );
    const h = fact.highlights[0];
    console.log(
      `  OK ${row.model}=${answer} p.${h?.page ?? "?"} «${(h?.quote ?? "").slice(0, 90)}» [${found.reason}]`,
    );
    created++;
    report.push({
      citekey,
      model: row.model,
      auroc: answer,
      ok: true,
      page: h?.page,
      quote: h?.quote,
    });
  }
}

console.log(`\nDone. created=${created} skipped=${skipped} deleted=${deleted}`);
fs.writeFileSync(
  path.resolve(serverRoot, "../projects/WSIP Paper/misc/wsip_facts_five_new_pdfs_report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
