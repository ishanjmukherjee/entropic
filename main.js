"use strict";

/*
Scoring asks a model for the log-probability of every token of the text, with
no instructions and no chat formatting: the essay is the whole prompt. The
models are instruction-tuned, but the ones listed here still predict plain
text well when used this way (see eval/RESULTS.md), and unlike pretrained
checkpoints they are reliably available. They are tried in order.

Featherless only returns logprobs on streamed responses, and only some model
backends honour `echo`, which is what makes one request per window possible.
*/
const CONFIG = {
  endpoint: "https://api.featherless.ai/v1/completions",
  models: ["moonshotai/Kimi-K3", "moonshotai/Kimi-K2.6", "deepseek-ai/DeepSeek-V4-Flash"],
  // Public on purpose: this page has no server, so the key ships to every
  // visitor. It is a prepaid key with a small balance and nothing else on it.
  key: "rc_e85cf35c1f4d17f3cf1e4fa8bde905e43e43db02fd1cee2617083bece6317ce2",
  topK: 5,
  windowChars: 24000,
  contextChars: 4000,
  // Longest text scored per run: on the shared key, and on a visitor's own.
  sharedMaxChars: 60000,
  maxChars: 400000,
  retryDelaysMs: [2000, 5000, 10000],
};

// Surprisal (bits) at which the colour scale is fully green, neutral, fully red.
const SCALES = {
  token: { lo: 0, mid: 4, hi: 12 },
  sentence: { lo: 0.3, mid: 2.5, hi: 6 },
};
const GREEN = [143, 209, 154];
const PAPER = [255, 254, 250];
const RED = [240, 144, 127];
const RULER_MAX = 6;
const LN2 = Math.log(2);

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"), score: $("score"), count: $("count"), status: $("status"),
  editor: $("editor"), result: $("result"), stats: $("stats"), ruler: $("ruler"),
  verdict: $("verdict"), legend: $("legend"), heat: $("heat"), lists: $("lists"),
  edit: $("edit"), tip: $("tip"), key: $("key"), keyClear: $("key-clear"),
  modelName: $("model-name"),
};

const state = { view: "token", tokens: [], sentences: [], model: null, busy: false, abort: null };

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch (e) { /* storage unavailable: carry on without it */ }
  return null;
}

class ApiError extends Error {
  constructor(message, { status = 0, code = "", retryable = false } = {}) {
    super(message);
    this.status = status; this.code = code; this.retryable = retryable;
  }
}

function classify(status, body) {
  const err = (body && body.error) || {};
  const code = err.code || "";
  const message = err.message || `request failed (${status})`;
  const retryable = status === 429 || status >= 500 ||
    ["rate_limit_exceeded", "capacity_exhausted", "service_unavailable", "internal_server_error", "no_output"].includes(code);
  return new ApiError(message, { status, code, retryable });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
});

async function requestLogprobs(prompt, model, key, signal) {
  const res = await fetch(CONFIG.endpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, prompt, max_tokens: 1, temperature: 0,
      logprobs: CONFIG.topK, echo: true, stream: true,
    }),
    signal,
  });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
    throw classify(res.status, body);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let best = null;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.error) throw classify(200, msg);
    for (const choice of msg.choices || []) {
      const lp = choice.logprobs;
      if (lp && lp.tokens && (!best || lp.tokens.length > best.tokens.length)) best = lp;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl).trimEnd());
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf.trim());
  if (!best) throw new ApiError("the model returned no token probabilities", { code: "no_logprobs", retryable: true });
  return best;
}

async function scoreText(text, key, signal, onProgress) {
  const wins = Entropic.planWindows(text, CONFIG.windowChars, CONFIG.contextChars);
  let model = null;
  const tokens = [];
  for (let w = 0; w < wins.length; w++) {
    // The first window picks the model; later windows stay on it.
    const candidates = model ? [model] : CONFIG.models;
    let done = false, lastErr = null;
    outer:
    for (const m of candidates) {
      const delays = model ? CONFIG.retryDelaysMs : CONFIG.retryDelaysMs.slice(0, 2);
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        onProgress({ window: w, windows: wins.length, model: m, attempt });
        try {
          const lp = await requestLogprobs(wins[w].prompt, m, key, signal);
          let aligned;
          try {
            aligned = Entropic.alignTokens(wins[w].prompt, lp, wins[w].keepFrom);
          } catch (e) {
            throw new ApiError(e.message, { code: "no_echo" });
          }
          tokens.push(...aligned);
          model = m;
          done = true;
          break outer;
        } catch (err) {
          if (err.name === "AbortError") throw err;
          lastErr = err;
          if (!(err instanceof ApiError)) throw err;
          if ([401, 402, 403].includes(err.status)) throw err;
          if (!err.retryable) break;
          if (attempt < delays.length) await sleep(delays[attempt], signal);
        }
      }
    }
    if (!done) throw lastErr || new ApiError("scoring failed");
  }
  return { tokens, model };
}

function bitsOf(lp) { return lp == null ? null : Math.max(0, -lp / LN2); }

function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function heatColor(bits, scale) {
  if (bits == null) return "transparent";
  let rgb;
  if (bits <= scale.mid) {
    const t = Math.min(1, Math.max(0, (bits - scale.lo) / (scale.mid - scale.lo)));
    rgb = mix(GREEN, PAPER, Math.pow(t, 0.8));
  } else {
    const t = Math.min(1, (bits - scale.mid) / (scale.hi - scale.mid));
    rgb = mix(PAPER, RED, Math.pow(t, 0.8));
  }
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function segmentSentences(text) {
  const spans = [];
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
    for (const s of seg.segment(text)) spans.push([s.index, s.index + s.segment.length]);
  } else {
    const re = /[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)\s*/g;
    let m;
    while ((m = re.exec(text)) && m[0].length) spans.push([m.index, m.index + m[0].length]);
  }
  // Paragraph breaks always end a sentence, even without punctuation.
  const out = [];
  for (const [a, b] of spans) {
    let from = a;
    const chunk = text.slice(a, b);
    const re = /\n\s*\n/g;
    let m;
    while ((m = re.exec(chunk))) {
      const cut = a + m.index + m[0].length;
      if (cut > from && cut < b) { out.push([from, cut]); from = cut; }
    }
    out.push([from, b]);
  }
  return out;
}

function analyse(tokens) {
  let pos = 0;
  for (const t of tokens) { t.start = pos; pos += t.text.length; t.bits = bitsOf(t.lp); }
  const text = tokens.map((t) => t.text).join("");
  for (const t of tokens) {
    // Rank is known only when the token is among the returned alternatives.
    t.rank = null;
    if (t.lp != null && t.top.some(([s]) => s === t.token)) {
      const beaten = t.top.filter(([, v]) => v > t.lp + 1e-9).length;
      if (beaten < CONFIG.topK) t.rank = beaten + 1;
    }
  }
  const spans = segmentSentences(text);
  const sentences = spans.map(([a, b]) => ({ start: a, end: b, sum: 0, n: 0, first: -1, last: -1 }));
  let si = 0;
  tokens.forEach((t, i) => {
    // A token belongs to the sentence holding its first non-space character.
    const lead = t.text.length - t.text.trimStart().length;
    const anchor = Math.min(t.start + lead, t.start + Math.max(0, t.text.length - 1));
    while (si < sentences.length - 1 && anchor >= sentences[si].end) si++;
    const s = sentences[si];
    t.sent = si;
    if (s.first < 0) s.first = i;
    s.last = i;
    if (t.bits != null) { s.sum += t.bits; s.n++; }
  });
  for (const s of sentences) {
    s.mean = s.n ? s.sum / s.n : null;
    s.text = text.slice(s.start, s.end).trim();
  }
  const scored = tokens.filter((t) => t.bits != null);
  const total = scored.reduce((a, t) => a + t.bits, 0);
  const words = (text.match(/\S+/g) || []).length;
  return {
    text, sentences,
    summary: {
      tokens: scored.length,
      words,
      mean: scored.length ? total / scored.length : 0,
      perWord: words ? total / words : 0,
      top1: scored.length ? scored.filter((t) => t.rank === 1).length / scored.length : 0,
      topK: scored.length ? scored.filter((t) => t.rank != null).length / scored.length : 0,
    },
  };
}

function fmtPct(x) { return `${Math.round(x * 100)}%`; }
function fmtProb(lp) {
  const p = Math.exp(lp) * 100;
  if (p >= 99.95) return "100%";
  if (p >= 10) return `${p.toFixed(0)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  if (p >= 0.01) return `${p.toFixed(2)}%`;
  return "<0.01%";
}
// Tokens carry their leading space; drop it for display and make bare whitespace visible.
function showToken(s) {
  const t = s.trim();
  if (t) return t;
  if (!s) return "(empty)";
  return s.replace(/\n/g, "\u21b5").replace(/\t/g, "\u21e5").replace(/ /g, "\u2423");
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderStats(summary) {
  const items = [
    [summary.mean.toFixed(2), "bits per token", "mean surprisal; lower is more predictable"],
    [fmtPct(summary.top1), "first guess", "tokens that were the model's single most likely next token"],
    [fmtPct(summary.topK), `in its top ${CONFIG.topK}`, `tokens that were among the model's ${CONFIG.topK} most likely`],
    [summary.tokens.toLocaleString(), `tokens, ${summary.words.toLocaleString()} words`, `about ${summary.perWord.toFixed(1)} bits per word`],
  ];
  els.stats.replaceChildren(...items.map(([value, label, title]) => {
    const d = el("div");
    d.title = title;
    d.append(el("dd", null, value), el("dt", null, label));
    return d;
  }));
}

function gradient(scale, max) {
  const stops = [];
  for (let i = 0; i <= 12; i++) {
    const b = (i / 12) * max;
    stops.push(`${heatColor(b, scale)} ${((i / 12) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function renderRuler(mean, usedModel) {
  const pct = (b) => Math.min(100, Math.max(0, (b / RULER_MAX) * 100));
  const edge = (p) => (p < 9 ? " left" : p > 91 ? " right" : "");
  const track = el("div", "track");
  track.style.background = gradient(SCALES.sentence, RULER_MAX);
  const kids = [track];
  const refs = (window.REFERENCES || []).filter((r) => r.model === usedModel);
  // References are ticks under the track, named in a line below in the same
  // left-to-right order, so labels can never collide.
  refs.sort((a, b) => a.bits - b.bits);
  for (const r of refs) {
    const tick = el("div", "tick");
    tick.style.left = `${pct(r.bits)}%`;
    kids.push(tick);
  }
  const p = pct(mean);
  const you = el("div", "you" + edge(p), `this text ${mean.toFixed(2)}`);
  you.style.left = `${p}%`;
  kids.push(you);
  els.ruler.replaceChildren(...kids);
  const names = el("p", "refs");
  refs.forEach((r, i) => {
    if (i) names.append(" \u00b7 ");
    names.append(el("span", null, `${r.label} ${r.bits.toFixed(2)}`));
  });
  if (refs.length) els.ruler.append(names);

  els.verdict.replaceChildren();
  if (refs.length >= 2) {
    const near = refs.slice().sort((a, b) => Math.abs(a.bits - mean) - Math.abs(b.bits - mean))[0];
    const rel = Math.abs(near.bits - mean) < 0.15 ? "about as predictable as"
      : mean < near.bits ? "more predictable than" : "less predictable than";
    els.verdict.append("To this model, your text is ", el("b", null, `${rel} ${near.phrase}`), ".");
  }
}

function renderLegend() {
  const scale = SCALES[state.view];
  const bar = el("i");
  bar.style.background = gradient(scale, scale.hi);
  const unit = state.view === "token" ? "bits" : "bits per token";
  els.legend.title = "0 bits: the model was certain. Each extra bit halves the probability it gave.";
  els.legend.replaceChildren(el("span", null, `${scale.lo}`), bar, el("span", null, `${scale.hi}+ ${unit}`));
}

function renderHeat() {
  const frag = document.createDocumentFragment();
  const scale = SCALES[state.view];
  const byToken = state.view === "token";
  state.tokens.forEach((t, i) => {
    const span = el("span");
    span.dataset.i = i;
    const bits = byToken ? t.bits : state.sentences[t.sent].mean;
    const blank = !t.text.trim();
    if (bits == null || blank) {
      span.textContent = t.text;
    } else if (byToken) {
      // Shade the word itself and leave its leading space clear, so each token reads as a chip.
      const lead = t.text.length - t.text.trimStart().length;
      if (lead) span.append(t.text.slice(0, lead));
      const chip = el("i", null, t.text.slice(lead));
      chip.style.background = heatColor(bits, scale);
      span.append(chip);
    } else {
      span.textContent = t.text;
      span.style.background = heatColor(bits, scale);
    }
    frag.append(span);
  });
  els.heat.replaceChildren(frag);
  renderLegend();
}

function renderLists() {
  const eligible = state.sentences
    .map((s, i) => ({ ...s, i }))
    .filter((s) => s.mean != null && s.n >= 8 && s.text.length >= 30);
  if (eligible.length < 6) { els.lists.replaceChildren(); return; }
  const n = Math.min(5, Math.floor(eligible.length / 2));
  const flat = eligible.slice().sort((a, b) => a.mean - b.mean).slice(0, n);
  const sharp = eligible.slice().sort((a, b) => b.mean - a.mean).slice(0, n);
  const col = (title, hint, rows) => {
    const d = el("div");
    d.append(el("h2", null, title), el("p", "hint", hint));
    const ol = el("ol");
    for (const s of rows) {
      const li = el("li");
      li.dataset.sent = s.i;
      li.title = "show in text";
      const num = el("span", "n", s.mean.toFixed(1));
      num.style.background = heatColor(s.mean, SCALES.sentence);
      li.append(num, el("span", "q", s.text.replace(/\s+/g, " ")));
      ol.append(li);
    }
    d.append(ol);
    return d;
  };
  els.lists.replaceChildren(
    col("most predictable sentences", "candidates to cut or sharpen", flat),
    col("most surprising sentences", "where you add the most", sharp));
}

function flashSentence(si) {
  const s = state.sentences[si];
  if (!s || s.first < 0) return;
  const spans = els.heat.children;
  spans[s.first].scrollIntoView({ behavior: "smooth", block: "center" });
  for (let i = s.first; i <= s.last; i++) {
    spans[i].classList.remove("flash");
    void spans[i].offsetWidth;
    spans[i].classList.add("flash");
  }
}

let tipFor = null;
function hideTip() {
  if (tipFor) tipFor.classList.remove("on");
  tipFor = null;
  els.tip.hidden = true;
}
function showTip(span) {
  const t = state.tokens[Number(span.dataset.i)];
  if (!t || t.lp == null) { hideTip(); return; }
  if (tipFor) tipFor.classList.remove("on");
  tipFor = span;
  span.classList.add("on");
  const rank = t.rank === 1 ? "the model's first guess" : t.rank ? `guess #${t.rank}` : `not in its top ${CONFIG.topK}`;
  const kids = [
    el("div", "tok", showToken(t.token || t.text)),
    el("div", "meta", `${fmtProb(t.lp)} likely · ${t.bits.toFixed(1)} bits · ${rank}`),
  ];
  if (state.view === "sentence") {
    const s = state.sentences[t.sent];
    if (s && s.mean != null) kids.push(el("div", "meta", `sentence mean ${s.mean.toFixed(2)} bits/token`));
  }
  const alts = t.top.slice(0, CONFIG.topK);
  if (alts.length) {
    const grid = el("div", "alts");
    grid.append(el("div", "h", "the model expected"));
    const max = Math.exp(alts[0][1]);
    for (const [s, lp] of alts) {
      const hit = s === t.token;
      const bar = el("div", "b");
      const fill = el("i", hit ? "hit" : null);
      fill.style.width = `${Math.max(2, (Math.exp(lp) / max) * 100)}%`;
      bar.append(fill);
      grid.append(el("div", "t" + (hit ? " hit" : ""), showToken(s)), el("div", "p", fmtProb(lp)), bar);
    }
    kids.push(grid);
  }
  els.tip.replaceChildren(...kids);
  els.tip.hidden = false;
  const r = span.getClientRects()[0] || span.getBoundingClientRect();
  const tw = els.tip.offsetWidth, th = els.tip.offsetHeight;
  const vw = document.documentElement.clientWidth;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(vw - tw - 8, x));
  let y = r.top - th - 8;
  if (y < 8) y = r.bottom + 8;
  els.tip.style.left = `${x + window.scrollX}px`;
  els.tip.style.top = `${y + window.scrollY}px`;
}

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("error", !!isError);
}
function updateCount() {
  const text = els.text.value;
  const words = (text.match(/\S+/g) || []).length;
  els.count.textContent = words ? `${words.toLocaleString()} words` : "";
  els.score.disabled = state.busy || !text.trim();
}
function showEditor(focus) {
  hideTip();
  els.result.hidden = true;
  els.editor.hidden = false;
  if (focus) els.text.focus();
}
function shortModel(m) { return (m || "").split("/").pop(); }

function explain(err) {
  if (!(err instanceof ApiError)) return "Could not reach the scoring service. Check your connection and try again.";
  if (err.status === 401) return "The API key was rejected. Check the key under settings.";
  if (err.status === 402 || /credit|balance|billing/i.test(err.message)) return "The shared scoring budget has run out. Add your own Featherless key under settings to keep going.";
  if (err.status === 403) return `The scoring service refused the request: ${err.message}`;
  if (err.retryable) return "The model is busy right now. Give it a minute and try again.";
  return `Scoring failed: ${err.message}`;
}

async function run() {
  if (state.busy) return;
  let text = els.text.value.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!text.trim()) return;
  const ownKey = (els.key.value || "").trim();
  const limit = ownKey ? CONFIG.maxChars : CONFIG.sharedMaxChars;
  let note = "";
  if (text.length > limit) {
    text = text.slice(0, limit);
    note = ` Only the first ${limit.toLocaleString()} characters were scored`
      + (ownKey ? "." : "; add your own key under settings for longer texts.");
  }
  store("entropic:text", text.length <= 200000 ? text : null);
  state.busy = true;
  state.abort = new AbortController();
  updateCount();
  els.score.textContent = "scoring";
  const key = ownKey || CONFIG.key;
  try {
    const { tokens, model } = await scoreText(text, key, state.abort.signal, (p) => {
      const part = p.windows > 1 ? ` part ${p.window + 1} of ${p.windows}` : "";
      const wait = p.attempt > 0 ? ", model is busy, retrying" : "";
      setStatus(`reading${part} with ${shortModel(p.model)}${wait}…`);
    });
    const { sentences, summary } = analyse(tokens);
    state.tokens = tokens; state.sentences = sentences; state.model = model;
    renderStats(summary);
    renderRuler(summary.mean, model);
    renderHeat();
    renderLists();
    els.editor.hidden = true;
    els.result.hidden = false;
    const fb = model !== CONFIG.models[0]
      ? ` The usual model was busy, so this used ${shortModel(model)}; its scores run a little higher.` : "";
    setStatus(`scored by ${shortModel(model)}.${fb}${note}`);
  } catch (err) {
    if (err.name !== "AbortError") setStatus(explain(err), true);
  } finally {
    state.busy = false;
    state.abort = null;
    els.score.textContent = "score";
    updateCount();
  }
}

function init() {
  els.modelName.textContent = shortModel(CONFIG.models[0]);
  const saved = store("entropic:text");
  if (saved) els.text.value = saved;
  const savedKey = store("entropic:key");
  if (savedKey) els.key.value = savedKey;
  updateCount();

  els.text.addEventListener("input", updateCount);
  els.text.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
  });
  els.score.addEventListener("click", run);
  els.edit.addEventListener("click", () => { setStatus(""); showEditor(true); });
  document.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", () => {
    const s = (window.SAMPLES || {})[b.dataset.sample];
    if (!s) return;
    els.text.value = s;
    updateCount();
    run();
  }));
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    document.querySelectorAll("[data-view]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    hideTip();
    renderHeat();
  }));
  els.key.addEventListener("change", () => store("entropic:key", els.key.value.trim() || null));
  els.keyClear.addEventListener("click", () => { els.key.value = ""; store("entropic:key", null); });

  // A mouse shows the tooltip on hover. A tap toggles it, and the mouse
  // events browsers synthesise after a tap are ignored.
  let tapped = false;
  els.heat.addEventListener("pointerdown", (e) => { tapped = e.pointerType !== "mouse"; });
  els.heat.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const span = e.target.closest("span[data-i]");
    if (span) showTip(span);
  });
  els.heat.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideTip(); });
  els.heat.addEventListener("click", (e) => {
    if (!tapped) return;
    const span = e.target.closest("span[data-i]");
    if (span && span !== tipFor) showTip(span); else hideTip();
  });
  document.addEventListener("click", (e) => { if (!els.heat.contains(e.target)) hideTip(); });
  window.addEventListener("resize", hideTip);
  els.lists.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-sent]");
    if (li) flashSentence(Number(li.dataset.sent));
  });
}

init();
