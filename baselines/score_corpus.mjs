// Scores corpus documents with one model and caches per-token results.
//
//   FEATHERLESS_API_KEY=... node baselines/score_corpus.mjs --root DIR --cache DIR \
//       --model moonshotai/Kimi-K3 [--chars 3000] [--groups a,b] [--ids file] \
//       [--workers 6] [--floor 1.0] [--limit N] [--alts]
//
// Each cached token is [text, logprob, wasFirstGuess, alternatives], where
// alternatives are the model's five likeliest tokens at that position as
// [token, logprob] pairs, likeliest first. Documents scored before 2026-11-28
// lack the alternatives; --alts scores those again and adds only the
// alternatives, leaving the log-probabilities the study's numbers rest on
// untouched.
//
// DIR holds manifests/<group>.jsonl and texts/<group>/<id>.txt. The cache
// holds token text, so it stays outside the repository. Scoring stops when the
// account balance falls to --floor dollars.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { excerpt } from "./excerpt.mjs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
}
const root = args.root, cacheRoot = args.cache, model = args.model;
const maxChars = Number(args.chars || 3000);
const workers = Number(args.workers || 6);
const floor = Number(args.floor || 1.0);
const key = process.env.FEATHERLESS_API_KEY;
const TOP = 5;
if (!root || !cacheRoot || !model || !key) throw new Error("need --root, --cache, --model and FEATHERLESS_API_KEY");

const sandbox = { window: {}, TextDecoder, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../score.js", import.meta.url), "utf8"), sandbox);
const { alignTokens } = sandbox.window.Entropic;

async function balance() {
  const r = await fetch("https://api.featherless.ai/v1/plan", { headers: { Authorization: `Bearer ${key}` } });
  return Number((await r.json()).credits);
}

async function request(prompt) {
  const res = await fetch("https://api.featherless.ai/v1/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, max_tokens: 1, temperature: 0, logprobs: TOP, echo: true, stream: true }),
  });
  const body = await res.text();
  if (!res.ok) { const e = new Error(`${res.status} ${body.slice(0, 160)}`); e.status = res.status; throw e; }
  let best = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    const msg = JSON.parse(line.slice(5));
    if (msg.error) { const e = new Error(JSON.stringify(msg.error).slice(0, 160)); e.status = 503; throw e; }
    for (const c of msg.choices || []) {
      if (c.logprobs && (!best || c.logprobs.tokens.length > best.tokens.length)) best = c.logprobs;
    }
  }
  if (!best) { const e = new Error("no logprobs returned"); e.status = 503; throw e; }
  return best;
}

async function scoreDoc(text) {
  let last;
  for (const wait of [0, 3000, 8000, 20000, 45000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const lp = await request(text);
      // [text, logprob, wasFirstGuess, alternatives]
      return alignTokens(text, lp, 0).map((t) => {
        const top = (t.top || []).slice(0, TOP).map(([s, v]) => [s, Math.round(v * 1000) / 1000]);
        return top.length ? [t.text, t.lp, top[0][0] === t.token ? 1 : 0, top] : [t.text, t.lp, null];
      });
    } catch (e) {
      last = e;
      if (e.code === "no_echo" || (e.status && e.status < 500 && e.status !== 429)) break;
    }
  }
  throw last;
}

const slug = model.split("/").pop();
const only = args.ids ? new Set(fs.readFileSync(args.ids, "utf8").split(/\s+/).filter(Boolean)) : null;
const groups = args.groups
  ? args.groups.split(",")
  : fs.readdirSync(path.join(root, "manifests")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
const todo = [];
for (const g of groups) {
  const file = path.join(root, "manifests", `${g}.jsonl`);
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    if (only && !only.has(`${g}/${r.id}`)) continue;
    const out = path.join(cacheRoot, slug, `c${maxChars}`, g, `${r.id}.json`);
    if (args.alts) {
      if (!fs.existsSync(out)) continue;
      const old = JSON.parse(fs.readFileSync(out, "utf8"));
      if (!old.tokens.some((t) => t[3])) todo.push({ g, id: r.id, out, old });
      continue;
    }
    if (fs.existsSync(out)) continue;
    todo.push({ g, id: r.id, out });
  }
}
if (args.limit) todo.length = Math.min(todo.length, Number(args.limit));
let credits = await balance();
// Adds a fresh run's alternatives to a document scored earlier. Scoring is not
// deterministic, so the written token keeps its cached log-probability, in the
// list of alternatives too.
function addAlternatives(old, fresh) {
  if (old.tokens.length !== fresh.length || old.tokens.some((t, i) => t[0] !== fresh[i][0])) {
    throw new Error("tokens differ from the cached run");
  }
  const tokens = old.tokens.map(([text, lp, first], i) => {
    const top = fresh[i][3];
    if (!top || lp == null) return [text, lp, first];
    const merged = top.map(([s, v]) => [s, s === text ? Math.round(lp * 1000) / 1000 : v]).sort((a, b) => b[1] - a[1]);
    return [text, lp, first, merged];
  });
  return { ...old, tokens };
}

console.log(`${todo.length} to score with ${slug} at ${maxChars} chars; balance $${credits.toFixed(3)}, floor $${floor}`);
let done = 0, failed = 0, stop = credits <= floor;
async function worker() {
  while (todo.length && !stop) {
    const job = todo.shift();
    try {
      if (job.old) {
        const fresh = await scoreDoc(job.old.tokens.map((t) => t[0]).join(""));
        fs.writeFileSync(job.out, JSON.stringify(addAlternatives(job.old, fresh)));
      } else {
        const full = fs.readFileSync(path.join(root, "texts", job.g, `${job.id}.txt`), "utf8");
        const text = excerpt(full, maxChars);
        const tokens = await scoreDoc(text);
        fs.mkdirSync(path.dirname(job.out), { recursive: true });
        fs.writeFileSync(job.out, JSON.stringify({ model, chars: text.length, full_chars: full.length, tokens }));
      }
      done++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${job.g}/${job.id}: ${String(e.message).slice(0, 140)}`);
    }
    if ((done + failed) % 25 === 0) {
      credits = await balance();
      console.log(`${done} done, ${failed} failed, balance $${credits.toFixed(3)}`);
      if (credits <= floor) { stop = true; console.log("balance at floor, stopping"); }
    }
  }
}
await Promise.all(Array.from({ length: workers }, worker));
console.log(`finished: ${done} scored, ${failed} failed, balance $${(await balance()).toFixed(3)}`);
