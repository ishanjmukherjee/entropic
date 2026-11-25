"use strict";

/*
Pure helpers for turning an echoed completion into per-token scores and for
grouping those into passages. No DOM access: loaded by the page and, through
node:vm, by scripts.
*/
(function (root) {
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  // Token strings that are raw UTF-8 bytes shown as Latin-1 (a multi-byte
  // character split across tokens) decode back to text once complete.
  function decodeBytes(s) {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) return null;
      bytes[i] = c;
    }
    try { return utf8.decode(bytes); } catch (e) { return null; }
  }

  /*
  Turns one echoed response into [{text, token, lp, top}] covering `prompt`
  from `keepFrom` onward; everything before `keepFrom` (hidden prefix or
  carried-over context) is dropped, as are a leading special token and the one
  generated token after the prompt.

  Tokenizers that split a character across tokens report the pieces as empty
  strings, as Latin-1 byte fragments, or not at all. Such pieces are merged
  into one entry whose log-probability is the sum of its parts.
  */
  function alignTokens(prompt, lp, keepFrom) {
    const out = [];
    let pos = 0;
    let pending = null; // {lp, raw}: pieces seen but not yet matched to text
    const sum = (a, b) => (a == null || b == null ? null : a + b);
    const emit = (start, end, token, logprob, top) => {
      if (end > keepFrom) out.push({ text: prompt.slice(Math.max(start, keepFrom), end), token, lp: logprob, top });
    };
    const isFragment = (s) => /[\x80-\xff]/.test(s) && !/[^\x00-\xff]/.test(s);

    for (let i = 0; i < lp.tokens.length && pos < prompt.length; i++) {
      const tok = lp.tokens[i];
      const logprob = lp.token_logprobs[i] == null ? null : lp.token_logprobs[i];
      if (i === 0 && logprob == null && tok && !prompt.startsWith(tok)) continue;

      if (tok && prompt.startsWith(tok, pos)) {
        const top = !pending && lp.top_logprobs && lp.top_logprobs[i]
          ? Object.entries(lp.top_logprobs[i]).sort((a, b) => b[1] - a[1]) : [];
        emit(pos, pos + tok.length, tok, pending ? sum(pending.lp, logprob) : logprob, top);
        pos += tok.length;
        pending = null;
        continue;
      }
      if (!tok || isFragment(tok)) {
        pending = pending ? { lp: sum(pending.lp, logprob), raw: pending.raw + tok } : { lp: logprob, raw: tok };
        const decoded = pending.raw ? decodeBytes(pending.raw) : null;
        if (decoded && prompt.startsWith(decoded, pos)) {
          emit(pos, pos + decoded.length, decoded, pending.lp, []);
          pos += decoded.length;
          pending = null;
        }
        continue;
      }
      // Pieces went missing: resume where this token next appears, and give
      // the skipped text whatever probability the missing pieces carried.
      const at = prompt.indexOf(tok, pos);
      if (at < 0 || at - pos > 24) {
        pending = pending ? { lp: sum(pending.lp, logprob), raw: pending.raw } : { lp: logprob, raw: "" };
        continue;
      }
      emit(pos, at, prompt.slice(pos, at), pending ? pending.lp : null, []);
      const top = lp.top_logprobs && lp.top_logprobs[i]
        ? Object.entries(lp.top_logprobs[i]).sort((a, b) => b[1] - a[1]) : [];
      emit(at, at + tok.length, tok, logprob, top);
      pos = at + tok.length;
      pending = null;
    }
    if (pos < Math.min(prompt.length, keepFrom + 1) || prompt.length - pos > 24) {
      const err = new Error("the model did not return the full text");
      err.code = "no_echo";
      throw err;
    }
    if (pos < prompt.length) emit(pos, prompt.length, "", pending ? pending.lp : null, []);
    return out;
  }

  // Splits long text into windows that each carry a little preceding context.
  function planWindows(text, windowChars, contextChars) {
    const wins = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + windowChars);
      if (end < text.length) {
        const floor = start + Math.floor(windowChars * 0.7);
        const para = text.lastIndexOf("\n", end);
        const space = text.lastIndexOf(" ", end);
        if (para > floor) end = para; else if (space > floor) end = space;
      }
      let ctx = Math.max(0, start - contextChars);
      if (ctx > 0) {
        const brk = text.indexOf(" ", ctx);
        if (brk > 0 && brk < start) ctx = brk;
      }
      wins.push({ prompt: text.slice(ctx, end), keepFrom: start - ctx });
      start = end;
    }
    return wins;
  }

  const ABBREVIATIONS = new Set(("mr mrs ms dr prof st sr jr vs etc cf fig figs eq no nos vol ch sec ed eds " +
    "inc ltd co corp gen col lt sgt rev hon mt approx ca est al pp").split(" "));
  const SENTENCE_END = /([.!?…]+["'”’)\]]*)(\s+)|(\n\s*)|([。！？]+[」』”’]*\s*)/g;
  const SENTENCE_START = /[\p{Lu}\p{Lo}\p{N}"'“‘(\[—-]/u;
  const DOTTED_OR_INITIAL = /(?:^|[^\p{L}])(?:\p{L}\.)*\p{L}$/u;

  /*
  Splits text into sentences without Intl.Segmenter, so every browser and
  Node agree exactly. Returns [{start, end, para}]: the spans are contiguous
  and cover the text, whitespace after a sentence belongs to it, and `para`
  counts paragraphs (a blank line starts a new one). A line break always ends
  a sentence, which makes headings, list items and lines of verse sentences
  of their own.
  */
  function segmentSentences(text) {
    const out = [];
    let start = 0, para = 0, m;
    const cut = (end, newPara) => {
      if (end > start) out.push({ start, end, para });
      start = end;
      if (newPara) para++;
    };
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(text))) {
      const end = m.index + m[0].length;
      if (end >= text.length) break;
      const gap = m[2] || m[3] || "";
      if (gap.includes("\n")) { cut(end, /\n[ \t]*\n/.test(gap)); continue; }
      if (m[4]) { cut(end, false); continue; }
      if (!SENTENCE_START.test(text[end])) continue;
      if (m[1][0] === "." && m[1].length === 1 || /^\.["'”’)\]]+$/.test(m[1])) {
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        const word = (before.match(/\p{L}+$/u) || [""])[0];
        // "Dr. Smith", "J. K. Rowling" and "U.S. Army" do not end a sentence.
        if (ABBREVIATIONS.has(word.toLowerCase()) || DOTTED_OR_INITIAL.test(before)) continue;
      }
      cut(end, false);
    }
    cut(text.length, false);
    return out;
  }

  // How sentences are grouped into the passages the page shades. `prior` is
  // the weight, in tokens, with which a passage's shade is pulled towards the
  // document mean; `listMinTokens` is the shortest passage the page ranks.
  const PASSAGE = { minTokens: 40, maxSentences: 3, mergeUnder: 15, prior: 8, listMinTokens: 15 };

  /*
  Groups tokens ([{text, lp}], lp a natural-log probability or null) into
  passages: consecutive sentences of one paragraph, added until the passage
  has `minTokens` scored tokens or `maxSentences` sentences. A paragraph's
  last passage is folded into the one before it when it has fewer than
  `mergeUnder` tokens. Returns [{start, end, first, last, n, sum, mean,
  sentences}]: `first`..`last` are token indices (every token is in exactly
  one passage), `start`..`end` the character span from the passage's first
  to its last visible character, `n` the scored tokens, `sum` their surprisal
  in bits and `mean` = sum / n (null when n is 0).
  */
  function groupPassages(tokens, options) {
    const o = Object.assign({}, PASSAGE, options);
    const starts = [];
    let text = "";
    for (const t of tokens) { starts.push(text.length); text += t.text; }
    const sentences = segmentSentences(text).map((s) => ({ ...s, first: -1, last: -1, sum: 0, n: 0 }));
    let si = 0;
    tokens.forEach((t, i) => {
      // A token belongs to the sentence holding its first visible character;
      // pure whitespace stays with the sentence it follows.
      const lead = t.text.length - t.text.trimStart().length;
      const anchor = starts[i] + (lead < t.text.length ? lead : 0);
      while (si < sentences.length - 1 && anchor >= sentences[si].end) si++;
      const s = sentences[si];
      if (s.first < 0) s.first = i;
      s.last = i;
      if (t.lp != null) { s.sum += Math.max(0, -t.lp / Math.LN2); s.n++; }
    });
    const out = [];
    let cur = null, paraStart = 0, para = -1;
    const close = () => { if (cur) { out.push(cur); cur = null; } };
    const endParagraph = () => {
      close();
      if (out.length - paraStart >= 2 && out[out.length - 1].n < o.mergeUnder) {
        const tail = out.pop();
        const prev = out[out.length - 1];
        prev.last = tail.last; prev.sum += tail.sum; prev.n += tail.n; prev.sentences += tail.sentences;
      }
      paraStart = out.length;
    };
    for (const s of sentences) {
      if (s.first < 0) continue;
      if (s.para !== para) { endParagraph(); para = s.para; }
      if (!cur) cur = { first: s.first, last: s.last, sum: 0, n: 0, sentences: 0 };
      cur.last = s.last; cur.sum += s.sum; cur.n += s.n; cur.sentences++;
      if (cur.n >= o.minTokens || cur.sentences >= o.maxSentences) close();
    }
    endParagraph();
    for (const p of out) {
      const a = starts[p.first];
      const raw = text.slice(a, starts[p.last] + tokens[p.last].text.length);
      p.start = a + (raw.length - raw.trimStart().length);
      p.end = p.start + raw.trim().length;
      p.mean = p.n ? p.sum / p.n : null;
    }
    return out;
  }

  root.Entropic = { alignTokens, planWindows, segmentSentences, groupPassages, PASSAGE };
})(typeof window !== "undefined" ? window : globalThis);
