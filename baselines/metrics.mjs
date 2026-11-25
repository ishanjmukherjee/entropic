// Turns cached per-token scores into per-document metrics (numbers and
// metadata only, no text).
//
//   node baselines/metrics.mjs --roots DIR1,DIR2 --cache DIR --out baselines/results/docs.jsonl
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];

const sandbox = { window: {}, TextDecoder, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../score.js", import.meta.url), "utf8"), sandbox);
const { groupPassages, PASSAGE } = sandbox.window.Entropic;

const CONFIGS = [
  ["k3", "Kimi-K3", 3000], ["ds", "DeepSeek-V4-Flash", 3000],
  ["k3_long", "Kimi-K3", 12000], ["ds_long", "DeepSeek-V4-Flash", 12000],
];
const CHECKPOINTS = [500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000, 10000, 12000];
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

function metrics(tokens) {
  let pos = 0, sum = 0, n = 0, chars = 0, first = 0, firstN = 0, ci = 0;
  const running = {};
  tokens.forEach(([text, lp, wasFirst], i) => {
    pos += text.length;
    if (i > 0 && lp != null) {
      sum += Math.max(0, -lp / Math.LN2); n++; chars += text.length;
      if (wasFirst != null) { first += wasFirst; firstN++; }
    }
    while (ci < CHECKPOINTS.length && pos >= CHECKPOINTS[ci]) {
      if (n) running[CHECKPOINTS[ci]] = round(sum / n);
      ci++;
    }
  });
  if (!n) return null;
  const text = tokens.map((t) => t[0]).join("");
  const words = (text.match(/\S+/g) || []).length;
  const passages = groupPassages(tokens.map(([t, lp], i) => ({ text: t, lp: i === 0 ? null : lp })))
    .filter((p) => p.n >= PASSAGE.listMinTokens).map((p) => round(p.mean, 2));
  const sorted = [...passages].sort((a, b) => a - b);
  return {
    tokens: n, chars: text.length, words, bits: round(sum / n), bpc: round(sum / chars), bpw: round(sum / words),
    first: firstN ? round(first / firstN) : null, running,
    passages: { n: sorted.length, p10: quantile(sorted, 0.1), p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), means: passages },
  };
}

const out = [];
let missing = 0;
for (const root of args.roots.split(",")) {
  const dir = path.join(root, "manifests");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      const scores = {};
      for (const [name, slug, chars] of CONFIGS) {
        const p = path.join(args.cache, slug, `c${chars}`, row.group, `${row.id}.json`);
        if (!fs.existsSync(p)) continue;
        const m = metrics(JSON.parse(fs.readFileSync(p, "utf8")).tokens);
        if (m) scores[name] = m;
      }
      if (!scores.k3) missing++;
      out.push({ ...row, scores });
    }
  }
}
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`${out.length} documents, ${missing} without a Kimi K3 score -> ${args.out}`);
