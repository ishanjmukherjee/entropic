// Measures the mean surprisal (bits per token) of each sample text under each
// scoring model and prints the REFERENCES array for samples.js.
//
//   FEATHERLESS_API_KEY=... node scripts/measure.mjs
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

const sandbox = { window: {} };
vm.runInNewContext(read("samples.js"), sandbox);
const samples = sandbox.window.SAMPLES;
const models = JSON.parse(read("main.js").match(/models:\s*(\[[^\]]*\])/)[1]);
const key = process.env.FEATHERLESS_API_KEY;
if (!key) throw new Error("set FEATHERLESS_API_KEY");

const labels = {
  classic: ["Gettysburg Address", "the Gettysburg Address, which it has memorized"],
  explainer: ["LLM explainer", "an explainer written by an LLM"],
  pitch: ["human pitch", "a short pitch written by a person"],
};

async function meanBits(model, prompt) {
  const res = await fetch("https://api.featherless.ai/v1/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, max_tokens: 1, temperature: 0, logprobs: 1, echo: true, stream: true }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${model}: ${res.status} ${body.slice(0, 200)}`);
  let best = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    const msg = JSON.parse(line.slice(5));
    if (msg.error) throw new Error(`${model}: ${JSON.stringify(msg.error)}`);
    for (const c of msg.choices || []) {
      if (c.logprobs && (!best || c.logprobs.tokens.length > best.tokens.length)) best = c.logprobs;
    }
  }
  if (!best) throw new Error(`${model}: no logprobs returned`);
  // Walk the echoed tokens across the prompt; skip the leading special token
  // and the one generated token after the prompt.
  let pos = 0, sum = 0, n = 0;
  for (let i = 0; i < best.tokens.length && pos < prompt.length; i++) {
    const lp = best.token_logprobs[i];
    if (i === 0 && lp == null && !prompt.startsWith(best.tokens[i])) continue;
    pos += best.tokens[i].length;
    if (lp != null) { sum += -lp / Math.LN2; n++; }
  }
  if (pos < prompt.length) throw new Error(`${model}: the prompt was not echoed in full`);
  return sum / n;
}

const out = [];
for (const model of models) {
  for (const [name, text] of Object.entries(samples)) {
    try {
      const bits = await meanBits(model, text);
      out.push({ model, sample: name, bits: Math.round(bits * 100) / 100, label: labels[name][0], phrase: labels[name][1] });
    } catch (err) {
      console.error(String(err.message || err));
    }
  }
}
console.log("window.REFERENCES = " + JSON.stringify(out, null, 2) + ";");
