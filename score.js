"use strict";

/*
Pure helpers for turning an echoed completion into per-token scores. Loaded by
the page and by scripts/measure.mjs.
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

  root.Entropic = { alignTokens, planWindows };
})(typeof window !== "undefined" ? window : globalThis);
