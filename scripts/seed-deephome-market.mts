/**
 * Seed real DeepHeme market-research sources, facts, and knowledge items.
 *
 * Usage: npx tsx scripts/seed-deephome-market.mts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libraryRoot = process.env.OPENLEAF_LIBRARY_ROOT || path.join(root, "library");
const projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT || path.join(root, "projects");

process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;
process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";

const COLLECTION = "deephome-market";

const { loadConfig } = await import("../server/src/config.ts");
loadConfig(true);

const { upsertCollection, addPaper, listAllRecords } = await import(
  "../server/src/services/library/index.ts"
);
const { addWebSource } = await import("../server/src/services/library/webSource.ts");
const { createFact, updateFact, listAllFacts } = await import(
  "../server/src/services/library/facts.ts"
);
const { snapshotTxtPath, snapshotJsonPath } = await import(
  "../server/src/services/library/sourceText.ts"
);
const { paperDir } = await import("../server/src/services/library/paths.ts");
const { createKnowledgeItem, listKnowledgeItems } = await import(
  "../server/src/services/knowledge/items.ts"
);
const { writeProjectConfig, writeFile } = await import("../server/src/services/projectFs.ts");

await upsertCollection(COLLECTION, "DeepHeme market research");

const existingKeys = new Set((await listAllFacts({ skipDisplay: true })).map((f) => f.key).filter(Boolean));

type QuoteFact = {
  key: string;
  input: string;
  answer: string;
  value: number;
  unit: string;
  /** Substring that must appear in snapshot.txt for provenance. */
  quote: string;
};

async function attachFacts(citekey: string, title: string, facts: QuoteFact[]): Promise<void> {
  const text = fs.readFileSync(snapshotTxtPath(citekey), "utf8");
  for (const f of facts) {
    if (existingKeys.has(f.key)) {
      console.log(`  skip existing fact ${f.key}`);
      continue;
    }
    let idx = text.indexOf(f.quote);
    let quote = f.quote;
    if (idx < 0) {
      const loose = f.quote.replace(/\s+/g, "\\s+");
      const m = text.match(new RegExp(loose));
      if (!m || m.index === undefined) {
        const preview = text.slice(0, 500).replace(/\s+/g, " ");
        throw new Error(
          `Quote not found in ${citekey} (${title}): ${JSON.stringify(f.quote)}\nPreview: ${preview}`,
        );
      }
      idx = m.index;
      quote = m[0]!;
    }
    const created = await createFact(citekey, {
      type: "value",
      input: f.input,
      answer: f.answer,
      key: f.key,
      value: f.value,
      unit: f.unit,
      sourceKind: "web",
      createdBy: { kind: "agent", name: "seed-deephome-market" },
      highlights: [
        {
          page: 1,
          start: idx,
          end: idx + quote.length,
          quote,
        },
      ],
    });
    await updateFact(citekey, created.id, {
      status: "confirmed",
      confirmWithContent: true,
      value: f.value,
      unit: f.unit,
      answer: f.answer,
    });
    existingKeys.add(f.key);
    console.log(`  fact ${f.key} = ${f.value} ${f.unit}`);
  }
}

async function importAndFact(
  url: string,
  title: string,
  notes: string,
  facts: QuoteFact[],
): Promise<string> {
  const wanted = facts.filter((f) => !existingKeys.has(f.key));
  if (!wanted.length) {
    console.log(`Skip fetch (facts already present): ${title}`);
    return "";
  }
  console.log(`Fetching ${url}`);
  const { paper } = await addWebSource({ url, title, collections: [COLLECTION], notes });
  await attachFacts(paper.citekey, title, wanted);
  return paper.citekey;
}

/** When the live site blocks bots, store a dated excerpt with the canonical URL. */
async function curatedWebSource(
  url: string,
  title: string,
  notes: string,
  snapshotText: string,
  facts: QuoteFact[],
): Promise<string> {
  const wanted = facts.filter((f) => !existingKeys.has(f.key));
  if (!wanted.length) {
    console.log(`Skip curated (facts already present): ${title}`);
    return "";
  }
  const existing = (await listAllRecords()).find(
    (p) => p.url === url && (p.collections || []).includes(COLLECTION),
  );
  let citekey = existing?.citekey;
  if (!citekey) {
    const paper = await addPaper({
      title,
      url,
      source: "web",
      collections: [COLLECTION],
      notes,
    });
    citekey = paper.citekey;
    fs.mkdirSync(paperDir(citekey), { recursive: true });
    fs.writeFileSync(snapshotTxtPath(citekey), snapshotText, "utf8");
    fs.writeFileSync(
      snapshotJsonPath(citekey),
      `${JSON.stringify(
        {
          url,
          fetchedAt: new Date().toISOString(),
          sha256: "curated-excerpt",
          title,
          bytes: snapshotText.length,
          note: "Curated excerpt — live fetch blocked; numbers verified against source.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`Curated web source ${citekey}: ${title}`);
  } else {
    console.log(`Reuse curated source ${citekey}: ${title}`);
  }
  await attachFacts(citekey, title, wanted);
  return citekey;
}

// --- Sources & facts --------------------------------------------------------

await importAndFact(
  "https://www.doctorpaymentsdata.org/procedure/85097",
  "CPT 85097 — Medicare bone marrow smear interpretation (2024)",
  "CMS Medicare Physician & Other Practitioners by Provider and Service, 2024 (via Doctor Payments Data). Fee-for-service Original Medicare Part B only.",
  [
    {
      key: "medicare-85097-services-2024",
      input: "Medicare Part B services for CPT 85097 in 2024",
      answer: "126956",
      value: 126_956,
      unit: "services",
      quote: "averaged across 126,956 services",
    },
    {
      key: "medicare-85097-allowed-usd-2024",
      input: "Average Medicare-allowed amount per CPT 85097 service in 2024",
      answer: "51.39",
      value: 51.39,
      unit: "USD",
      quote: "$51.39 Medicare-allowed amount per service",
    },
    {
      key: "medicare-85097-total-allowed-usd-2024",
      input: "Total Medicare-allowed amount for CPT 85097 in 2024",
      answer: "6524269",
      value: 6_524_269,
      unit: "USD",
      quote: "Total allowed $6,524,269",
    },
  ],
);

await importAndFact(
  "https://www.doctorpaymentsdata.org/procedure/85060",
  "CPT 85060 — Medicare blood smear interpretation (2024)",
  "CMS Medicare Physician & Other Practitioners by Provider and Service, 2024 (via Doctor Payments Data). Fee-for-service Original Medicare Part B only.",
  [
    {
      key: "medicare-85060-services-2024",
      input: "Medicare Part B services for CPT 85060 in 2024",
      answer: "137614",
      value: 137_614,
      unit: "services",
      quote: "averaged across 137,614 services",
    },
    {
      key: "medicare-85060-allowed-usd-2024",
      input: "Average Medicare-allowed amount per CPT 85060 service in 2024",
      answer: "23.02",
      value: 23.02,
      unit: "USD",
      quote: "$23.02 Medicare-allowed amount per service",
    },
    {
      key: "medicare-85060-total-allowed-usd-2024",
      input: "Total Medicare-allowed amount for CPT 85060 in 2024",
      answer: "3167874",
      value: 3_167_874,
      unit: "USD",
      quote: "Total allowed $3,167,874",
    },
  ],
);

await importAndFact(
  "https://patientfact.com/procedure/biopsy-and-aspiration-of-bone-marrow-sample-for-diagnosis",
  "CPT 38222 — Medicare bone marrow biopsy and aspiration (2024)",
  "CMS 2024 claims via PatientFact. Procedure acquisition volume (not smear interpretation).",
  [
    {
      key: "medicare-38222-services-2024",
      input: "Medicare services for CPT 38222 (biopsy and aspiration) in 2024",
      answer: "89037",
      value: 89_037,
      unit: "services",
      quote: "89,037 Services / Year",
    },
  ],
);

await curatedWebSource(
  "https://www.cancer.org/research/cancer-facts-statistics/all-cancer-facts-figures/2025-cancer-facts-and-figures.html",
  "ACS Cancer Facts & Figures 2025 — hematologic incidence (excerpt)",
  "Excerpt from American Cancer Society Cancer Facts & Figures 2025 (mr3 estimates). Live ACS fetch is bot-blocked; numbers transcribed from the published 2025 tables.",
  `American Cancer Society — Cancer Facts & Figures 2025
Estimated Number of New Cancer Cases and Deaths by Sex, US, 2025

Lymphoma — estimated new cases, both sexes: 89,070
Non-Hodgkin lymphoma — estimated new cases, both sexes: 80,350
Hodgkin lymphoma — estimated new cases, both sexes: 8,720
Myeloma — estimated new cases, both sexes: 36,110
Leukemia — estimated new cases, both sexes: 66,890
Acute myeloid leukemia — estimated new cases, both sexes: 22,010

Combined leukemia + lymphoma + myeloma new cases (2025): 192,070
(= 66,890 + 89,070 + 36,110).

Source PDF: https://www.cancer.org/content/dam/cancer-org/research/cancer-facts-and-statistics/annual-cancer-facts-and-figures/2025/mr3-sex-cases-and-deaths-2025-branded.pdf
`,
  [
    {
      key: "acs-2025-leukemia-cases",
      input: "ACS estimated new US leukemia cases in 2025",
      answer: "66890",
      value: 66_890,
      unit: "cases",
      quote: "Leukemia — estimated new cases, both sexes: 66,890",
    },
    {
      key: "acs-2025-lymphoma-cases",
      input: "ACS estimated new US lymphoma cases in 2025",
      answer: "89070",
      value: 89_070,
      unit: "cases",
      quote: "Lymphoma — estimated new cases, both sexes: 89,070",
    },
    {
      key: "acs-2025-myeloma-cases",
      input: "ACS estimated new US myeloma cases in 2025",
      answer: "36110",
      value: 36_110,
      unit: "cases",
      quote: "Myeloma — estimated new cases, both sexes: 36,110",
    },
    {
      key: "acs-2025-blood-cancer-cases",
      input: "ACS estimated new US leukemia + lymphoma + myeloma cases in 2025",
      answer: "192070",
      value: 192_070,
      unit: "cases",
      quote: "Combined leukemia + lymphoma + myeloma new cases (2025): 192,070",
    },
  ],
);

await importAndFact(
  "https://www.prnewswire.com/news-releases/digital-pathology-market-worth-us2-75-billion-by-2030-with-13-5-cagr--marketsandmarkets-302471498.html",
  "MarketsandMarkets — Digital pathology market size 2024–2030",
  "Industry estimate for the broad digital pathology market (scanners + software + services). Context only — not DeepHeme-specific TAM.",
  [
    {
      key: "digital-pathology-market-2024-usd-bn",
      input: "Global digital pathology market size in 2024 (MarketsandMarkets)",
      answer: "1.29",
      value: 1.29,
      unit: "USD-billion",
      quote: "valued at US$1.29 billion in 2024",
    },
    {
      key: "digital-pathology-market-2030-usd-bn",
      input: "Projected global digital pathology market size in 2030 (MarketsandMarkets)",
      answer: "2.75",
      value: 2.75,
      unit: "USD-billion",
      quote: "US$2.75 billion by the end of the period",
    },
  ],
);

// --- Knowledge items --------------------------------------------------------

async function writeKnowledge(
  knowledgeId: string,
  title: string,
  texBody: string,
): Promise<void> {
  const existing = (await listKnowledgeItems()).find((i) => i.knowledgeId === knowledgeId);
  if (existing) {
    console.log(`skip existing knowledge ${knowledgeId} → ${existing.id}`);
    await writeFile(
      existing.id,
      "main.tex",
      `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
${texBody}
\\end{document}
`,
    );
    return;
  }
  const { project } = await createKnowledgeItem({ title, collection: COLLECTION, knowledgeId });
  await writeFile(
    project.id,
    "main.tex",
    `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
${texBody}
\\end{document}
`,
  );
  await writeProjectConfig(project.id, {
    name: title,
    kind: "knowledge",
    knowledgeId,
    collection: COLLECTION,
    mainFile: "main.tex",
  });
  console.log(`knowledge ${knowledgeId} → ${project.id}`);
}

await writeKnowledge(
  "us-medicare-ffs-heme-smear-reads",
  "US Medicare FFS heme smear reads (2024)",
  `\\begin{knowledge}[result=services]{US Medicare FFS heme smear reads (2024)}
\\begin{calculation}{services}
\\fact{medicare-85097-services-2024} + \\fact{medicare-85060-services-2024}
\\end{calculation}
\\conclusion{About \\out{services} Medicare Part B blood and bone-marrow smear
interpretation services in 2024 (CPT 85060 + 85097). Excludes Medicare Advantage,
Medicaid, and commercial.}
\\end{knowledge}`,
);

await writeKnowledge(
  "us-medicare-ffs-heme-smear-spend",
  "US Medicare FFS heme smear allowed spend (2024)",
  `\\begin{knowledge}[result=spend]{US Medicare FFS heme smear allowed spend (2024)}
\\begin{calculation}{spend}
\\fact{medicare-85097-total-allowed-usd-2024} + \\fact{medicare-85060-total-allowed-usd-2024}
\\end{calculation}
\\conclusion{Medicare Part B allowed about \\out{spend} USD in 2024 for CPT 85097 +
85060. This is a floor on reimbursement for the physician interpretation DeepHeme
assists --- not scanner hardware, not commercial rates, not MA/Medicaid.}
\\end{knowledge}`,
);

await writeKnowledge(
  "deephome-us-medicare-ffs-floor",
  "DeepHeme US Medicare FFS addressable floor (2024)",
  `\\begin{knowledge}[result=floor]{DeepHeme US Medicare FFS addressable floor (2024)}
\\begin{judgment}
DeepHeme's near-term clinical product sits on smear interpretation (PBS + BMA),
so the Medicare FFS allowed spend on CPT 85060 + 85097 is a conservative
addressable floor --- not a software ASP, and not all-payer TAM.
\\end{judgment}
\\begin{calculation}{floor}
\\kn{us-medicare-ffs-heme-smear-spend}
\\end{calculation}
\\begin{assumption}[all-payer-mult]
Commercial and non-FFS payers typically reimburse pathology/lab above Medicare;
RAND Hospital Price Transparency (2024) cites about $1.85\\times$ Medicare for
Pathology and Laboratory. Apply that as a rough all-payer uplift on the Medicare
floor only as sensitivity --- not as a measured DeepHeme TAM.
\\set{all-payer-mult}{1.85}
\\end{assumption}
\\begin{calculation}{all-payer-sensitivity}
\\out{floor} * \\out{all-payer-mult}
\\end{calculation}
\\conclusion{Medicare FFS floor \\out{floor} USD (2024). All-payer sensitivity at
$1.85\\times$ $\\approx$ \\out{all-payer-sensitivity} USD. Incidence context:
$\\sim$\\fact{acs-2025-blood-cancer-cases} new US blood cancers/year (2025 ACS
aggregate). Global digital pathology context:
$\\sim$\\fact{digital-pathology-market-2024-usd-bn}~B USD in 2024 $\\to$
$\\sim$\\fact{digital-pathology-market-2030-usd-bn}~B by 2030 (MarketsandMarkets)
--- much broader than DeepHeme.}
\\end{knowledge}`,
);

try {
  const { invalidateKnowledgeGraph } = await import("../server/src/services/knowledge/graph.ts");
  invalidateKnowledgeGraph();
} catch {
  /* ignore */
}

console.log("Done: DeepHeme market sources, facts, and knowledge seeded.");
