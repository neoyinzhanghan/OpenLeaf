/**
 * One-off: extract TCGA-NSCLC (or TCGA-LUNG) AUROC rows from attached PDFs
 * and create one unreviewed Value fact per (paper, model).
 *
 * Usage: node --experimental-vm-modules OR from server/: npx tsx scripts/wsip_extract_nsclc_facts.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");

// Ensure library root matches running OpenLeaf
if (!process.env.OPENLEAF_LIBRARY_ROOT) {
  process.env.OPENLEAF_LIBRARY_ROOT = path.resolve(serverRoot, "../library");
}

const { loadConfig } = await import("../dist/config.js");
loadConfig(true);

const { listAllRecords } = await import("../dist/services/library/index.js");
const { createFact, listFacts } = await import("../dist/services/library/facts.js");
const { getPdfTextForPaper, locateQuoteInPages, pdfTextCapability } =
  await import("../dist/services/library/pdfText.js");
const { attachmentPath } = await import("../dist/services/library/paths.js");

const MODEL_ALIASES = [
  "Mean-pooling",
  "Max-pooling",
  "MeanPooling",
  "MaxPooling",
  "ABMIL",
  "AB-MIL",
  "ABMIL-GATED",
  "PT-MTA",
  "MIL-RNN",
  "DSMIL",
  "CLAM-SB",
  "CLAM-MB",
  "CLAM",
  "TransMIL",
  "DTFD-MIL",
  "DTFD-MIL (AFS)",
  "DTFD-MIL (MaxS)",
  "DTFD-MIL (MaxMinS)",
  "DTFD",
  "IBMIL",
  "MHIM-MIL",
  "MHIM",
  "R2T-MIL",
  "RRT-MIL",
  "CAMIL",
  "CAMIL-L",
  "CAMIL-G",
  "GTP",
  "HIPT",
  "Patch-GCN",
  "WiKG",
  "MambaMIL",
  "PTCMIL",
  "ILRA",
  "PANTHER",
  "DGR-MIL",
  "SAM-MIL",
  "MDMIL",
  "MMIL",
  "MMIL-Transformer",
  "NATMIL",
  "MExD",
  "HDMIL",
  "AHDMIL",
  "LadderMIL",
  "PathMIL",
  "ProtoMIL",
  "SiMLP",
  "FourierMIL",
  "CFAMIL",
  "ConvMixerSSM",
  "DG-SSM-MIL",
  "ResGAT",
  "AEM",
  "ACMIL",
  "DiffMIL",
];

function pdftotext(pdfPath) {
  try {
    return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 80 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function normalizeModel(raw) {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*\[.*?\]\s*/g, " ").replace(/\s*\(ours\)\s*/gi, "").trim();
  s = s.replace(/\s+/g, " ");
  // Drop leading feature-extractor labels glued onto rows
  s = s.replace(/^(CTransPath|UNI|ResNet-?50|ImageNet)\s+/i, "");
  if (!s) return null;
  // Prefer canonical alias match
  const upper = s.toUpperCase();
  for (const a of MODEL_ALIASES) {
    if (upper === a.toUpperCase() || upper.startsWith(a.toUpperCase() + " ")) return a;
  }
  // Keep if looks like a model token
  if (/^[A-Za-z][A-Za-z0-9.+_-]{1,40}$/.test(s.replace(/\s/g, ""))) return s;
  if (/^[A-Za-z0-9].{0,40}$/.test(s) && /MIL|CLAM|GAT|Mamba|Transformer|pooling|Pool/i.test(s)) {
    return s;
  }
  return null;
}

function parseAucToken(tok) {
  // 0.9603 | 96.03 | 0.9603±0.01 | 96.471.12 (mean.std without ±) | 90.781.24
  let t = tok.replace(/,/g, "").trim();
  // percentage with glued stderr like 96.471.12 → 96.47
  let m = t.match(/^(\d{2,3}\.\d{1,4})(\d{2}\.\d{2})?$/);
  if (m && Number(m[1]) > 1) {
    const v = Number(m[1]) / 100;
    if (v > 0.5 && v <= 1) return v;
  }
  m = t.match(/^(\d\.\d{2,4})/);
  if (m) {
    const v = Number(m[1]);
    if (v > 0.5 && v <= 1) return v;
  }
  m = t.match(/^(\d{2,3}\.\d{1,2})%?$/);
  if (m) {
    const v = Number(m[1]) / 100;
    if (v > 0.5 && v <= 1) return v;
  }
  return null;
}

function extractFromText(text) {
  const lines = text.split(/\r?\n/);
  const hits = []; // {model, auroc, line, datasetLabel}

  // Find line indices that mention NSCLC / LUNG cancer typing tables
  const datasetRe =
    /TCGA[-\s]?NSCLC|TCGA[-\s]?LUNG|TCGA Lung Cancer|Lung Cancer dataset|NSCLC dataset/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!datasetRe.test(line) && !/TCGA-NSCLC|TCGA-LUNG/i.test(line)) continue;

    // Look ahead for a header with AUC and then data rows
    const window = lines.slice(i, Math.min(lines.length, i + 60));
    let aucColHint = -1;
    let headerIdx = -1;
    for (let j = 0; j < window.length; j++) {
      const L = window[j];
      if (!/AUC/i.test(L)) continue;
      // Prefer headers that also mention NSCLC/LUNG in same or nearby lines
      const ctx = window.slice(Math.max(0, j - 3), j + 1).join(" ");
      if (!datasetRe.test(ctx) && !/TCGA-NSCLC|TCGA-LUNG|Lung Cancer/i.test(ctx)) {
        // still allow if the anchor line was dataset
        if (!datasetRe.test(line)) continue;
      }
      headerIdx = j;
      // Estimate which AUC column is NSCLC: split header into tokens
      break;
    }
    if (headerIdx < 0) continue;

    // Parse subsequent rows until blank-heavy break
    for (let j = headerIdx + 1; j < Math.min(window.length, headerIdx + 35); j++) {
      const L = window[j];
      if (!L.trim()) {
        // allow one blank
        continue;
      }
      if (/^Table\s+\d/i.test(L.trim()) && j > headerIdx + 2) break;
      if (/Figure\s+\d/i.test(L)) break;

      // Extract candidate model at start
      const cleaned = L.replace(/\u00a0/g, " ");
      // Numbers on the line
      const numToks = cleaned.match(/\d+\.\d+%?/g) || [];
      if (numToks.length < 1) continue;

      // Model = leading non-numeric token sequence
      const lead = cleaned.match(
        /^\s*([A-Za-z][A-Za-z0-9.+ _()-]*?(?:MIL|CLAM|GAT|Mamba|Transformer|pooling|Pool|RNN|HIPT|GTP|ILRA|PANTHER|WiKG|CAMIL|NATMIL|PTCMIL|SiMLP|ProtoMIL|ResGAT|MExD|HDMIL|AHDMIL|FourierMIL|CFAMIL|ACMIL)?[A-Za-z0-9.+ _()-]*)/,
      );
      if (!lead) continue;
      const model = normalizeModel(lead[1]);
      if (!model) continue;

      // Choose AUC: for multi-dataset rows, heuristic —
      // TransMIL-style: Acc AUC Acc AUC Acc AUC → NSCLC AUC is 4th number (index 3)
      // WiKG-style: 3 datasets × (Acc AUC F1) → LUNG AUC is number index 7 (0-based)
      // CAMIL-style: 3 datasets × (Acc AUC) → NSCLC AUC index 3
      let auroc = null;
      const vals = numToks.map(parseAucToken).filter((v) => v != null);
      if (!vals.length) continue;

      const header = window[headerIdx];
      const nsclcPos = header.search(/TCGA[-\s]?NSCLC|TCGA[-\s]?LUNG|TCGA Lung/i);
      const camPos = header.search(/CAMELYON|Camelyon/i);
      if (/TCGA-LUNG/i.test(header) || /TCGA-LUNG/i.test(window.slice(0, headerIdx + 1).join("\n"))) {
        // WiKG table: last dataset block → AUC is 2nd of last triple → among all numbers, pick carefully
        // Accuracy AUC F1 × 3 → indices 0,1,2, 3,4,5, 6,7,8 → LUNG AUC = index 7
        if (vals.length >= 8) auroc = vals[7];
        else if (vals.length >= 2) auroc = vals[vals.length - 2];
      } else if (nsclcPos >= 0 && camPos >= 0 && nsclcPos > camPos) {
        // NSCLC is the second dataset block.
        // Acc AUC F1 × 2 → NSCLC AUC at index 4 (NOT 3 — 3 is NSCLC Acc).
        // Acc AUC × 2 → NSCLC AUC at index 3.
        if (/F1/i.test(header) && vals.length >= 5) auroc = vals[4];
        else if (vals.length >= 4) auroc = vals[3];
        else if (vals.length >= 2) auroc = vals[1];
      } else if (/TCGA[-\s]?NSCLC|TCGA Lung Cancer/i.test(header) && !/CAMELYON/i.test(header)) {
        // Single-dataset NSCLC table: Acc AUC F1 → AUC index 1; Acc F1 AUC → index 2
        if (/Acc(?:uracy)?\s+AUC\s+F1|Accuracy\s+AUC\s+F1/i.test(header) && vals.length >= 2) {
          auroc = vals[1];
        } else if (/F1/i.test(header) && /AUC/i.test(header) && vals.length >= 3) {
          auroc = vals[2];
        } else if (vals.length >= 2) auroc = vals[1];
        else auroc = vals[0];
      } else if (datasetRe.test(line)) {
        // Fallback: prefer AUC over Acc when Camelyon+NSCLC Acc/AUC/F1 rows are present
        if (/F1/i.test(header) && vals.length >= 5 && /CAMELYON/i.test(header)) auroc = vals[4];
        else if (vals.length >= 4 && /CAMELYON/i.test(header)) auroc = vals[3];
        else auroc = vals.length >= 2 ? vals[Math.min(3, vals.length - 1)] : vals[0];
      }

      if (auroc == null) continue;
      hits.push({ model, auroc, line: cleaned.trim(), datasetLabel: "TCGA-NSCLC" });
    }
  }

  // Dedup by model keeping first
  const byModel = new Map();
  for (const h of hits) {
    const key = h.model.toUpperCase();
    if (!byModel.has(key)) byModel.set(key, h);
  }
  return [...byModel.values()];
}

function formatAuroc(v) {
  // Keep 4 decimals if present-ish
  return (Math.round(v * 10000) / 10000).toString();
}

function findQuote(pages, model, auroc, fallbackLine) {
  const target = formatAuroc(auroc);
  const pct = (auroc * 100).toFixed(2).replace(/\.?0+$/, "");
  const candidates = [];
  if (fallbackLine && fallbackLine.length > 10) candidates.push(fallbackLine.slice(0, 240));
  for (const p of pages) {
    const idx = p.text.toLowerCase().indexOf(model.toLowerCase());
    if (idx < 0) continue;
    const snippet = p.text.slice(Math.max(0, idx - 20), Math.min(p.text.length, idx + 220));
    if (snippet.includes(target) || snippet.includes(pct) || snippet.includes((auroc * 100).toFixed(1))) {
      candidates.unshift(snippet.replace(/\s+/g, " ").trim());
    }
  }
  for (const q of candidates) {
    const hits = locateQuoteInPages(pages, q);
    if (hits.length) return { quote: hits[0].quote, quotes: [hits[0].quote] };
  }
  // Try shorter: model name + auroc string nearby from fallback line
  if (fallbackLine) {
    const compact = fallbackLine.replace(/\s+/g, " ").trim().slice(0, 180);
    const hits = locateQuoteInPages(pages, compact);
    if (hits.length) return { quote: hits[0].quote, quotes: [hits[0].quote] };
  }
  return { quote: "", quotes: [] };
}

const papers = await listAllRecords();
const targets = papers.filter(
  (p) => p.collections?.includes("WSIP_Paper") && p.tags?.includes("wsip-meta") && p.attachment,
);

console.log(`Papers with PDF in WSIP_Paper/wsip-meta: ${targets.length}`);

const summary = [];

for (const paper of targets) {
  const pdf = attachmentPath(paper.citekey);
  if (!fs.existsSync(pdf)) {
    console.log(`SKIP ${paper.citekey}: missing file`);
    continue;
  }
  const cap = await pdfTextCapability(paper.citekey);
  if (!cap.ok) {
    console.log(`SKIP ${paper.citekey}: ${cap.reason}`);
    continue;
  }

  const raw = pdftotext(pdf);
  const rows = extractFromText(raw);
  console.log(`\n${paper.citekey}: parsed ${rows.length} model AUROCs`);
  for (const r of rows) console.log(`  ${r.model} -> ${formatAuroc(r.auroc)}`);

  if (!rows.length) {
    summary.push({ citekey: paper.citekey, created: 0, parsed: 0 });
    continue;
  }

  const cache = await getPdfTextForPaper(paper.citekey);
  const existing = await listFacts(paper.citekey);
  let created = 0;

  for (const row of rows) {
    const input = `AUROC of ${row.model} on TCGA-NSCLC (LUAD vs LUSC, slide-level)`;
    // Skip if an equivalent unreviewed/confirmed value fact already exists
    const dup = existing.some(
      (f) =>
        f.type === "value" &&
        f.input.toLowerCase().includes(row.model.toLowerCase()) &&
        f.input.toLowerCase().includes("auroc") &&
        f.input.toLowerCase().includes("nsclc"),
    );
    if (dup) {
      console.log(`  skip dup ${row.model}`);
      continue;
    }

    const { quotes } = findQuote(cache.pages, row.model, row.auroc, row.line);
    const answer = formatAuroc(row.auroc);

    try {
      const fact = await createFact(
        paper.citekey,
        { type: "value", input },
        {
          retrieve: async () => ({
            answer,
            quotes: quotes.length ? quotes : row.line ? [row.line.slice(0, 240)] : [],
          }),
        },
      );
      console.log(
        `  FACT ${fact.id} ${row.model}=${answer} status=${fact.status} highlights=${fact.highlights.length}`,
      );
      created += 1;
    } catch (err) {
      console.log(`  FAIL ${row.model}: ${err instanceof Error ? err.message : err}`);
    }
  }
  summary.push({ citekey: paper.citekey, created, parsed: rows.length });
}

console.log("\n=== SUMMARY ===");
let t = 0;
for (const s of summary) {
  console.log(`${s.citekey}: created ${s.created}/${s.parsed}`);
  t += s.created;
}
console.log(`Total facts created: ${t}`);
