/**
 * Wipe WSIP NSCLC AUROC facts and recreate them with highlights that
 * actually span the model name AND the reported number in the PDF text layer.
 *
 * Usage (from server/): node scripts/wsip_redo_nsclc_facts.mjs
 */
import { execFileSync } from "node:child_process";
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

const { listAllRecords } = await import("../dist/services/library/index.js");
const { createFact, listFacts, deleteFact } = await import("../dist/services/library/facts.js");
const { getPdfTextForPaper, locateQuoteInPages, pdfTextCapability } =
  await import("../dist/services/library/pdfText.js");
const { attachmentPath } = await import("../dist/services/library/paths.js");

const NSCLC_CTX = /NSCLC|TCGA[-\s]?NSCLC|TCGA[-\s]?LUNG|TCGA Lung|Lung Cancer|LUAD|LUSC/i;

/** Curated NSCLC AUROC rows (decimal) for papers whose tables we verified. */
const CURATED = {
  lu2021data: [{ model: "CLAM", auroc: 0.956, prefer: ["average test AUC of 0.956", "AUC of 0.956"] }],
  shao2021transmil: [
    { model: "TransMIL", auroc: 0.9603 },
    { model: "CLAM-MB", auroc: 0.9377 },
    { model: "CLAM-SB", auroc: 0.8818 },
    { model: "DSMIL", auroc: 0.8925 },
    { model: "MIL-RNN", auroc: 0.9107 },
    { model: "ABMIL", auroc: 0.8656 },
    { model: "Max-pooling", auroc: 0.9463 },
    { model: "Mean-pooling", auroc: 0.9054 },
  ],
  li2021dsmil: [
    { model: "DSMIL", auroc: 0.9633 },
    { model: "MS-ABMIL", auroc: 0.9551 },
  ],
  yang2024mambamil: [
    { model: "MambaMIL", auroc: 0.959 },
    { model: "ABMIL", auroc: 0.938 },
    { model: "CLAM-MB", auroc: 0.933 },
    { model: "DSMIL", auroc: 0.94 },
    { model: "TransMIL", auroc: 0.937 },
    { model: "S4MIL", auroc: 0.914 },
    { model: "Max-Pooling", auroc: 0.943 },
    { model: "Mean-Pooling", auroc: 0.913 },
    { model: "DTFDMIL", auroc: 0.928 },
  ],
  li2024dynamic: [
    { model: "WiKG", auroc: 0.9078 },
    { model: "ABMIL", auroc: 0.848 },
    { model: "CLAM-SB", auroc: 0.8925 },
    { model: "CLAM-MB", auroc: 0.8866 },
    { model: "DSMIL", auroc: 0.883 },
    { model: "TransMIL", auroc: 0.8589 },
    { model: "DTFD-MIL", auroc: 0.887 },
  ],
  tang2023multiple: [
    { model: "Max-pooling", auroc: 0.8645, prefer: ["86.45"] },
    { model: "Mean-pooling", auroc: 0.9013, prefer: ["90.13"] },
    { model: "MHIM-MIL (DSMIL)", auroc: 0.9553, prefer: ["MHIM-MIL (DSMIL)", "95.53"] },
    { model: "MHIM-MIL (AB-MIL)", auroc: 0.9497, prefer: ["MHIM-MIL (AB-MIL)", "94.97"] },
    { model: "MHIM-MIL (TransMIL)", auroc: 0.9487, prefer: ["MHIM-MIL (TransMIL)", "94.87"] },
    { model: "DTFD-MIL", auroc: 0.9383, prefer: ["93.83"] },
    { model: "DSMIL", auroc: 0.9371, prefer: ["93.71"] },
    { model: "CLAM-MB", auroc: 0.9369, prefer: ["93.69"] },
    { model: "CLAM-SB", auroc: 0.9367, prefer: ["93.67"] },
    { model: "AB-MIL", auroc: 0.9317, prefer: ["93.17"] },
    { model: "TransMIL", auroc: 0.9251, prefer: ["92.51"] },
  ],
  tang2025mhim: [
    { model: "MHIM-v2 (DSMIL)", auroc: 0.9682, prefer: ["MHIM-v2(DSMIL)", "96.82"] },
    { model: "MHIM (DSMIL)", auroc: 0.9669, prefer: ["MHIM(DSMIL)", "96.69"] },
    { model: "MHIM-v2 (TransMIL)", auroc: 0.9629, prefer: ["MHIM-v2(TransMIL)", "96.29"] },
    { model: "MHIM-v2 (AB-MIL)", auroc: 0.9622, prefer: ["MHIM-v2(AB-MIL)", "96.22"] },
    { model: "AB-MIL", auroc: 0.9532, prefer: ["95.32"] },
    { model: "CLAM", auroc: 0.9537, prefer: ["95.37"] },
    { model: "DSMIL", auroc: 0.9557, prefer: ["95.57"] },
    { model: "TransMIL", auroc: 0.9497, prefer: ["94.97"] },
    { model: "DTFD-MIL", auroc: 0.9555, prefer: ["95.55"] },
    { model: "IBMIL", auroc: 0.9557, prefer: ["95.57"] },
  ],
  zhao2025mexd: [
    { model: "MExD", auroc: 0.9813, prefer: ["98.13"] },
    { model: "IBMIL", auroc: 0.9745, prefer: ["97.45"] },
    { model: "MambaMIL", auroc: 0.9716, prefer: ["97.16"] },
    { model: "CLAM-MB", auroc: 0.9713, prefer: ["97.13"] },
    { model: "CLAM-SB", auroc: 0.969, prefer: ["96.90", "96.9"] },
    { model: "ACMIL", auroc: 0.968, prefer: ["96.80", "96.8"] },
    { model: "MHIM-MIL", auroc: 0.9673, prefer: ["96.73"] },
    { model: "DSMIL", auroc: 0.964, prefer: ["96.40", "96.4"] },
    { model: "WiKG", auroc: 0.9595, prefer: ["95.95"] },
    { model: "ABMIL", auroc: 0.9587, prefer: ["95.87"] },
    { model: "TransMIL", auroc: 0.9589, prefer: ["95.89"] },
    { model: "DTFD-MIL", auroc: 0.9498, prefer: ["94.98"] },
  ],
  zhao2025ptcmil: [
    { model: "PTCMIL", auroc: 0.9731 },
    { model: "MambaMIL", auroc: 0.9268 },
    { model: "CLAM", auroc: 0.916 },
    { model: "DTFD-MIL", auroc: 0.9102 },
    { model: "TransMIL", auroc: 0.9072 },
    { model: "DSMIL", auroc: 0.9087 },
    { model: "ABMIL", auroc: 0.8981 },
  ],
  fourkioti2024camil: [
    { model: "CAMIL", auroc: 0.975 },
    { model: "TransMIL", auroc: 0.974 },
    { model: "CLAM-MB", auroc: 0.973 },
    { model: "CLAM-SB", auroc: 0.972 },
    { model: "DTFD-MIL", auroc: 0.964 },
    { model: "DSMIL", auroc: 0.954 },
  ],
  // Table 1 TCGA Lung Cancer columns are Acc / AUC / F1 — store AUC only.
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
  dong2025ahdmil: [
    { model: "AHDMIL", auroc: 0.9902 },
    { model: "S4MIL", auroc: 0.9619 },
    { model: "CLAM-MB", auroc: 0.9559 },
    { model: "MambaMIL", auroc: 0.9537 },
    { model: "CLAM-SB", auroc: 0.9505 },
    { model: "DTFD-AFS", auroc: 0.9559 },
    { model: "ABMIL", auroc: 0.9492 },
    { model: "TransMIL", auroc: 0.9457 },
    { model: "DSMIL", auroc: 0.9211 },
  ],
  aftab2024neighborhood: [
    // Prefer TABLE 2 (TCGA-NSCLC) rows — TABLE 1 is Camelyon16 with the same 0.940.
    {
      model: "NATMIL",
      auroc: 0.94,
      prefer: ["NATMIL 0.881 ± 0.0303 0.882 ± 0.017 0.940", "0.881 ± 0.0303"],
    },
    { model: "CLAM-MB", auroc: 0.932, prefer: ["0.9320 ± 0.027", "0.9320"] },
    { model: "ABMIL-GATED", auroc: 0.88, prefer: ["0.880 ± 0.057", "0.880"] },
    // TABLE 2 NSCLC AUC (not Camelyon F1 0.862).
    { model: "CLAM-SB", auroc: 0.897, prefer: ["0.897 ± 0.026", "0.897"] },
  ],
};

function numberVariants(auroc) {
  const out = new Set();
  const d = Number(auroc);
  if (!Number.isFinite(d)) return [];
  // Prefer longer printed forms first so "0.940" wins over "0.94".
  out.add(d.toFixed(4));
  out.add(d.toFixed(3));
  out.add(d.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
  out.add(d.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));
  out.add(d.toFixed(2));
  out.add(String(d));
  // percent forms as printed in many MIL tables
  const pct = d * 100;
  out.add(pct.toFixed(2));
  out.add(pct.toFixed(1));
  out.add(pct.toFixed(0));
  out.add(`${pct.toFixed(2)}%`);
  out.add(`${pct.toFixed(1)}%`);
  // drop empties / too short; longest first
  return [...out].filter((s) => s && s.length >= 3).sort((a, b) => b.length - a.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWs(s) {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Find the shortest PDF-text span that contains BOTH the model and a printed
 * form of the AUROC, preferably on a page that mentions NSCLC/LUNG.
 */
function findTightQuote(pages, model, auroc, preferQuotes = []) {
  const variants = numberVariants(auroc);
  const modelPat = new RegExp(escapeRegExp(model).replace(/\\ /g, "\\s+"), "i");

  // 1) Preferred exact phrases first (must still contain a value variant)
  for (const pref of preferQuotes) {
    for (const hit of locateQuoteInPages(pages, pref)) {
      const hasVal = variants.some((v) => hit.quote.includes(v));
      if (hasVal || preferQuotes.length) {
        // If prefer is just a value token, require model nearby via separate check below
        if (hasVal && modelPat.test(hit.quote)) {
          return { quote: hit.quote, page: hit.page, reason: "prefer-both" };
        }
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
      // search window around the model mention
      const left = Math.max(0, mi - 120);
      const right = Math.min(text.length, mi + mLen + 240);
      const window = text.slice(left, right);
      for (const v of variants) {
        const vi = window.indexOf(v);
        if (vi < 0) continue;
        // Require NSCLC context either on page or in a wider window
        const wide = text.slice(Math.max(0, mi - 600), Math.min(text.length, mi + 600));
        if (!pageNsclc && !NSCLC_CTX.test(wide)) continue;

        const modelInWin = window.search(modelPat);
        if (modelInWin < 0) continue;
        const a = Math.min(modelInWin, vi);
        const b = Math.max(modelInWin + mLen, vi + v.length);
        // pad slightly so highlight is readable
        const padL = Math.max(0, a - 2);
        const padR = Math.min(window.length, b + 2);
        let quote = normalizeWs(window.slice(padL, padR));
        // Must contain both after normalize
        if (!modelPat.test(quote)) continue;
        if (![...variants].some((vv) => quote.includes(vv))) continue;
        // Reject huge blobs
        if (quote.length > 220) {
          quote = normalizeWs(window.slice(a, b));
        }
        if (quote.length < 5 || quote.length > 220) continue;

        // Verify locatable
        const hits = locateQuoteInPages(pages, quote);
        if (!hits.length) {
          // try raw slice without aggressive ws collapse for locate
          const rawQuote = window.slice(padL, padR);
          const hits2 = locateQuoteInPages(pages, rawQuote);
          if (!hits2.length) continue;
          quote = hits2[0].quote;
        } else {
          quote = hits[0].quote;
        }

        // Prefer TCGA-NSCLC table rows over Camelyon (same page often has both).
        const nearCamelyon =
          /Camelyon/i.test(wide) && !/TCGA[-\s]?NSCLC/i.test(window);
        const nearNsclcTable = /TCGA[-\s]?NSCLC/i.test(wide);
        const longerVariantBonus = Math.max(0, 12 - v.length); // prefer 0.940 over 0.94
        const score =
          quote.length +
          (pageNsclc ? 0 : 80) +
          (nearCamelyon ? 160 : 0) +
          (nearNsclcTable ? -40 : 0) +
          longerVariantBonus +
          (variants.some((vv) => quote.includes(vv)) ? 0 : 500);
        if (!best || score < best.score) {
          best = { quote, page: page.page, score, reason: "window" };
        }
      }
    }
  }

  // 2) Prefer quotes that are ONLY the value if model+value window failed —
  //    but only when prefer list had a value and we can also attach model via
  //    a second quote. We require BOTH in one highlight — so skip.

  // 3) Try prefer value + model as concatenated search from layout line
  for (const pref of preferQuotes) {
    const combo = `${model} ${pref}`;
    // Find page with both substrings close together
    for (const page of pages) {
      if (!NSCLC_CTX.test(page.text) && !NSCLC_CTX.test(page.text.slice(0, 1) + page.text)) {
        // still allow if prefer hits
      }
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

function formatAnswer(auroc) {
  // Preserve curated precision (0.96 vs 0.9603).
  return String(auroc);
}

function isAucFact(f) {
  if (f.type !== "value") return false;
  return /AUROC|AUC/i.test(f.input) && /NSCLC|TCGA-LUNG|Lung/i.test(f.input);
}

// --- main ---
const papers = (await listAllRecords()).filter(
  (p) => p.collections?.includes("WSIP_Paper") && p.attachment,
);

let deleted = 0;
for (const p of papers) {
  const facts = await listFacts(p.citekey);
  for (const f of facts) {
    if (!isAucFact(f)) continue;
    await deleteFact(p.citekey, f.id);
    deleted++;
  }
}
console.log(`Deleted ${deleted} AUROC/NSCLC value facts`);

let created = 0;
let skipped = 0;
const report = [];

for (const paper of papers) {
  const rows = CURATED[paper.citekey];
  if (!rows?.length) continue;

  const cap = await pdfTextCapability(paper.citekey);
  if (!cap.ok) {
    console.log(`SKIP ${paper.citekey}: ${cap.reason}`);
    continue;
  }
  const cache = await getPdfTextForPaper(paper.citekey);
  console.log(`\n=== ${paper.citekey} (${rows.length} curated) ===`);

  for (const row of rows) {
    const found = findTightQuote(cache.pages, row.model, row.auroc, row.prefer ?? []);
    if (!found) {
      console.log(`  FAIL ${row.model}=${row.auroc} — no model+value quote`);
      skipped++;
      report.push({ citekey: paper.citekey, model: row.model, auroc: row.auroc, ok: false });
      continue;
    }
    // Final gate: quote must contain a numeric variant of the answer
    const variants = numberVariants(row.auroc);
    const quoteHasNumber = variants.some((v) => found.quote.includes(v));
    if (!quoteHasNumber) {
      console.log(`  FAIL ${row.model}=${row.auroc} — quote lacks number: ${JSON.stringify(found.quote.slice(0, 80))}`);
      skipped++;
      report.push({ citekey: paper.citekey, model: row.model, auroc: row.auroc, ok: false, quote: found.quote });
      continue;
    }
    const modelPat = new RegExp(escapeRegExp(row.model).replace(/\\ /g, "\\s+"), "i");
    if (!modelPat.test(found.quote)) {
      console.log(`  FAIL ${row.model}=${row.auroc} — quote lacks model: ${JSON.stringify(found.quote.slice(0, 80))}`);
      skipped++;
      continue;
    }

    const answer = formatAnswer(row.auroc);
    const input = `AUROC of ${row.model} on TCGA-NSCLC (LUAD vs LUSC, slide-level)`;
    const fact = await createFact(
      paper.citekey,
      { type: "value", input },
      {
        retrieve: async () => ({
          answer,
          // ONE tight quote only — no spray of model-name hits
          quotes: [found.quote],
        }),
      },
    );
    const h = fact.highlights[0];
    console.log(
      `  OK ${row.model}=${answer} p.${h?.page ?? "?"} «${(h?.quote ?? "").slice(0, 90)}» [${found.reason}] h=${fact.highlights.length}`,
    );
    created++;
    report.push({
      citekey: paper.citekey,
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
  path.resolve(serverRoot, "../projects/WSIP Paper/misc/wsip_facts_redo_report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
