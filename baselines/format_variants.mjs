// Builds format variants of a set of documents: same words, different
// surface form. Writes a corpus (manifests/format.jsonl, texts/format/) that
// score_corpus.mjs can score.
//
//   node baselines/format_variants.mjs --roots DIR1,DIR2 --docs group/id,group/id --out DIR
import fs from "node:fs";
import path from "node:path";
import { excerpt } from "./excerpt.mjs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];

function wrap(par, width) {
  const lines = [];
  let line = "";
  for (const word of par.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
const paragraphs = (t) => t.split(/\n\s*\n/);
const straighten = (t) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/—/g, "--").replace(/–/g, "-").replace(/…/g, "...");
const curl = (t) => t
  .replace(/(^|[\s(\[{—-])"/g, "$1“").replace(/"/g, "”")
  .replace(/(^|[\s(\[{—-])'/g, "$1‘").replace(/'/g, "’")
  .replace(/ -- |--/g, "—").replace(/\.\.\./g, "…");
function typos(t) {
  let i = 0;
  return t.replace(/[A-Za-z]{5,}/g, (w) => {
    i++;
    if (i % 40 !== 20) return w;
    const k = 1 + (i % (w.length - 3));
    return w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2);
  });
}

const PROSE = {
  base: (t) => t,
  wrap72: (t) => paragraphs(t).map((p) => wrap(p, 72)).join("\n\n"),
  "single-newline": (t) => paragraphs(t).join("\n"),
  straight: straighten,
  curly: (t) => curl(straighten(t)),
  title: (t, r) => `${r.title}\n\n${t}`,
  "markdown-title": (t, r) => `# ${r.title}\n\nBy ${r.author}\n\n${t}`,
  lowercase: (t) => t.toLowerCase(),
  captions: (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s'’]/gu, " ").replace(/\s+/g, " ").trim(),
  "two-spaces": (t) => t.replace(/([.!?]["”’)]?) (?=\S)/g, "$1  "),
  typos,
};
const VERSE = {
  base: (t) => t,
  unlineated: (t) => paragraphs(t).map((p) => p.split("\n").map((l) => l.trim()).join(" ")).join("\n\n"),
  lowercase: (t) => t.toLowerCase(),
  "no-stanza-breaks": (t) => paragraphs(t).join("\n"),
};

const index = new Map();
for (const root of args.roots.split(",")) {
  for (const f of fs.readdirSync(path.join(root, "manifests")).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(root, "manifests", f), "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      index.set(`${r.group}/${r.id}`, { r, file: path.join(root, "texts", r.group, `${r.id}.txt`) });
    }
  }
}
const rows = [];
fs.mkdirSync(path.join(args.out, "texts", "format"), { recursive: true });
fs.mkdirSync(path.join(args.out, "manifests"), { recursive: true });
for (const key of args.docs.split(",")) {
  const hit = index.get(key);
  if (!hit) throw new Error(`unknown document ${key}`);
  const { r } = hit;
  const base = excerpt(fs.readFileSync(hit.file, "utf8"), 3000);
  const set = r.kind === "poem" || r.kind === "song" ? VERSE : PROSE;
  for (const [name, fn] of Object.entries(set)) {
    const text = fn(base, r);
    const id = `${r.id}--${name}`;
    fs.writeFileSync(path.join(args.out, "texts", "format", `${id}.txt`), text);
    rows.push({ id, group: "format", base: key, variant: name, kind: r.kind, origin: r.origin, period: r.period,
      prefix_chars: text.length - base.length > 0 && text.endsWith(base) ? text.length - base.length : 0,
      changed: text !== base, chars: text.length });
  }
}
fs.writeFileSync(path.join(args.out, "manifests", "format.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`${rows.length} variants of ${args.docs.split(",").length} documents`);
