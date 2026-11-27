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
  the numbers. They live in the private repository
  `ishanjmukherjee/entropic-corpus` and are never committed here. This
  repository holds metadata, scores and the texts generated for the study,
  plus the scored openings shown on the page's shelf. The owner allows
  reproducing those for heatmaps for every text, including pieces from
  paywalled outlets, except three sorts of commercial work: song lyrics from
  commercial releases, books still in copyright and studio screenplays.
  `baselines/library.json` lists the texts withheld for those reasons; a new
  text of one of those sorts must be added there before the site is rebuilt.
- Green means more surprising and red means less. The owner set this; do not
  flip it back.
- Model and prompt choices are settled by evaluations whose candidates,
  metric and selection rule are committed before anything is scored, and the
  simplest option within noise wins. Do not drop or replace a document because
  of its score; drops need a stated mechanical reason (`baselines/PLAN.md`).
- Generate Claude texts with headless `claude -p` using Opus or Haiku, not
  Fable. Collectors may run on Opus.
- YouTube captions and speech-to-text are on hold.
- Commit and push to `main` directly. No co-author or "generated with" lines.

## How the site works

- `index.html`, `style.css`, `main.js`, `score.js`: the page.
  `score.js` holds the pure helpers (token alignment, windowing, sentence and
  passage grouping, the opening excerpt) and is also loaded by the Node
  scripts in `baselines/`, so the study measures exactly what the page shows.
- `data/`: written by `baselines/build_site.mjs`, never by hand.
  `baselines.js` has, for each kind of writing, the rows of the "where texts
  land" chart (one value per reference text) and the passage colour scale
  derived from them. `library.js` lists the shelf, and `library/<id>.json`
  holds each shelf text's tokens and log-probabilities, which the page loads
  instead of calling the scoring service. A shelf text opens at
  `#shelf/<id>`.
- A pasted text is compared on its opening 3,000 characters, cut the same way
  as the reference texts, with the first token left out. `guessKind` in
  `main.js` picks the tab; it is a rough rule.
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
6. `node baselines/build_site.mjs --roots <corpus>,baselines/generated --cache
   <corpus>/scores` rebuilds `data/` for the page. Rerun it whenever scores or
   `library.json` change, then load the page and look at each tab.

### Where the corpus is

In the private repository `ishanjmukherjee/entropic-corpus`, as plain files
under `bl/`: texts, manifests, the score cache, collection scripts and the raw
downloads that were kept. Clone it and use its `bl/` directory as the corpus
(`BL_ROOT`, `--root`, `--cache bl/scores`). Commit new texts and new cached
scores there. Left out because they can be reinstalled: the collectors'
virtualenv and vendored copies of PyMuPDF and Tesseract. Raw downloads for the
groups collected first (`blogs-tech`, `blogs-biz`, `indist`, `transcripts`,
`code-human`, and the early parts of `lw-ea` and `news-mags`) were deleted
before the keep-everything rule; their scripts and source URLs remain.

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
| `papers` | academic papers: famous, ordinary, and by distinctive stylists, across twelve disciplines | 61 | 26 | 35 | 0 |
| `gen-essay` | generated essays | 220 | | | 120 |
| `gen-poem`, `gen-song`, `gen-fiction`, `gen-play` | generated creative writing | 297 | | | 169 |
| `gen-code` | generated code | 106 | | | 39 |
| `gen-paper` | generated paper introductions | 18 | | | 0 |

Every human group above except `prized-ai` was reported complete by its
collector and passed the mechanical check plus a spot read. `prized-ai` was
stopped before its final self-check. In `papers`, the check flags
`berger-sweden-mobility` for garbled characters; that file has not been looked
at. Scoring stopped when the Featherless
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
2. `papers`: fix or drop `berger-sweden-mobility`, then score the group. Its
   collector skipped papers that declare AI help in the writing (recorded in
   `notes`), which removed Terence Tao's and John Baez's recent pieces.
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
7. The page's chart, colour scales and shelf are built from the results as
   they stood on 2026-11-26 (875 documents). After more scoring, rerun
   `build_site.mjs`; new kinds such as papers appear as tabs once they have a
   row of new human texts and a row of model texts. Then update the paragraph
   in `index.html` ("about the reference texts") that says which groups are
   not scored yet. Newly scored texts go on the shelf by themselves unless
   `library.json` withholds them.
8. The shelf shows only the opening 3,000 characters of each text, because
   that is all that has been scored. The owner allows full texts of the
   writing on the shelf; scoring a full essay costs about $0.02 to
   $0.05. `score_corpus.mjs --chars` sets the length; `build_site.mjs`
   reads only the `c3000` cache and needs changing to match.
9. The comparison against a pretrained model promised in `eval/RESULTS.md` is
   still owed; `google/gemma-4-26B-A4B` never had capacity.
10. More human writing, listed under "To do" in `README.md`.

### Gaps a browser session can fill

Collectors ran without a browser and were blocked in places:

- `archive.ph` was unreachable throughout; the Wayback Machine intermittently.
- Paywalled or bot-walled sources: Bloomberg (Matt Levine's texts are the
  first section of the free email edition, from newsletterhunt.com; his pre
  dates come from Hacker News submission URLs), The Atlantic (the site
  returned 403, so texts came from Wayback captures), The New Yorker (fetched
  from newyorker.com, where the article body was in the page HTML or its
  JSON-LD), apnews.com (texts came from syndication partners), science.org,
  rogerebert.com, the EA Forum, Genius, Harper's (its free web excerpt).
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
- GitHub: the corpus repository is private and about 240 MB.
- On the VM the keys are in `~/.featherless_token`, `~/.openrouter_token` and
  `~/.cloudflare_token`. Read them into environment variables at run time.
