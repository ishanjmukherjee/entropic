# Notes for agents working on entropic

entropic is a static page (GitHub Pages, no build step) that shades a pasted
text by how predictable each passage was to a language model. This file says
how the pieces fit, what state the baseline study is in, and what remains.
Read `README.md` for the product and `baselines/PLAN.md` for the study design.

## Ground rules from the owner

- No API key may appear in the page, the repository or a commit. A key that
  shipped in `main.js` was scraped and had to be revoked. Keys live in files
  outside the repo and in the Worker's secret store.
- Never delete collected source texts, raw downloads or collection scripts
  until the owner says the project is finished. They are needed to reproduce
  the numbers. They are also never committed: the repository holds metadata
  and scores only, plus the texts generated for this study.
- Model and prompt choices are settled by evaluations whose candidates,
  metric and selection rule are committed before anything is scored, and the
  simplest option within noise wins. Do not drop or replace a document because
  of its score; drops need a stated mechanical reason (`baselines/PLAN.md`).
- Generate Claude texts with headless `claude -p` using Opus or Haiku, not
  Fable. Collectors may run on Opus.
- YouTube captions and speech-to-text are on hold.
- Commit and push to `main` directly. No co-author or "generated with" lines.

## How the site works

- `index.html`, `style.css`, `main.js`, `score.js`, `samples.js`: the page.
  `score.js` holds the pure helpers (token alignment, windowing, sentence and
  passage grouping) and is also loaded by the Node scripts in `baselines/`,
  so the study measures exactly what the page shows.
- `worker/`: the Cloudflare Worker at
  `https://entropic-proxy.ishanjmukherjee.workers.dev/score`. It holds the
  Featherless key as the secret `FEATHERLESS_KEY`, accepts `{model, prompt}`
  only from the site's origin (and `http://localhost:8000`), allows the two
  Kimi models, caps a request at 30,000 characters, limits each visitor to
  about 20 requests a minute (loosely enforced) and all visitors to
  `DAILY_CHAR_BUDGET` characters a day. Deploy with
  `CLOUDFLARE_API_TOKEN=... npx wrangler deploy` from `worker/`; set the key
  with `npx wrangler secret put FEATHERLESS_KEY`. `wrangler login` does not
  work on a remote machine; use an API token.
- A visitor's own key, if entered, calls Featherless directly from the browser.

Featherless behaviours that shape everything:

- Per-token log-probabilities come back only on streamed responses.
- `echo: true` (log-probabilities for the prompt itself) works only on some
  backends. Kimi K3 and Kimi K2.6 support it.
- `deepseek-ai/DeepSeek-V4-Flash` started returning nonsense log-probabilities
  on 2026-11-25 (about -40 to -120 per token on memorised text). It was
  removed from the page. Check it before using it again.
- Scoring is not deterministic: the mean moves by about 0.01 bits per token
  between runs.
- Kimi K3 costs $3 per million input tokens: about $0.002 per 3,000-character
  excerpt.

## The baseline study

Question: what does a score mean? The study scores human and model writing of
many kinds with Kimi K3, the way the page does. "Post" texts were first
published on or after 2026-08-01 (after the model's weights were released);
"pre" texts before 2025-07-01.

Pipeline, all under `baselines/`:

1. Collect human texts into a corpus directory outside the repo, following
   `COLLECTING.md`, through the helper `bl.py` (`BL_ROOT=<corpus>`). Each group
   has `manifests/<group>.jsonl` and `texts/<group>/<id>.txt`.
2. Check a group: `python3 -I baselines/check_corpus.py <corpus> <group>`.
   It flags likely boilerplate, markup, hard wrapping and truncation; most
   flags are false alarms but each should be looked at.
3. Generate model texts: `python3 baselines/generate.py` (needs
   `FEATHERLESS_API_KEY` and `OPENROUTER_API_KEY`; `--dry` lists what is not
   yet generated). Prompts live in that file and in `matched.json`. Outputs
   are committed under `generated/`. One sample per prompt; a refusal or a
   truncated output is moved to `generated/failed/` and regenerated once.
4. Score: `node baselines/score_corpus.mjs --root <corpus or baselines/generated>
   --cache <corpus>/scores --model moonshotai/Kimi-K3 [--groups a,b] --floor 0.4`.
   Results are cached per document, so reruns only score what is missing. The
   cache contains token text and stays outside the repo. `--floor` stops
   scoring when the Featherless balance falls to that many dollars.
5. `node baselines/metrics.mjs --roots <corpus>,baselines/generated --cache
   <corpus>/scores --out baselines/results/docs.jsonl`, then
   `node baselines/analyze.mjs` prints the tables.

### Where the corpus is

The corpus was collected on the exe.dev VM `fire-lightrail`. A copy of
everything needed (texts, manifests, score cache, collection scripts, raw
downloads) is at `~/entropic-corpus-2026-11-25.tar.gz` on that VM; the working
copy is under `/tmp` there and a reboot clears `/tmp`. To work elsewhere, copy
the archive over, unpack it, and use the unpacked `bl/` directory as the
corpus. Raw downloads for the groups collected first (`blogs-tech`,
`blogs-biz`, `indist`, `transcripts`, `code-human`, and the early parts of
`lw-ea` and `news-mags`) were deleted before the keep-everything rule; their
scripts and source URLs remain.

### State on 2026-11-25

| Group | What it is | Texts | Post | Pre | Scored by Kimi K3 |
|---|---|---|---|---|---|
| `blogs-tech` | Goedecke, Willison, Luu, McKenzie, Dynomight, Leech, Potter, Lowe | 43 | 19 | 24 | 43 |
| `blogs-biz` | Hobart, Levine, Graham, Collison, SemiAnalysis, Mahajan, Asianometry | 37 | 16 | 21 | 37 |
| `blogs-acad` | Caplan, Friedman, Huemer, Aaronson, Nielsen, Carlini, Amodei, Epoch AI, METR | 49 | 23 | 25 | 49 |
| `lw-ea` | Yudkowsky, Wentworth, Nanda, Bostrom, Sandberg, Ord, MacAskill | 42 | 14 | 28 | 42 |
| `indist` | Ebert, Christiano, Shulman, Karnofsky, Olah, Distill, Goh | 40 | 0 | 40 | 40 |
| `fame` | Shakespeare, Hume, Clarke, Didion, Wallace, Egan | 38 | 1 | 37 | 38 |
| `news-mags` | Reuters, AP; Atlantic, New Yorker, Works in Progress, Asterisk, Quanta, Aeon | 54 | 34 | 20 | 54 |
| `transcripts` | 3Blue1Brown, Every Frame a Painting, McEvoy, Acquired, Approved, Asianometry | 35 | 13 | 22 | 35 |
| `verse-human` | 40 poems and 24 songs | 64 | 26 | 38 | 64 |
| `fiction-plays` | fiction, plays, screenplays | 52 | 16 | 36 | 52 |
| `code-human` | 42 files from before 2021, 28 post files from projects that ban AI-written code | 70 | 28 | 42 | 70 |
| `prized-ai` | AI writing that people singled out | 23 | 7 | 16 | 23 |
| `papers` | academic papers | see below | | | 0 |
| `gen-essay` | generated essays | 220 | | | 120 |
| `gen-poem`, `gen-song`, `gen-fiction`, `gen-play` | generated creative writing | 297 | | | 169 |
| `gen-code` | generated code | 106 | | | 39 |
| `gen-paper` | generated paper introductions | 18 | | | 0 |

Every human group above except `papers` and `prized-ai` was reported complete
by its collector and passed the mechanical check plus a spot read. `prized-ai`
was stopped before its final self-check. Scoring stopped when the Featherless
balance reached the $0.40 kept for the public site.

Interim numbers (Kimi K3, bits per token, first 3,000 characters), not yet
written up and subject to change as scoring completes: human essays published
since August 2026, median 2.92 (n=64); generated essays from a one-line
prompt, 1.49 (n=84); from a prompt asking for a distinctive voice, 2.31
(n=36); best-known pieces by essayists the model has seen, 1.90 (n=30), with
many near 0.1.

### What remains, in order

1. Top up Featherless (about $2 covers the rest of the scoring) and score what
   is unscored: `papers`, and under `baselines/generated` the texts from the
   OpenRouter models (`gpt-6.2-astra`, `gpt-6.2-sol`, `gemini-4-neon`,
   `grok-4.7`) and from Claude Opus and Haiku, including all matched essays,
   all paper introductions and most code.
2. `papers`: read the collector's report or rerun the check, then score.
3. A second scorer for robustness. DeepSeek V4 Flash scored about 390
   documents before it broke; three of those cached scores are garbage (mean
   above 40 bits) and must be dropped. Kimi K2.6 ($0.80 per million tokens) is
   the natural replacement. `metrics.mjs` has the list of scorers in `CONFIGS`.
4. Length: score the first 12,000 characters of a mechanically chosen subset
   with Kimi K3 (`--chars 12000`) to show how the running mean falls with
   length. `metrics.mjs` already records running means at checkpoints.
5. Format experiment: `format_variants.mjs` builds variants (hard wrap, quote
   style, title line, lower case, caption-style, typos, unlineated verse) of
   chosen documents; score them and compare total bits per document. Choose
   the base documents by a stated rule before scoring.
6. Write `baselines/RESULTS.md` from `analyze.mjs`, answering the nine
   questions in `PLAN.md`, with what is and is not shown. Extend `analyze.mjs`
   where a question has no table yet (scorer self-preference, matched topics,
   prized against routine AI writing, passage-level spread).
7. Rebuild the page's ruler and passage colour scale from the results:
   replace `REFERENCES` in `samples.js` and `SCALES.passage` in `main.js`,
   retire the "human pitch" sample, and update the "how to read this" copy.
   `scripts/measure.mjs` re-measures the sample texts.
8. The comparison against a pretrained model promised in `eval/RESULTS.md` is
   still owed; `google/gemma-4-26B-A4B` never had capacity.
9. More human writing, listed under "To do" in `README.md`.

### Gaps a browser session can fill

Collectors ran without a browser and were blocked in places:

- `archive.ph` was unreachable throughout; the Wayback Machine intermittently.
- Paywalled or bot-walled sources: Bloomberg (Matt Levine's pre dates come from
  Hacker News submission URLs), The Atlantic and The New Yorker (texts came
  from Wayback captures), apnews.com (texts came from syndication partners),
  science.org, rogerebert.com, the EA Forum, Genius, Harper's.
- Missing pieces: Asianometry post essays (its site is member-gated), a third
  post piece for Mahajan (paid), Patrick McKenzie post pieces (none exist
  yet), Greg Egan's "Learning to Be Me", lesser-known Wallace pieces from
  Harper's, post screenplays from studio awards sites (one found had no text
  layer), BBC Writersroom scripts (skipped because its terms forbid automated
  analysis; the owner may overrule).
- X posts were taken from authors' own archives where possible; Yudkowsky has
  two, Collison's come from his site.
- Transcripts: Benjamin McEvoy's videos have only automatic captions, flagged
  `captions-auto` and reported separately.

### Known weak spots in the data

- `amodei-post-big-blob-of-compute` is OCR of a scanned memo written in 2017
  and first published in 2026; it is "post" by publication date.
- `carlini-best-paper-award` (2026-03-09) falls between the two windows and is
  kept only because it was requested.
- Texts with inline mathematics (Goh, Distill, Egan's science notes) carry TeX
  or flattened notation.
- Post code rests on project policies against AI-written code, not on
  statements by the individual authors.
- Possible undisclosed AI assistance is noted on `gleech-emergence`,
  `davis-prince-and-a-princess-screenplay` and the Bandcamp song by Sans Cri.
- Some SemiAnalysis pieces are the free portion of a paid post.

## Budgets and credentials

- Featherless: about $0.40 left on the owner's key on 2026-11-25. The public
  page spends from the same balance through the Worker.
- OpenRouter: the owner's key has a $50 limit; generation used about $7.
- On the VM the keys are in `~/.featherless_token`, `~/.openrouter_token` and
  `~/.cloudflare_token`. Read them into environment variables at run time.
