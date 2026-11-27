// Builds what the page shows from the baseline study: the reference
// distributions behind the ruler (data/baselines.js) and the shelf of
// ready-made heatmaps (data/library.js plus one token file per text).
//
//   node baselines/build_site.mjs --roots <corpus>,baselines/generated --cache <corpus>/scores
//
// Run metrics.mjs first; this reads results/docs.jsonl. Every scored text goes
// on the shelf and is copied into the site, except those library.json withholds.
import fs from "node:fs";
import path from "node:path";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
const here = new URL(".", import.meta.url);
const out = args.out || new URL("../data", here).pathname;
const SCORER = { key: "k3", slug: "Kimi-K3", id: "moonshotai/Kimi-K3", chars: 3000 };

const docs = fs.readFileSync(new URL("results/docs.jsonl", here), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const scored = docs.filter((d) => d.scores[SCORER.key] && d.period !== "mid" && d.source_format !== "captions-auto");
const bits = (d) => d.scores[SCORER.key].bits;
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
// Share of pairings in which a member of `a` scores below a member of `b`.
function below(a, b) {
  let wins = 0;
  for (const x of a) for (const y of b) wins += x < y ? 1 : x === y ? 0.5 : 0;
  return wins / (a.length * b.length);
}

const MODEL_NAMES = {
  "llama-3.3-70b": "Llama 3.3 70B", "mistral-medium-3.5": "Mistral Medium 3.5", "qwen3.8": "Qwen 3.8",
  "qwen3-coder": "Qwen3 Coder", "kimi-k3": "Kimi K3", "kimi-k2.6": "Kimi K2.6", "gemma-4-31b": "Gemma 4 31B",
  "gpt-oss-120b": "gpt-oss-120b", "glm-5.3": "GLM-5.3", "deepseek-v4-pro": "DeepSeek V4 Pro",
  "claude-fable-5.2": "Claude Fable 5.2", "claude-opus-5.5": "Claude Opus 5.5", "claude-haiku-5.5": "Claude Haiku 5.5",
  "gpt-6.2-astra": "GPT-6.2 Astra", "gpt-6.2-sol": "GPT-6.2 Sol", "gemini-4-neon": "Gemini 4 Neon", "grok-4.7": "Grok 4.7",
};
const isGen = (d) => d.group.startsWith("gen-");
const isPrized = (d) => d.group === "prized-ai";
const isPerson = (d) => d.origin === "human" && !isPrized(d);
const rawPrompt = (d) => JSON.parse(fs.readFileSync(new URL(`generated/raw/${d.id}.json`, here), "utf8")).prompt;
const author = (d) => (isGen(d) ? MODEL_NAMES[d.model] || d.model : d.author);
const subject = (d) => d.prompt_id.replace(/^[a-z]+-/, "").replace(/-/g, " ");
// A generated text is titled by the opening of the prompt that produced it.
function title(d) {
  if (!isGen(d)) return d.title;
  const prompt = rawPrompt(d);
  const named = /^Subject: (.+)$/m.exec(prompt);
  const first = (named && prompt.startsWith("Write an essay of about") ? `Write ${named[1]}` : prompt.split("\n")[0])
    .replace(/ (About \d+ words\.|Output only).*$/, "").trim();
  return first.length <= 96 ? first : `${first.slice(0, first.lastIndexOf(" ", 92))}\u2026`;
}

// Each tab on the page compares like with like. Reviews, news and magazine
// features sit with essays because the generated essays are their nearest
// model-written counterpart.
const TABS = [
  { key: "essay", label: "essays", people: ["essay", "review"], coached: "Models, coached on voice",
    extra: [["People, new news reports", ["news"]], ["People, new magazine features", ["magazine"]]] },
  { key: "paper", label: "papers", people: ["paper"], coached: "Models, coached on craft" },
  { key: "fiction", label: "fiction", people: ["fiction"], coached: "Models, coached on craft" },
  { key: "poem", label: "poems", people: ["poem"], coached: "Models, coached on craft" },
  { key: "song", label: "songs", people: ["song"], coached: "Models, coached on craft" },
  { key: "play", label: "plays", people: ["play"], coached: "Models, coached on craft" },
  { key: "code", label: "code", people: ["code"], coached: "Models, coached on craft" },
];
const TAB_OF = { review: "essay", news: "essay", magazine: "essay", comment: "essay", tweet: "essay", transcript: "essay" };
const tabOf = (kind) => TAB_OF[kind] || kind;

const shelfIds = new Map();
function row(key, who, label, members) {
  if (members.length < 3) return null;
  const values = members.map(bits);
  return {
    key, who, label, n: values.length,
    median: round(quantile(values, 0.5)), p25: round(quantile(values, 0.25)), p75: round(quantile(values, 0.75)),
    docs: members.slice().sort((a, b) => bits(a) - bits(b)),
  };
}

function buildTab(tab) {
  const gen = scored.filter((d) => d.group === `gen-${tab.key}`);
  const prized = scored.filter((d) => isPrized(d) && d.kind === tab.key);
  const people = scored.filter((d) => isPerson(d) && tab.people.includes(d.kind));
  const post = people.filter((d) => d.period === "post");
  const pre = (pop) => people.filter((d) => d.period === "pre" && d.popularity === pop);
  const rows = [
    row("models-bare", "models", "Models, one-line prompt", gen.filter((d) => d.style === "bare")),
    row("models-matched", "models", "Models, given a real title and subject", gen.filter((d) => d.style === "matched")),
    row("models-coached", "models", tab.coached, gen.filter((d) => d.style === "styled" || d.style === "craft")),
    row("models-prized", "models", "Models, prized pieces", prized),
    row("people-post", "people", "People, new", post),
    ...(tab.extra || []).map(([label, kinds], i) => row(`people-extra-${i}`, "people", label,
      scored.filter((d) => isPerson(d) && kinds.includes(d.kind) && d.period === "post"))),
    row("people-pre-low", "people", "People, older, little known", pre("low")),
    row("people-pre-mid", "people", "People, older, fairly well known", pre("mid")),
    row("people-pre-high", "people", "People, older, famous", pre("high")),
  ].filter(Boolean);
  const ref = rows.find((r) => r.key === "people-post");
  if (!ref || !rows.some((r) => r.who === "models")) return null;
  for (const r of rows) if (r !== ref) r.below = round(below(r.docs.map(bits), ref.docs.map(bits)));

  // The colour scale for passages: full red is where the most predictable
  // tenth of model-written passages sit, full green where the most
  // surprising tenth of unseen human passages sit, and neutral is the value
  // that best separates the two.
  const means = (ds) => ds.flatMap((d) => d.scores[SCORER.key].passages.means);
  const m = means(gen), h = means(post);
  let mid = 0, best = 0;
  for (let t = 0; t < 10; t += 0.05) {
    const acc = (m.filter((x) => x < t).length / m.length + h.filter((x) => x >= t).length / h.length) / 2;
    if (acc > best + 1e-9) { best = acc; mid = t; }
  }
  mid = round(mid, 1);
  const scale = { lo: Math.min(round(quantile(m, 0.1), 1), round(mid - 0.5, 1)), mid, hi: Math.max(round(quantile(h, 0.9), 1), round(mid + 0.5, 1)) };
  const top = Math.max(...rows.flatMap((r) => r.docs.map(bits)));
  return { key: tab.key, label: tab.label, scale, max: Math.max(3, Math.ceil(top + 0.25)), rows };
}

const tabs = TABS.map(buildTab).filter(Boolean);

// The shelf: every scored text that belongs to a tab on the page, except the
// commercial works that library.json withholds.
const spec = JSON.parse(fs.readFileSync(new URL("library.json", here), "utf8"));
const byKey = new Map(docs.map((d) => [`${d.group}/${d.id}`, d]));
const withheld = new Map();
for (const [reason, { texts }] of Object.entries(spec.withheld)) {
  for (const key of texts) {
    if (!byKey.has(key)) throw new Error(`library.json names an unknown text: ${key}`);
    if (isGen(byKey.get(key)) || isPrized(byKey.get(key))) throw new Error(`library.json withholds a model text: ${key}`);
    withheld.set(key, reason);
  }
}
const reasonFor = (d) => withheld.get(`${d.group}/${d.id}`);
const chosen = scored.filter((d) => !reasonFor(d) && tabs.some((t) => t.key === tabOf(d.kind)));

const roots = (args.roots || "").split(",").filter(Boolean);
fs.rmSync(path.join(out, "library"), { recursive: true, force: true });
fs.mkdirSync(path.join(out, "library"), { recursive: true });
const library = [];
for (const d of chosen) {
  if (!d.scores[SCORER.key]) throw new Error(`${d.group}/${d.id} is on the shelf but has no score`);
  if (shelfIds.has(d.id)) throw new Error(`two shelf texts share the id ${d.id}`);
  const cached = JSON.parse(fs.readFileSync(path.join(args.cache, SCORER.slug, `c${SCORER.chars}`, d.group, `${d.id}.json`), "utf8"));
  const text = cached.tokens.map((t) => t[0]).join("");
  const source = roots.map((r) => path.join(r, "texts", d.group, `${d.id}.txt`)).find((p) => fs.existsSync(p));
  if (source && !fs.readFileSync(source, "utf8").startsWith(text.slice(0, 200))) throw new Error(`${d.id}: cached tokens do not match the text`);
  const file = { tokens: cached.tokens.map(([t, lp, first]) => [t, lp == null ? null : round(lp, 4), first]) };
  if (isGen(d)) file.prompt = rawPrompt(d);
  fs.writeFileSync(path.join(out, "library", `${d.id}.json`), JSON.stringify(file));
  shelfIds.set(d.id, true);
  const s = d.scores[SCORER.key];
  const entry = {
    id: d.id, tab: tabOf(d.kind), kind: d.kind, who: isPerson(d) ? "person" : "model",
    author: author(d), title: title(d), date: d.date, bits: s.bits, words: s.words,
    total_chars: cached.full_chars, chars: cached.chars, position: d.position,
  };
  if (isPerson(d)) { entry.period = d.period; entry.popularity = d.popularity; }
  if (isPrized(d)) entry.prized = true;
  if (d.url) entry.url = d.canonical_url || d.url;
  if (isGen(d)) entry.style = d.style;
  if (d.language) entry.language = d.language;
  library.push(entry);
}
library.sort((a, b) => a.bits - b.bits);

const label = (d) => `${author(d)}: ${isGen(d) ? subject(d) : d.title}`.slice(0, 90);
// A dot is [bits, label, shelf id], or [bits, label, 0, reason] when withheld.
for (const tab of tabs) {
  for (const r of tab.rows) {
    r.docs = r.docs.map((d) => {
      if (shelfIds.has(d.id)) return [bits(d), label(d), d.id];
      if (!reasonFor(d)) throw new Error(`${d.group}/${d.id} is in the chart but neither on the shelf nor withheld`);
      return [bits(d), label(d), 0, reasonFor(d)];
    });
  }
}

const baselines = {
  scorer: SCORER.id, chars: SCORER.chars, built: new Date().toISOString().slice(0, 10),
  documents: scored.length,
  withheld: Object.fromEntries(Object.entries(spec.withheld).map(([k, v]) => [k, v.why])), tabs,
};
const banner = "// Written by baselines/build_site.mjs. Do not edit by hand.\n";
fs.writeFileSync(path.join(out, "baselines.js"), `${banner}window.BASELINES = ${JSON.stringify(baselines)};\n`);
fs.writeFileSync(path.join(out, "library.js"), `${banner}window.LIBRARY = ${JSON.stringify(library, null, 0).replace(/\},\{/g, "},\n{")};\n`);
console.log(`${tabs.length} tabs (${tabs.map((t) => `${t.key}: ${t.rows.length} rows, scale ${t.scale.lo}/${t.scale.mid}/${t.scale.hi}`).join("; ")})`);
console.log(`${library.length} shelf texts, ${library.filter((e) => e.who === "person").length} by people; ${withheld.size} withheld`);
