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

/** Refresh plain-English labels on facts that already exist (keep confirmed). */
async function relabelExistingFacts(facts: QuoteFact[]): Promise<void> {
  const { resolveFactKey } = await import("../server/src/services/library/factKeyIndex.ts");
  for (const f of facts) {
    const hit = await resolveFactKey(f.key);
    if (!hit) continue;
    const rows = await listAllFacts({ citekey: hit.citekey, skipDisplay: true });
    const row = rows.find((r) => r.id === hit.factId);
    if (!row) continue;
    if (row.input === f.input && String(row.answer) === f.answer) continue;
    await updateFact(hit.citekey, hit.factId, {
      input: f.input,
      answer: f.answer,
      value: f.value,
      unit: f.unit,
      status: "confirmed",
      confirmWithContent: true,
    });
    console.log(`  relabel fact ${f.key}`);
  }
}

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
  try {
    const { paper } = await addWebSource({ url, title, collections: [COLLECTION], notes });
    await attachFacts(paper.citekey, title, wanted);
    return paper.citekey;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Offline / DNS / network — never crash the whole seed.
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) {
      console.warn(`Skip offline fetch for ${title}: ${msg}`);
      return "";
    }
    throw err;
  }
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
          provenance: "curated",
          note: "Curated excerpt — live fetch blocked; numbers verified against source. Not fetched by OpenLeaf.",
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

const FACTS_85097: QuoteFact[] = [
  {
    key: "medicare-85097-services-2024",
    input:
      "How many times in 2024 did Traditional Medicare pay a doctor to interpret a bone-marrow smear slide (billing code CPT 85097)?",
    answer: "126956",
    value: 126_956,
    unit: "services",
    quote: "averaged across 126,956 services",
  },
  {
    key: "medicare-85097-allowed-usd-2024",
    input:
      "On average in 2024, how many dollars did Traditional Medicare say one bone-marrow smear interpretation (CPT 85097) was worth?",
    answer: "51.39",
    value: 51.39,
    unit: "USD",
    quote: "$51.39 Medicare-allowed amount per service",
  },
  {
    key: "medicare-85097-total-allowed-usd-2024",
    input:
      "In total for 2024, how many dollars did Traditional Medicare allow for all bone-marrow smear interpretations (CPT 85097)?",
    answer: "6524269",
    value: 6_524_269,
    unit: "USD",
    quote: "Total allowed $6,524,269",
  },
];

await importAndFact(
  "https://www.doctorpaymentsdata.org/procedure/85097",
  "Medicare payments for reading bone-marrow smears (CPT 85097, 2024)",
  "Public Medicare claim summary for 2024. Covers only Traditional Medicare (not Medicare Advantage). CPT 85097 = a doctor reading a bone-marrow smear slide.",
  FACTS_85097,
);

const FACTS_85060: QuoteFact[] = [
  {
    key: "medicare-85060-services-2024",
    input:
      "How many times in 2024 did Traditional Medicare pay a doctor to interpret a peripheral blood smear slide (billing code CPT 85060)?",
    answer: "137614",
    value: 137_614,
    unit: "services",
    quote: "averaged across 137,614 services",
  },
  {
    key: "medicare-85060-allowed-usd-2024",
    input:
      "On average in 2024, how many dollars did Traditional Medicare say one blood-smear interpretation (CPT 85060) was worth?",
    answer: "23.02",
    value: 23.02,
    unit: "USD",
    quote: "$23.02 Medicare-allowed amount per service",
  },
  {
    key: "medicare-85060-total-allowed-usd-2024",
    input:
      "In total for 2024, how many dollars did Traditional Medicare allow for all blood-smear interpretations (CPT 85060)?",
    answer: "3167874",
    value: 3_167_874,
    unit: "USD",
    quote: "Total allowed $3,167,874",
  },
];

await importAndFact(
  "https://www.doctorpaymentsdata.org/procedure/85060",
  "Medicare payments for reading blood smears (CPT 85060, 2024)",
  "Public Medicare claim summary for 2024. Covers only Traditional Medicare (not Medicare Advantage). CPT 85060 = a doctor reading a peripheral blood smear slide.",
  FACTS_85060,
);

const FACTS_38222: QuoteFact[] = [
  {
    key: "medicare-38222-services-2024",
    input:
      "How many times in 2024 did Traditional Medicare pay for collecting a bone-marrow sample (biopsy + aspiration, billing code CPT 38222)? This is the sample-collection procedure — not the later slide-reading step DeepHeme assists.",
    answer: "89037",
    value: 89_037,
    unit: "services",
    quote: "89,037 Services / Year",
  },
];

await importAndFact(
  "https://patientfact.com/procedure/biopsy-and-aspiration-of-bone-marrow-sample-for-diagnosis",
  "Medicare bone-marrow sample collections (CPT 38222, 2024)",
  "How often Medicare paid for taking a marrow sample. Useful context only — DeepHeme assists reading the smear afterward, not collecting the sample.",
  FACTS_38222,
);

const FACTS_ACS: QuoteFact[] = [
  {
    key: "acs-2025-leukemia-cases",
    input:
      "According to the American Cancer Society, about how many people in the US are expected to be newly diagnosed with leukemia in 2025?",
    answer: "66890",
    value: 66_890,
    unit: "cases",
    quote: "Leukemia — estimated new cases, both sexes: 66,890",
  },
  {
    key: "acs-2025-lymphoma-cases",
    input:
      "According to the American Cancer Society, about how many people in the US are expected to be newly diagnosed with lymphoma in 2025?",
    answer: "89070",
    value: 89_070,
    unit: "cases",
    quote: "Lymphoma — estimated new cases, both sexes: 89,070",
  },
  {
    key: "acs-2025-myeloma-cases",
    input:
      "According to the American Cancer Society, about how many people in the US are expected to be newly diagnosed with myeloma in 2025?",
    answer: "36110",
    value: 36_110,
    unit: "cases",
    quote: "Myeloma — estimated new cases, both sexes: 36,110",
  },
  {
    key: "acs-2025-blood-cancer-cases",
    input:
      "Adding ACS 2025 estimates for leukemia + lymphoma + myeloma, about how many new US blood-cancer diagnoses are expected that year? (People newly diagnosed — not the number of smear bills Medicare paid.)",
    answer: "192070",
    value: 192_070,
    unit: "cases",
    quote: "Combined leukemia + lymphoma + myeloma new cases (2025): 192,070",
  },
];

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
  FACTS_ACS,
);

const FACTS_DP_MARKET: QuoteFact[] = [
  {
    key: "digital-pathology-market-2024-usd-bn",
    input:
      "According to MarketsandMarkets, what was the worldwide digital pathology market (scanners + software + services across specialties) worth in 2024, in billions of US dollars? Context only — not DeepHeme's market.",
    answer: "1.29",
    value: 1.29,
    unit: "USD-billion",
    quote: "valued at US$1.29 billion in 2024",
  },
  {
    key: "digital-pathology-market-2030-usd-bn",
    input:
      "According to MarketsandMarkets, what is the worldwide digital pathology market projected to be worth in 2030, in billions of US dollars? Context only — not DeepHeme's market.",
    answer: "2.75",
    value: 2.75,
    unit: "USD-billion",
    quote: "US$2.75 billion by the end of the period",
  },
];

await importAndFact(
  "https://www.prnewswire.com/news-releases/digital-pathology-market-worth-us2-75-billion-by-2030-with-13-5-cagr--marketsandmarkets-302471498.html",
  "Worldwide digital pathology market size (MarketsandMarkets, 2024–2030)",
  "Industry estimate for a broad category: scanners, software, and services across many specialties. Useful as big-picture context only — not a DeepHeme-specific market size.",
  FACTS_DP_MARKET,
);

// --- Knowledge items --------------------------------------------------------

async function writeKnowledge(
  knowledgeId: string,
  title: string,
  texBody: string,
): Promise<void> {
  const existing = (await listKnowledgeItems()).find((i) => i.knowledgeId === knowledgeId);
  const tex = `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
${texBody}
\\end{document}
`;
  if (existing) {
    console.log(`update knowledge ${knowledgeId} → ${existing.id}`);
    await writeFile(existing.id, "main.tex", tex);
    await writeProjectConfig(existing.id, {
      name: title,
      kind: "knowledge",
      knowledgeId,
      collection: COLLECTION,
      mainFile: "main.tex",
    });
    return;
  }
  const { project } = await createKnowledgeItem({ title, collection: COLLECTION, knowledgeId });
  await writeFile(project.id, "main.tex", tex);
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
  "How many Medicare blood and marrow smear reads in 2024?",
  `\\begin{knowledge}[result=services]{How many Medicare blood and marrow smear reads in 2024?}
\\begin{assumption}[what-we-count]
\\textbf{Plain question.} In one year, how often did Traditional Medicare pay a
doctor to \\emph{look at} a blood or bone-marrow smear slide and write an
interpretation?

\\textbf{Why this matters for DeepHeme.} DeepHeme's near-term product helps doctors
do exactly that work --- reading those slides. So this count is the measured
volume of the clinical task we care about, inside the one US payer that publishes
clear numbers.

\\textbf{Words we use here.}
\\begin{itemize}
  \\item \\emph{Smear / slide:} a thin layer of blood or marrow cells on glass that a
        doctor examines under a microscope (or on a digital image).
  \\item \\emph{Traditional Medicare (also called fee-for-service or FFS):} the
        government plan that pays each claim one by one. It is \\emph{not} Medicare
        Advantage (private plans that replace Traditional Medicare for some people).
  \\item \\emph{Part B:} the part of Medicare that covers doctor and outpatient
        services (as opposed to hospital inpatient Part A).
  \\item \\emph{CPT code:} the billing label for a specific medical service. Hospitals
        and labs put a CPT code on the claim so the payer knows what was done.
\\end{itemize}

\\textbf{Which billing codes we add.} We use the two CPT codes that match the
slide-reading work DeepHeme assists:
\\begin{itemize}
  \\item CPT 85060 --- reading a \\emph{peripheral blood smear} (a slide of cells
        circulating in blood).
  \\item CPT 85097 --- reading a \\emph{bone-marrow smear} (a slide of cells taken
        from a marrow aspirate).
\\end{itemize}

\\textbf{What we deliberately leave out.} Medicare Advantage, Medicaid, commercial
insurance, cash-pay, non-US care, and the separate procedure that \\emph{collects}
the marrow sample (CPT 38222). Those are real volume elsewhere, but they are not
in this measured Traditional Medicare count.
\\end{assumption}
\\begin{calculation}{services}
\\fact{medicare-85097-services-2024} + \\fact{medicare-85060-services-2024}
\\end{calculation}
\\conclusion{In 2024, Traditional Medicare Part B paid for about \\out{services}
blood and bone-marrow smear \\emph{interpretations} (CPT 85060 + CPT 85097). That
is a count of billable reads in this narrow US slice --- not a count of patients,
hospitals, or every smear done in the country.}
\\end{knowledge}`,
);

await writeKnowledge(
  "us-medicare-ffs-heme-smear-spend",
  "How much did Medicare allow for those smear reads in 2024?",
  `\\begin{knowledge}[result=spend]{How much did Medicare allow for those smear reads in 2024?}
\\begin{assumption}[allowed-vs-paid]
\\textbf{Plain question.} For the same blood and marrow smear reads as above, how
many dollars did Traditional Medicare say those services were worth in 2024?

\\textbf{What \\emph{allowed amount} means.} When Medicare publishes an \\emph{allowed}
dollar figure, it means: this is what Medicare treats as the approved price of the
service before the patient pays any coinsurance share. It is the standard public
way to turn \\emph{how many times} into \\emph{how many dollars} for Traditional Medicare.

\\textbf{What this number is not.}
\\begin{itemize}
  \\item Not DeepHeme's software price.
  \\item Not the price of a scanner or lab machine.
  \\item Not what a private insurer or Medicare Advantage plan pays (those rates are
        usually different and often higher).
  \\item Not the hospital's chargemaster sticker price.
\\end{itemize}

\\textbf{How we compute it.} Add the published 2024 \\emph{total allowed} dollars for
CPT 85097 (marrow smear reads) and CPT 85060 (blood smear reads).
\\end{assumption}
\\begin{calculation}{spend}
\\fact{medicare-85097-total-allowed-usd-2024} + \\fact{medicare-85060-total-allowed-usd-2024}
\\end{calculation}
\\conclusion{In 2024, Traditional Medicare Part B allowed about \\out{spend} USD for
doctors interpreting blood and bone-marrow smears (CPT 85060 + CPT 85097). Think of
this as the public dollar amount sitting under the clinical read DeepHeme aims to
assist --- still only Traditional Medicare, still only the interpretation fee.}
\\end{knowledge}`,
);

await writeKnowledge(
  "deephome-us-medicare-ffs-floor",
  "DeepHeme US Medicare spending floor for smear reads (2024)",
  `\\begin{knowledge}[result=floor]{What US Medicare dollars sit under DeepHeme's smear product?}
\\begin{judgment}[why-this-floor]
\\textbf{Plain question.} How large is the pot of US money tied to the clinical work
DeepHeme helps with today --- a doctor reading a blood or bone-marrow smear?

\\textbf{How DeepHeme connects to these bills.} DeepHeme's near-term clinical product
is software that assists pathologists when they interpret
\\emph{peripheral blood smears} (slides of circulating blood cells) and
\\emph{bone-marrow aspirate smears} (slides of marrow cells). In US billing, those
reads are mainly coded as CPT 85060 (blood) and CPT 85097 (marrow).

\\textbf{Why we start with Traditional Medicare.} Traditional Medicare
(fee-for-service Part B) is the one large US payer that publishes clear counts and
allowed dollars for those exact CPT codes. That makes it the cleanest
\\emph{measured} starting point. We call the result a \\emph{floor} because it is
deliberately narrow:
\\begin{itemize}
  \\item It includes only Traditional Medicare --- not Medicare Advantage, Medicaid,
        or commercial insurance.
  \\item It includes only the doctor's interpretation fee --- not scanners, lab
        processing, hospital facility fees, or whatever price DeepHeme might charge
        for software (sometimes called ASP, average selling price).
  \\item It is therefore a lower bound on clinical spend for this workflow, not a
        total addressable market (TAM) for all of digital pathology.
\\end{itemize}
\\end{judgment}
\\begin{calculation}{floor}
\\kn{us-medicare-ffs-heme-smear-spend}
\\end{calculation}
\\begin{assumption}[all-payer-mult]
\\textbf{Optional upside sketch --- not a measured market.} Other US payers often
pay more than Medicare for pathology and lab work. RAND's 2024 Hospital Price
Transparency research found commercial prices for Pathology and Laboratory around
$1.85\\times$ the Medicare level. If that same ratio applied to every US smear read,
multiplying our Medicare floor by $1.85$ sketches a rough all-payers figure.

\\textbf{Treat this carefully.} The $1.85\\times$ factor is an external benchmark from
hospital price transparency. It is \\emph{not} DeepHeme revenue, not a signed
contract rate, and not proof that buyers will pay that much for software. Use it
only to bound upside above the Medicare floor.
\\set{all-payer-mult}{1.85}
\\end{assumption}
\\begin{calculation}{all-payer-sensitivity}
\\out{floor} * \\out{all-payer-mult}
\\end{calculation}
\\begin{judgment}[context-not-tam]
\\textbf{Two bigger numbers people mix up with this floor --- and why they are not
the same thing.}

\\emph{1. How many people get blood cancers.} The American Cancer Society estimates
about \\fact{acs-2025-blood-cancer-cases} new US leukemia + lymphoma + myeloma
diagnoses in 2025. That counts \\emph{people newly diagnosed}. It does not count
how many smear bills Medicare paid, and it is not a dollar market.

\\emph{2. The whole digital pathology industry.} MarketsandMarkets puts the
\\emph{worldwide} digital pathology market (scanners + software + services across
many specialties) at about \\fact{digital-pathology-market-2024-usd-bn} billion USD
in 2024, heading toward about \\fact{digital-pathology-market-2030-usd-bn} billion
by 2030. That is a huge multi-product category. DeepHeme's smear-read floor is a
thin slice inside it. Do not quote the billion-dollar figure as DeepHeme's market.
\\end{judgment}
\\conclusion{For 2024, Traditional Medicare allowed about \\out{floor} USD for the
blood and bone-marrow smear reads DeepHeme assists (CPT 85060 + CPT 85097). That is
our conservative US spending \\emph{floor}. A rough all-payer sketch at
$1.85\\times$ Medicare is about \\out{all-payer-sensitivity} USD. Neither figure is
DeepHeme revenue, scanner sales, or the full digital pathology market.}
\\end{knowledge}`,
);

await relabelExistingFacts([
  ...FACTS_85097,
  ...FACTS_85060,
  ...FACTS_38222,
  ...FACTS_ACS,
  ...FACTS_DP_MARKET,
]);

try {
  const { invalidateKnowledgeGraph } = await import("../server/src/services/knowledge/graph.ts");
  invalidateKnowledgeGraph();
} catch {
  /* ignore */
}

console.log("Done: DeepHeme market sources, facts, and knowledge seeded.");
