// Summarises results/docs.jsonl into the tables in RESULTS.md.
//
//   node baselines/analyze.mjs [--scorer k3|ds] [--json results/summary.json]
import fs from "node:fs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
const scorer = args.scorer || "k3";
const here = new URL(".", import.meta.url);
const docs = fs.readFileSync(new URL("results/docs.jsonl", here), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const excluded = new Set(fs.existsSync(new URL("results/excluded.json", here))
  ? JSON.parse(fs.readFileSync(new URL("results/excluded.json", here), "utf8")).map((e) => `${e.group}/${e.id}`) : []);
const all = docs.filter((d) => d.scores[scorer] && !excluded.has(`${d.group}/${d.id}`));
const val = (d) => d.scores[scorer].bits;

// Deterministic generator so bootstrap intervals are reproducible.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
function stats(xs) {
  const rand = rng(xs.length * 7919 + 17);
  const meds = [];
  for (let b = 0; b < 2000 && xs.length > 1; b++) meds.push(quantile(xs.map(() => xs[Math.floor(rand() * xs.length)]), 0.5));
  return { n: xs.length, median: quantile(xs, 0.5), p25: quantile(xs, 0.25), p75: quantile(xs, 0.75), min: Math.min(...xs), max: Math.max(...xs),
    lo: meds.length ? quantile(meds, 0.025) : NaN, hi: meds.length ? quantile(meds, 0.975) : NaN };
}
// Probability that a random member of `a` scores below a random member of `b`.
function auc(a, b) {
  let wins = 0;
  for (const x of a) for (const y of b) wins += x < y ? 1 : x === y ? 0.5 : 0;
  return wins / (a.length * b.length);
}
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const summary = {};
function table(title, rows, note) {
  console.log(`\n### ${title}\n`);
  console.log("| Group | n | Median | Middle half | 95% interval for the median | Range |");
  console.log("|---|---|---|---|---|---|");
  for (const [label, ds] of rows) {
    if (!ds.length) continue;
    const s = stats(ds.map(val));
    summary[`${title} / ${label}`] = s;
    console.log(`| ${label} | ${s.n} | ${f(s.median)} | ${f(s.p25)} to ${f(s.p75)} | ${s.n >= 5 ? `${f(s.lo)} to ${f(s.hi)}` : "-"} | ${f(s.min)} to ${f(s.max)} |`);
  }
  if (note) console.log(`\n${note}`);
}
const by = (ds, key) => {
  const m = new Map();
  for (const d of ds) { const k = typeof key === "function" ? key(d) : d[key]; if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
  return [...m.entries()].sort((a, b) => quantile(a[1].map(val), 0.5) - quantile(b[1].map(val), 0.5));
};
const is = (cond) => all.filter(cond);
const human = (d) => d.origin === "human";
const ESSAY_GROUPS = new Set(["blogs-tech", "blogs-biz", "blogs-acad", "lw-ea"]);
const essayish = (d) => ESSAY_GROUPS.has(d.group) && d.kind === "essay" && human(d);
const autoCaptions = (d) => d.source_format === "captions-auto";

console.log(`Scorer: ${scorer}. ${all.length} documents scored, ${excluded.size} excluded.`);

const humanPostEssays = is((d) => essayish(d) && d.period === "post");
const genEssays = is((d) => d.group === "gen-essay");
table("Essays: people and models, all unseen by the scorer", [
  ["People, published since August 2026", humanPostEssays],
  ["Models, minimal prompt", genEssays.filter((d) => d.style === "bare")],
  ["Models, prompt matched to a human essay's title", genEssays.filter((d) => d.style === "matched")],
  ["Models, prompt asking for a distinctive voice", genEssays.filter((d) => d.style === "styled")],
]);
if (humanPostEssays.length && genEssays.length) {
  for (const style of ["bare", "matched", "styled"]) {
    const g = genEssays.filter((d) => d.style === style);
    if (g.length) console.log(`\nChance a ${style}-prompt model essay scores below a human essay: ${f(auc(g.map(val), humanPostEssays.map(val)))}`);
  }
}
table("Model essays by generating model (minimal and matched prompts)", by(genEssays.filter((d) => d.style !== "styled"), "model"));
table("Model essays by generating model (distinctive-voice prompt)", by(genEssays.filter((d) => d.style === "styled"), "model"));
table("Human essays by author, published since August 2026", by(humanPostEssays, "author"));

table("Training exposure: named essayists", [
  ["Post (unseen)", is((d) => essayish(d) && d.period === "post")],
  ["Pre, obscure piece", is((d) => essayish(d) && d.period === "pre" && d.popularity === "low")],
  ["Pre, ordinary piece", is((d) => essayish(d) && d.period === "pre" && d.popularity === "mid")],
  ["Pre, best-known piece", is((d) => essayish(d) && d.period === "pre" && d.popularity === "high")],
]);
for (const [g, label] of [["indist", "Writers wholly inside the training data"], ["fame", "Authors of varying fame"]]) {
  table(`${label}, by how well known the piece is`, ["low", "mid", "high"].map((p) => [`${p}`, is((d) => d.group === g && d.popularity === p && d.period === "pre")]));
  table(`${label}, by author`, by(is((d) => d.group === g && d.period === "pre"), "author"));
}

table("Human writing by kind, unseen by the scorer", by(is((d) => human(d) && d.period === "post" && !autoCaptions(d)), "kind"));
table("Human writing by kind, before July 2025", by(is((d) => human(d) && d.period === "pre" && !autoCaptions(d)), "kind"));
table("News and magazines", by(is((d) => d.group === "news-mags"), (d) => `${d.kind}, ${d.period}${d.period === "pre" ? `, ${d.popularity}` : ""}`));
table("Transcripts", by(is((d) => d.group === "transcripts"), (d) => `${d.source_format}, ${d.period}`));
table("Papers", by(is((d) => d.group === "papers" || d.group === "gen-paper"), (d) => d.origin === "llm" ? "model-written introduction" : `${d.distinctive ? "distinctive writer" : "ordinary"}, ${d.period}${d.period === "pre" ? `, ${d.popularity}` : ""}`));

for (const kind of ["poem", "song", "fiction", "play"]) {
  table(`${kind}: people and models`, by(is((d) => d.kind === kind && ["verse-human", "fiction-plays", "fame", "lw-ea"].includes(d.group) && human(d)), (d) => `people, ${d.period}${d.period === "pre" ? `, ${d.popularity}` : ""}`)
    .concat(by(is((d) => d.group === `gen-${kind}`), (d) => `models, ${d.style} prompt`))
    .concat([["prized AI writing", is((d) => d.group === "prized-ai" && d.kind === kind)]]));
  table(`${kind}: by generating model`, by(is((d) => d.group === `gen-${kind}`), (d) => `${d.model}, ${d.style}`));
}
table("Prized AI writing", by(is((d) => d.group === "prized-ai"), (d) => `${d.kind}, ${d.period}`));
table("Code", by(is((d) => d.kind === "code"), (d) => d.origin === "llm" ? "models" : `people, ${d.period}${d.period === "pre" ? `, ${d.popularity}` : ""}`));
table("Code by generating model", by(is((d) => d.group === "gen-code"), "model"));
table("Code by language", by(is((d) => d.kind === "code"), (d) => `${d.language} (${d.origin === "llm" ? "models" : "people"})`));

if (args.json) fs.writeFileSync(new URL(args.json, here), JSON.stringify(summary, null, 1));
