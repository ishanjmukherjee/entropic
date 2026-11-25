# Baselines: what does a surprisal score mean?

Written on 2026-11-25, before any baseline text was scored. The site reports
mean surprisal in bits per token from `moonshotai/Kimi-K3`. A number like 3.1
means little without reference points. This study collects them: how
predictable is writing by people and by language models, across genres, and
how much do training-data exposure, text format and length move the score?

It is descriptive. The earlier model choice ([../eval](../eval)) is not
revisited here.

## Scoring

- Scorer: `moonshotai/Kimi-K3`, the text alone as the prompt, exactly as the
  site does it, using the site's own aligner (`score.js`).
- Each document is scored on its first 3,000 characters, cut back to a
  paragraph break (or line break for verse and code, or sentence end) when one
  falls in the last third. Shorter texts are scored whole. Texts are stored
  from the beginning of a piece, chapter or scene.
- Reported per document: mean bits per token (the site's number), bits per
  character, share of tokens that were the model's first guess, and the spread
  of passage-level means (passages of one to three sentences, as the site
  shows them). The first token is excluded.
- Robustness: every excerpt is also scored by `deepseek-ai/DeepSeek-V4-Flash`.
  Length: DeepSeek scores the first 12,000 characters of every text that long,
  and Kimi K3 does so for a small mechanically chosen subset, to show how the
  running mean changes with length.

Kimi K3 was announced on 2026-07-16 and its weights released on 2026-07-27.
"Post" texts were first published on or after 2026-08-01, so the model cannot
have trained on them. "Pre" texts were first published before 2025-07-01.

## Corpora

Human texts are collected to a written spec (clean body text only, dates
verified on the page, no selection by quality; "most recent" or a stated
mechanical rule decides what is taken). Source texts are evaluated privately
and are not published; the repository holds metadata and scores only.

1. Named essayists, bloggers and newsletter writers: for each, the three most
   recent post pieces and three pre pieces spanning well-known to obscure.
2. Wire news (Reuters, AP) and longform magazines, post and pre.
3. Transcripts of scripted video essays and podcasts, post and pre.
4. Writers almost wholly inside the training data, with pieces of varying
   fame; and authors of varying fame from Shakespeare to living novelists.
5. Poems, songs, fiction, plays and screenplays, from canonical to new.
6. Academic papers across disciplines, by ordinary and distinctive writers.
7. Human code: from before 2021, and post files from projects or authors with
   a stated no-AI position.
8. AI writing that people singled out as unusually good.

Language-model texts are generated for this study, with prompts fixed before
any output is scored and one sample per prompt, never regenerated to taste
(only for outright failures: refusals, empty or truncated output):

9. Essays from several model families through Featherless, plus Claude
   through `claude -p`. Prompts are of two kinds: general prompts across
   genres, and prompts matched to human post essays (the model gets that
   essay's title and a one-sentence statement of its subject). Each prompt
   exists in a minimal form and, for a subset, in an elaborate form that asks
   for a distinctive voice.
10. Poems, songs, fiction and plays from Claude and from the Featherless
    models with the best creative-writing reputation, with a minimal prompt
    and with a carefully written one.
11. Code for a fixed list of tasks across domains, and paper introductions
    matched to titles of human post papers.

Prompts and model outputs are committed to the repository.

## Questions, and how each will be answered

1. Where does prompted model writing sit? Distribution of document means for
   generated essays, by model family and prompt style.
2. Does the score separate people from models? Human post essays against
   generated essays, both unseen by the scorer: medians, overlap, and the area
   under the ROC curve for the document mean, overall and for matched topics.
3. Is the scorer biased toward its own family? Kimi-generated text against
   other families' text on the same prompts, under both scorers.
4. What does training exposure do? Within author, post against pre, and pre
   by popularity tier; canonical works against obscure ones.
5. How does genre move the score? Human post texts by kind.
6. How much is format? The same content under controlled transformations
   (hard-wrapped lines, markdown markup, straight against curly quotes, a
   title line, all lower case, stripped punctuation as in automatic captions,
   single against double line breaks), compared by total bits for the
   document.
7. Is prized AI writing less predictable than routine output?
8. Code: human against model, old against new.
9. How does length change the mean?

Medians and interquartile ranges are reported with document counts; intervals
come from bootstrapping documents. Groups under five documents are shown but
not interpreted.

## Rules fixed in advance

- A document is dropped only for a stated mechanical reason: it fails the
  spec on inspection (boilerplate, truncation, wrong author, unverifiable
  date), or the scorer cannot align it. Drops are listed. No document is
  dropped or replaced because of its score.
- Transcripts made from automatic captions are reported separately.
- Texts dated between 2025-07-01 and 2026-07-31 are not used for post or pre
  comparisons.
- The site's reference ruler will be rebuilt from these results. The
  one-paragraph human sample it used is retired.

## Known limits

- One scorer family decides the headline numbers; Kimi K3's training data and
  cutoff are not public, so "pre" means "plausibly seen", not "seen".
- Human post texts in 2026 may include undisclosed model assistance. Authors
  were chosen for writing in their own voice, and disclosed assistance is
  recorded, but this cannot be ruled out.
- Excerpts are about 500 words. Per-document means are noisy; group
  comparisons are the unit of analysis.
