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
  // Shared scoring goes through a small proxy that holds the API key
  // (worker/). A visitor's own key talks to Featherless directly.
  proxy: "https://entropic-proxy.ishanjmukherjee.workers.dev/score",
  direct: "https://api.featherless.ai/v1/completions",
  models: ["moonshotai/Kimi-K3", "moonshotai/Kimi-K2.6"],
  // A mean above this many bits per token means the backend is broken, not
  // that the text is surprising; such a response is discarded.
  maxSaneBits: 20,
  topK: 5,
  windowChars: 24000,
  contextChars: 4000,
  // Longest text scored per run: on the shared key, and on a visitor's own.
  sharedMaxChars: 60000,
  maxChars: 400000,
  retryDelaysMs: [2000, 5000, 10000],
};

// Surprisal (bits) at which the colour scale is fully red, neutral, fully
// green. Passages are shaded against the reference texts for the selected kind
// of writing (data/baselines.js, built by baselines/build_site.mjs); the
// fallback applies only if that file is missing.
const TOKEN_SCALE = { lo: 0, mid: 4, hi: 12 };
const FALLBACK_SCALE = { lo: 0.8, mid: 2.4, hi: 3.9 };
// Single tokens are too noisy to read, so the default view averages over
// passages of one to three sentences (Entropic.groupPassages in score.js).
// Shading pulls each passage towards the document mean with the weight of
// PASSAGE.prior tokens, so a three-word heading cannot flash bright.
const PASSAGE = Entropic.PASSAGE;
// Red is predictable and green is surprising. The two ends also differ in
// lightness, so they stay apart for readers who cannot tell red from green.
const RED = [233, 122, 102];
const PAPER = [255, 254, 250];
const GREEN = [142, 220, 182];
const LN2 = Math.log(2);

const BASE = window.BASELINES || { tabs: [], chars: 3000, scorer: "", documents: 0 };
const LIBRARY = window.LIBRARY || [];
const NOUN = {
  essay: ["an essay", "essays"], paper: ["a paper", "papers"], fiction: ["a story", "stories"], poem: ["a poem", "poems"],
  song: ["a song lyric", "song lyrics"], play: ["a play scene", "play scenes"], code: ["a code file", "code files"],
};

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"), score: $("score"), count: $("count"), status: $("status"),
  editor: $("editor"), resultHead: $("result-head"), resultBody: $("result-body"),
  source: $("source"), stats: $("stats"), tabs: $("tabs"), chart: $("chart"), rulerIntro: $("ruler-intro"),
  verdict: $("verdict"), legend: $("legend"), heat: $("heat"), lists: $("lists"),
  shelfList: $("shelf-list"), shelfKind: $("shelf-kind"), aboutCount: $("about-count"),
  edit: $("edit"), tip: $("tip"), key: $("key"), keyClear: $("key-clear"),
  modelName: $("model-name"), perToken: $("per-token"),
};

const state = {
  view: "passage", kind: BASE.tabs.length ? BASE.tabs[0].key : "essay", text: "", tokens: [], passages: [],
  summary: null, model: null, item: null, shown: false, busy: false, abort: null, expanded: {},
};
const tabByKey = (k) => BASE.tabs.find((t) => t.key === k) || null;
function passageScale() { const t = tabByKey(state.kind); return t ? t.scale : FALLBACK_SCALE; }

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

// Refusals from the proxy itself; trying again or another model will not help.
const PROXY_LIMITS = ["daily_cap", "visitor_limit", "proxy_key_rejected"];

function classify(status, body) {
  const err = (body && body.error) || {};
  const code = err.code || "";
  const message = err.message || `request failed (${status})`;
  const retryable = !PROXY_LIMITS.includes(code) && (status === 429 || status >= 500 ||
    ["rate_limit_exceeded", "capacity_exhausted", "service_unavailable", "internal_server_error", "no_output"].includes(code));
  return new ApiError(message, { status, code, retryable });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
});

async function requestLogprobs(prompt, model, key, signal) {
  // The proxy builds the upstream request itself and takes only these two fields.
  const res = key
    ? await fetch(CONFIG.direct, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, prompt, max_tokens: 1, temperature: 0,
        logprobs: CONFIG.topK, echo: true, stream: true,
      }),
      signal,
    })
    : await fetch(CONFIG.proxy, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt }),
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
          const scored = aligned.filter((t) => t.lp != null);
          const mean = scored.reduce((a, t) => a - t.lp / LN2, 0) / Math.max(1, scored.length);
          if (aligned.length > 20 && (scored.length < aligned.length / 2 || mean > CONFIG.maxSaneBits)) {
            throw new ApiError("the model returned implausible scores", { code: "bad_scores" });
          }
          tokens.push(...aligned);
          model = m;
          done = true;
          break outer;
        } catch (err) {
          if (err.name === "AbortError") throw err;
          lastErr = err;
          if (!(err instanceof ApiError)) throw err;
          if ([401, 402, 403].includes(err.status) || PROXY_LIMITS.includes(err.code)) throw err;
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
    rgb = mix(RED, PAPER, Math.pow(t, 0.8));
  } else {
    const t = Math.min(1, (bits - scale.mid) / (scale.hi - scale.mid));
    rgb = mix(PAPER, GREEN, Math.pow(t, 0.8));
  }
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function analyse(tokens) {
  let pos = 0;
  for (const t of tokens) { t.start = pos; pos += t.text.length; t.bits = bitsOf(t.lp); }
  const text = tokens.map((t) => t.text).join("");
  for (const t of tokens) {
    // Rank is known only when the token is among the returned alternatives.
    t.rank = null;
    // Shelf texts record only whether the token was the first guess.
    if (t.shelf) { if (t.first) t.rank = 1; continue; }
    if (t.lp != null && t.top.some(([s]) => s === t.token)) {
      const beaten = t.top.filter(([, v]) => v > t.lp + 1e-9).length;
      if (beaten < CONFIG.topK) t.rank = beaten + 1;
    }
  }
  const scored = tokens.filter((t) => t.bits != null);
  const total = scored.reduce((a, t) => a + t.bits, 0);
  const words = (text.match(/\S+/g) || []).length;
  const docMean = scored.length ? total / scored.length : 0;
  // The reference texts were measured on their openings with the first token
  // left out, so the figure compared with them is measured the same way.
  const cut = Entropic.excerptEnd(text, BASE.chars);
  const head = tokens.filter((t, i) => i > 0 && t.bits != null && t.start < cut);
  const shelf = tokens.some((t) => t.shelf);
  const passages = Entropic.groupPassages(tokens);
  passages.forEach((p, pi) => {
    p.text = text.slice(p.start, p.end);
    p.shade = p.n ? (p.sum + PASSAGE.prior * docMean) / (p.n + PASSAGE.prior) : null;
    const visible = [];
    for (let i = p.first; i <= p.last; i++) {
      tokens[i].passage = pi;
      if (tokens[i].bits != null && tokens[i].text.trim()) visible.push(tokens[i]);
    }
    p.top = visible.sort((x, y) => y.bits - x.bits).slice(0, 3);
  });
  return {
    text, passages,
    summary: {
      tokens: scored.length,
      words,
      mean: scored.length ? total / scored.length : 0,
      perWord: words ? total / words : 0,
      top1: scored.length ? scored.filter((t) => t.rank === 1).length / scored.length : 0,
      topK: shelf ? null : scored.length ? scored.filter((t) => t.rank != null).length / scored.length : 0,
      opening: head.length ? head.reduce((a, t) => a + t.bits, 0) / head.length : null,
      openingWords: (text.slice(0, cut).match(/\S+/g) || []).length,
      partial: cut < text.length,
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
    summary.topK == null ? null : [fmtPct(summary.topK), `in its top ${CONFIG.topK}`, `tokens that were among the model's ${CONFIG.topK} most likely`],
    [summary.tokens.toLocaleString(), `tokens, ${summary.words.toLocaleString()} words`, `about ${summary.perWord.toFixed(1)} bits per word`],
  ];
  els.stats.replaceChildren(...items.filter(Boolean).map(([value, label, title]) => {
    const d = el("div");
    d.title = title;
    d.append(el("dd", null, value), el("dt", null, label));
    return d;
  }));
}

function gradient(scale) {
  const stops = [];
  for (let i = 0; i <= 12; i++) {
    const b = scale.lo + (i / 12) * (scale.hi - scale.lo);
    stops.push(`${heatColor(b, scale)} ${((i / 12) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function renderLegend() {
  const token = state.view === "token";
  const scale = token ? TOKEN_SCALE : passageScale();
  const tab = tabByKey(state.kind);
  const bar = el("i");
  bar.style.background = gradient(scale);
  els.legend.title = "0 bits: the model was certain. Each extra bit halves the probability it gave."
    + (token ? "" : " Each passage is shaded by the average over its tokens, on a scale set by the reference texts.");
  els.legend.replaceChildren(
    el("span", null, `predictable ${scale.lo}`), bar, el("span", null, `${scale.hi}+ surprising`),
    el("span", "unit", token ? "bits" : `bits per token${tab ? `, scale for ${tab.label}` : ""}`));
}

// A rough guess at what kind of writing a pasted text is, so it is compared
// with the right reference texts. The tabs let the reader overrule it.
function guessKind(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  let kind = "essay";
  if (lines.length >= 8) {
    const codey = lines.filter((l) => /[{};]\s*$|^\s*(def|class|import|function|const|let|var|return|#include|fn|pub|package|func|public|private|static)\b|^\s*\/\/|=>|:=|\)\s*\{/.test(l)).length;
    const lens = lines.map((l) => l.trim().length).sort((a, b) => a - b);
    if (codey / lines.length > 0.35) kind = "code";
    else if (lens[Math.floor(lens.length * 0.8)] <= 60) kind = "poem";
  }
  return tabByKey(kind) ? kind : state.kind;
}

function renderTabs() {
  els.tabs.replaceChildren(...BASE.tabs.map((t) => {
    const b = el("button", "tab", t.label);
    b.type = "button";
    b.dataset.kind = t.key;
    b.setAttribute("aria-pressed", String(t.key === state.kind));
    return b;
  }));
}

function setKind(kind) {
  if (!tabByKey(kind) || kind === state.kind) return;
  state.kind = kind;
  hideTip();
  renderTabs(); renderChart(); renderShelf();
  if (state.shown) { renderHeat(); renderLists(); }
}

// One row per group of reference texts: a dot for each text, a bar over the
// middle half and a tick at the median. When a text is on show, a line marks
// where its opening falls.
function renderChart() {
  const tab = tabByKey(state.kind);
  if (!tab) { $("ruler").hidden = true; return; }
  const x = state.shown && state.summary ? state.summary.opening : null;
  const max = Math.max(tab.max, x != null ? Math.ceil(x + 0.25) : 0);
  const pct = (b) => `${Math.min(100, Math.max(0, (b / max) * 100)).toFixed(2)}%`;
  const kids = [];
  if (x != null) {
    const head = el("div", "crow head");
    const track = el("div", "track");
    const p = (x / max) * 100;
    const you = el("b", "you" + (p < 12 ? " left" : p > 88 ? " right" : ""), `${state.item ? "this text" : "your text"} ${x.toFixed(2)}`);
    you.style.left = pct(x);
    track.append(you);
    head.append(el("div", "lab"), track);
    kids.push(head);
  }
  let prev = null;
  tab.rows.forEach((r, ri) => {
    const row = el("div", "crow" + (prev && prev !== r.who ? " gap" : ""));
    prev = r.who;
    const lab = el("div", "lab");
    lab.append(el("span", null, r.label), el("small", null, `${r.n} texts, median ${r.median.toFixed(2)}`));
    const strip = el("div", `strip ${r.who}`);
    strip.style.backgroundSize = `${(100 / max).toFixed(4)}% 100%`;
    const box = el("i", "box");
    box.style.left = pct(r.p25);
    box.style.width = `${(((r.p75 - r.p25) / max) * 100).toFixed(2)}%`;
    strip.append(box);
    r.docs.forEach((d, i) => {
      const dot = el("i", "d" + (d[2] ? " has" : ""));
      dot.style.left = pct(d[0]);
      dot.style.top = `${11 + (((i * 2654435761) >>> 0) % 13)}px`;
      dot.dataset.row = ri;
      dot.dataset.doc = i;
      strip.append(dot);
    });
    const med = el("i", "med");
    med.style.left = pct(r.median);
    strip.append(med);
    if (x != null) {
      const me = el("i", "me");
      me.style.left = pct(x);
      strip.append(me);
    }
    row.append(lab, strip);
    kids.push(row);
  });
  const axis = el("div", "crow axis");
  const ticks = el("div", "ticks");
  for (let i = 0; i <= max; i++) {
    const t = el("span", null, String(i));
    t.style.left = pct(i);
    ticks.append(t);
  }
  axis.append(el("div", "lab", "mean bits per token"), ticks);
  kids.push(axis);
  els.chart.replaceChildren(...kids);
  renderVerdict(tab, x);
}

function renderVerdict(tab, x) {
  const row = (key) => tab.rows.find((r) => r.key === key);
  const people = row("people-post"), bare = row("models-bare"), coached = row("models-coached");
  const [one, many] = NOUN[tab.key] || ["a text", "texts"];
  const kids = [];
  if (x == null) {
    if (people && bare) {
      kids.push(`Paired at random, ${one} that a model wrote from a one-line prompt scored lower than one by a person ${fmtPct(bare.below)} of the time`
        + (coached ? `; with a prompt spelling out voice or craft, ${fmtPct(coached.below)}.` : "."));
    }
  } else {
    const s = state.summary;
    const whose = state.item ? "This text" : "Your text";
    const e = state.item;
    const partial = s.partial || (e && e.position !== "interior" && e.total_chars > e.chars + 20);
    kids.push(partial ? `${whose}'s opening ${s.openingWords.toLocaleString()} words average ` : `${whose} averages `,
      el("b", null, `${x.toFixed(2)} bits per token`), ".");
    if (people && bare) {
      const lower = people.docs.filter((d) => d[0] > x).length, higher = bare.docs.filter((d) => d[0] < x).length;
      kids.push(` That is lower than ${lower} of the ${people.n} new ${many} by people, and higher than ${higher} of the ${bare.n} that models wrote from a one-line prompt.`);
      if (x < bare.docs[0][0]) kids.push(" Scores this low mostly belong to text the model has read before, or to boilerplate.");
    }
    if (s.tokens < 150) kids.push(" It is a short text, and short texts swing widely.");
    if (state.model && BASE.scorer && state.model !== BASE.scorer) {
      kids.push(` The reference texts were scored by ${shortModel(BASE.scorer)} and this one by ${shortModel(state.model)}, so compare loosely.`);
    }
  }
  els.verdict.replaceChildren(...kids);
}

const POPULARITY = { low: "older, little known", mid: "older, fairly well known", high: "older, famous" };
const STYLE = { bare: "one-line prompt", matched: "given a real title and subject", styled: "coached on voice", craft: "coached on craft" };
function itemMeta(e) {
  const parts = [e.author];
  const year = (e.date || "").slice(0, 4);
  if (e.who === "person" || e.prized) { if (year) parts.push(year); }
  if (e.kind !== e.tab) parts.push(e.kind);
  if (e.language) parts.push(e.language);
  if (e.who === "person") parts.push(e.period === "post" ? "new" : POPULARITY[e.popularity] || "older");
  else parts.push(e.prized ? "prized" : STYLE[e.style] || e.style);
  return parts.join(" · ");
}

function renderShelf() {
  const tab = tabByKey(state.kind);
  const items = LIBRARY.filter((e) => e.tab === state.kind);
  els.shelfKind.textContent = tab ? `${items.length} ${tab.label === "code" ? "code files" : tab.label}` : "";
  const scale = passageScale();
  const col = (who, title) => {
    const rows = items.filter((e) => e.who === who);
    const d = el("div");
    d.append(el("h3", null, title));
    if (!rows.length) { d.append(el("p", "hint", "none yet")); return d; }
    const open = state.expanded[`${state.kind}/${who}`] || rows.length <= 12;
    const ol = el("ol");
    for (const e of open ? rows : rows.slice(0, 10)) {
      const li = el("li");
      const a = el("a", "item" + (state.item && state.item.id === e.id ? " on" : ""));
      a.href = `#shelf/${e.id}`;
      const num = el("span", "n", e.bits.toFixed(2));
      num.style.background = heatColor(e.bits, scale);
      const body = el("span", "b");
      body.append(el("span", "t", e.title), el("span", "m", itemMeta(e)));
      a.append(num, body);
      li.append(a);
      ol.append(li);
    }
    d.append(ol);
    if (!open) {
      const more = el("button", "link more", `show all ${rows.length}`);
      more.type = "button";
      more.dataset.expand = `${state.kind}/${who}`;
      d.append(more);
    }
    return d;
  };
  els.shelfList.replaceChildren(col("person", "by people"), col("model", "by models"));
}

function renderSource() {
  const e = state.item;
  if (!e) { els.source.replaceChildren(); return; }
  const head = el("p", "what");
  head.append(el("b", null, e.title), ` · ${itemMeta(e)}`);
  if (e.url) {
    const a = el("a", null, "source");
    a.href = e.url; a.target = "_blank"; a.rel = "noopener";
    head.append(" · ", a);
  }
  const whole = e.total_chars <= e.chars + 20;
  const span = e.position === "interior" ? `An excerpt of ${e.words.toLocaleString()} words from inside the work, as scored.`
    : whole ? `The whole text, ${e.words.toLocaleString()} words.`
      : `The opening ${e.words.toLocaleString()} words, which is the part that was scored.`;
  const kids = [head, el("p", "soft small", span)];
  if (e.prompt) {
    const det = el("details", "prompt");
    det.append(el("summary", null, "the prompt it was given"), el("p", null, e.prompt));
    kids.push(det);
  }
  els.source.replaceChildren(...kids);
}

function renderTokens() {
  const frag = document.createDocumentFragment();
  state.tokens.forEach((t, i) => {
    const span = el("span");
    span.dataset.i = i;
    if (t.bits == null || !t.text.trim()) {
      span.textContent = t.text;
    } else {
      // Shade the word itself and leave its leading space clear, so each token reads as a chip.
      const lead = t.text.length - t.text.trimStart().length;
      if (lead) span.append(t.text.slice(0, lead));
      const chip = el("i", null, t.text.slice(lead));
      chip.style.background = heatColor(t.bits, TOKEN_SCALE);
      span.append(chip);
    }
    frag.append(span);
  });
  return frag;
}

function renderPassages() {
  const frag = document.createDocumentFragment();
  let pos = 0;
  state.passages.forEach((p, pi) => {
    if (p.end <= p.start) return;
    if (p.start > pos) frag.append(state.text.slice(pos, p.start));
    const span = el("span", "p", state.text.slice(p.start, p.end));
    span.dataset.p = pi;
    if (p.shade != null) span.style.background = heatColor(p.shade, passageScale());
    frag.append(span);
    pos = p.end;
  });
  if (pos < state.text.length) frag.append(state.text.slice(pos));
  return frag;
}

function renderHeat() {
  els.heat.classList.toggle("tokens", state.view === "token");
  els.heat.replaceChildren(state.view === "token" ? renderTokens() : renderPassages());
  renderLegend();
}

function renderLists() {
  const eligible = state.passages
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.mean != null && p.n >= PASSAGE.listMinTokens);
  if (eligible.length < 6) { els.lists.replaceChildren(); return; }
  const n = Math.min(5, Math.floor(eligible.length / 2));
  const flat = eligible.slice().sort((a, b) => a.mean - b.mean).slice(0, n);
  const sharp = eligible.slice().sort((a, b) => b.mean - a.mean).slice(0, n);
  const col = (title, hint, rows) => {
    const d = el("div");
    d.append(el("h2", null, title), el("p", "hint", hint));
    const ol = el("ol");
    for (const p of rows) {
      const li = el("li");
      li.dataset.passage = p.i;
      li.title = "show in text";
      const num = el("span", "n", p.mean.toFixed(1));
      num.style.background = heatColor(p.mean, passageScale());
      li.append(num, el("span", "q", p.text.replace(/\s+/g, " ")));
      ol.append(li);
    }
    d.append(ol);
    return d;
  };
  els.lists.replaceChildren(
    col("most predictable passages", "candidates to cut or sharpen", flat),
    col("most surprising passages", "where the text adds the most", sharp));
}

function flashPassage(pi) {
  const p = state.passages[pi];
  if (!p) return;
  const spans = state.view === "token"
    ? Array.from(els.heat.children).slice(p.first, p.last + 1)
    : Array.from(els.heat.querySelectorAll(`span[data-p="${pi}"]`));
  if (!spans.length) return;
  spans[0].scrollIntoView({ behavior: "smooth", block: "center" });
  for (const span of spans) {
    span.classList.remove("flash");
    void span.offsetWidth;
    span.classList.add("flash");
  }
}

let tipFor = null;
function hideTip() {
  if (tipFor) tipFor.classList.remove("on");
  tipFor = null;
  els.tip.hidden = true;
}
function tokenTip(t) {
  const rank = t.rank === 1 ? "the model's first guess" : t.rank ? `guess #${t.rank}`
    : t.shelf ? "not its first guess" : `not in its top ${CONFIG.topK}`;
  const kids = [
    el("div", "tok", showToken(t.token || t.text)),
    el("div", "meta", `${fmtProb(t.lp)} likely · ${t.bits.toFixed(1)} bits · ${rank}`),
  ];
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
  return kids;
}

function passageTip(p) {
  const kids = [
    el("div", "tok", `${p.mean.toFixed(2)} bits per token`),
    el("div", "meta", `mean over this passage · ${p.n.toLocaleString()} tokens`),
  ];
  if (p.top.length) {
    const grid = el("div", "alts");
    grid.append(el("div", "h", "least expected here"));
    const max = p.top[0].bits || 1;
    for (const t of p.top) {
      const bar = el("div", "b");
      const fill = el("i");
      fill.style.width = `${Math.max(2, (t.bits / max) * 100)}%`;
      bar.append(fill);
      grid.append(el("div", "t", showToken(t.text)), el("div", "p", `${t.bits.toFixed(1)} bits`), bar);
    }
    kids.push(grid);
  }
  return kids;
}

function placeTip(r, cx) {
  const tw = els.tip.offsetWidth, th = els.tip.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const x = Math.max(8, Math.min(vw - tw - 8, cx - tw / 2));
  let y = r.top - th - 8;
  if (y < 8) y = r.bottom + 8;
  els.tip.style.left = `${x + window.scrollX}px`;
  els.tip.style.top = `${y + window.scrollY}px`;
}

// `point` is where the pointer is; a passage can span several lines, so its
// tooltip sits by the line being pointed at.
function showTip(span, point) {
  let kids = null;
  if (span.dataset.p != null) {
    const p = state.passages[Number(span.dataset.p)];
    if (p && p.mean != null) kids = passageTip(p);
  } else {
    const t = state.tokens[Number(span.dataset.i)];
    if (t && t.lp != null) kids = tokenTip(t);
  }
  if (!kids) { hideTip(); return; }
  if (tipFor) tipFor.classList.remove("on");
  tipFor = span;
  span.classList.add("on");
  els.tip.replaceChildren(...kids);
  els.tip.hidden = false;
  const rects = Array.from(span.getClientRects());
  const r = (point && rects.find((q) => point.y >= q.top - 1 && point.y <= q.bottom + 1))
    || rects[0] || span.getBoundingClientRect();
  placeTip(r, span.dataset.p != null && point ? point.x : r.left + r.width / 2);
}

function dotDoc(dot) {
  const tab = tabByKey(state.kind);
  const row = tab && tab.rows[Number(dot.dataset.row)];
  return row ? { row, doc: row.docs[Number(dot.dataset.doc)] } : null;
}
function showDotTip(dot) {
  const hit = dotDoc(dot);
  if (!hit) return;
  if (tipFor) tipFor.classList.remove("on");
  tipFor = dot;
  dot.classList.add("on");
  els.tip.replaceChildren(
    el("div", "tok", hit.doc[1]),
    el("div", "meta", `${hit.doc[0].toFixed(2)} bits per token · ${hit.row.label.toLowerCase()}`
      + (hit.doc[2] ? " · on the shelf, click to open" : "")));
  els.tip.hidden = false;
  const r = dot.getBoundingClientRect();
  placeTip(r, r.left + r.width / 2);
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
function clearHash() {
  if (location.hash.startsWith("#shelf/")) history.replaceState(null, "", location.pathname + location.search);
}
function showEditor(focus) {
  hideTip();
  state.shown = false;
  state.item = null;
  els.resultHead.hidden = true;
  els.resultBody.hidden = true;
  els.editor.hidden = false;
  renderChart();
  renderShelf();
  if (focus) els.text.focus();
}

// Puts a scored text on show: one the visitor just had scored, or one from the shelf.
function show(tokens, model, item) {
  const { text, passages, summary } = analyse(tokens);
  Object.assign(state, { text, tokens, passages, summary, model, item: item || null, shown: true });
  const kind = item ? item.tab : guessKind(text);
  if (tabByKey(kind)) state.kind = kind;
  renderSource();
  renderStats(summary);
  renderTabs(); renderChart(); renderShelf();
  renderHeat();
  renderLists();
  els.editor.hidden = true;
  els.resultHead.hidden = false;
  els.resultBody.hidden = false;
}

async function openShelf(id) {
  const item = LIBRARY.find((e) => e.id === id);
  if (!item || state.busy) return;
  hideTip();
  setStatus("loading…");
  try {
    const res = await fetch(`data/library/${encodeURIComponent(id)}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!location.hash.startsWith("#shelf/") || decodeURIComponent(location.hash.slice(7)) !== id) return;
    show(data.tokens.map(([text, lp, first]) => ({ text, token: text, lp, top: [], first, shelf: true })), BASE.scorer, item);
    setStatus(`scored ahead of time by ${shortModel(BASE.scorer)}.`);
    els.status.scrollIntoView({ block: "start" });
  } catch (err) {
    setStatus("Could not load that text. Check your connection and try again.", true);
  }
}

function route() {
  const m = /^#shelf\/(.+)$/.exec(location.hash);
  if (m) openShelf(decodeURIComponent(m[1]));
  else if (state.item) { setStatus(""); showEditor(false); }
}
function shortModel(m) { return (m || "").split("/").pop(); }

function explain(err) {
  if (!(err instanceof ApiError)) return "Could not reach the scoring service. Check your connection and try again.";
  if (err.code === "daily_cap") return "The shared scoring budget for today is used up. It resets at midnight UTC; or add your own Featherless key under settings.";
  if (err.code === "visitor_limit") return "Too many requests in a short time. Wait a minute and try again.";
  if (err.code === "proxy_key_rejected") return "The shared scoring key is not working. Add your own Featherless key under settings to keep going.";
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
  const key = ownKey || null;
  try {
    const { tokens, model } = await scoreText(text, key, state.abort.signal, (p) => {
      const part = p.windows > 1 ? ` part ${p.window + 1} of ${p.windows}` : "";
      const wait = p.attempt > 0 ? ", model is busy, retrying" : "";
      setStatus(`reading${part} with ${shortModel(p.model)}${wait}…`);
    });
    clearHash();
    show(tokens, model, null);
    const fb = model !== CONFIG.models[0]
      ? ` The usual model was busy, so this used ${shortModel(model)}; scores differ slightly between models.` : "";
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
  els.modelName.textContent = shortModel(BASE.scorer || CONFIG.models[0]);
  els.rulerIntro.textContent = "Each dot is one text, placed by the mean surprisal of its opening 500 or so words. "
    + "The bar spans the middle half of each group and the tick is its median. New texts were written after the scoring "
    + "model was trained, so it cannot have read them; older ones it may have. Ringed dots are on the shelf below.";
  els.aboutCount.textContent = `The chart and the colour scales rest on ${BASE.documents.toLocaleString()} texts scored by `
    + `${shortModel(BASE.scorer)}, last rebuilt on ${BASE.built}.`;
  const saved = store("entropic:text");
  if (saved) els.text.value = saved;
  const savedKey = store("entropic:key");
  if (savedKey) els.key.value = savedKey;
  updateCount();
  renderTabs(); renderChart(); renderShelf();

  els.text.addEventListener("input", updateCount);

  els.text.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
  });
  els.score.addEventListener("click", run);
  els.edit.addEventListener("click", () => { clearHash(); setStatus(""); showEditor(true); });
  els.tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kind]");
    if (b) setKind(b.dataset.kind);
  });
  els.shelfList.addEventListener("click", (e) => {
    const more = e.target.closest("button[data-expand]");
    if (more) { state.expanded[more.dataset.expand] = true; renderShelf(); }
  });
  els.chart.addEventListener("pointerover", (e) => {
    const dot = e.target.closest("i.d");
    if (dot) showDotTip(dot); else hideTip();
  });
  els.chart.addEventListener("pointerleave", hideTip);
  els.chart.addEventListener("click", (e) => {
    const dot = e.target.closest("i.d");
    const hit = dot && dotDoc(dot);
    if (hit && hit.doc[2]) location.hash = `#shelf/${hit.doc[2]}`;
    else if (dot) showDotTip(dot);
  });
  window.addEventListener("hashchange", route);
  els.perToken.checked = store("entropic:view") === "token";
  state.view = els.perToken.checked ? "token" : "passage";
  els.perToken.addEventListener("change", () => {
    state.view = els.perToken.checked ? "token" : "passage";
    store("entropic:view", els.perToken.checked ? "token" : null);
    hideTip();
    renderHeat();
  });
  els.key.addEventListener("change", () => store("entropic:key", els.key.value.trim() || null));
  els.keyClear.addEventListener("click", () => { els.key.value = ""; store("entropic:key", null); });

  // A mouse shows the tooltip on hover. A tap toggles it, and the mouse
  // events browsers synthesise after a tap are ignored.
  let tapped = false;
  els.heat.addEventListener("pointerdown", (e) => { tapped = e.pointerType !== "mouse"; });
  els.heat.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const span = e.target.closest("span[data-i], span[data-p]");
    if (span) showTip(span, { x: e.clientX, y: e.clientY });
  });
  els.heat.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideTip(); });
  els.heat.addEventListener("click", (e) => {
    if (!tapped) return;
    const span = e.target.closest("span[data-i], span[data-p]");
    if (span && span !== tipFor) showTip(span, { x: e.clientX, y: e.clientY }); else hideTip();
  });
  document.addEventListener("click", (e) => { if (!els.heat.contains(e.target) && !els.chart.contains(e.target)) hideTip(); });
  window.addEventListener("resize", hideTip);
  els.lists.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-passage]");
    if (li) flashPassage(Number(li.dataset.passage));
  });
  route();
}

init();
