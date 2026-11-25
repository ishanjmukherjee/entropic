# Preregistration: can an instruction-tuned model stand in for a pretrained one?

Written and committed before any model scored any document in the evaluation
corpus. The git history of this file is the record.

## Question

entropic shades text by per-token surprisal from a pretrained language model.
The only pretrained model we can call that way (`google/gemma-4-26B-A4B` on
Featherless) is often at capacity. Instruction-tuned (IT) models are plentiful
and include much larger ones. Can an IT model, with at most a short hidden
prefix before the essay, serve as a predictor of ordinary human-written text?

## What had already been seen

- A toy sentence ("The quick brown fox...") scored with no prefix on each IT
  model, to check which models return prompt log-probabilities. Gemma 4 31B-it
  gave about -22 nats to " quick"; DeepSeek V4 Flash and gpt-oss looked sane.
- `gemma-4-31B-it` with no prefix on the site's three sample texts and on the
  opening of Pride and Prejudice: 6 to 16 bits per token, against 0.31 from the
  pretrained model on the latter. So "no prefix" is known to be bad for Gemma.
- Token strings (not probabilities) for each framing on the toy sentence, to
  confirm special tokens are parsed.

No document in the evaluation corpus had been sent to any model.

## Models

IT models on Featherless whose backend returns prompt log-probabilities:
`google/gemma-4-31B-it`, `deepseek-ai/DeepSeek-V4-Flash`, `openai/gpt-oss-120b`,
`moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K3`.

Reference: `google/gemma-4-26B-A4B` (pretrained), scored with no prefix, if it
has capacity while the evaluation runs.

## Framings

Exact strings are in `framings.py`. In order of increasing elaborateness:

- **F0** the essay alone.
- **F1** the model's beginning-of-sequence token, then the essay.
- **F2** the essay as the content of a user turn in the model's chat format.
- **F3** a user turn saying "Write a piece of text.", then the essay as the
  assistant's reply.

Kimi K3 gets F0 and F1 only: it publishes an encoder script instead of a chat
template, and it costs twenty times more than the others.

## Corpus

`build_corpus.py`: 60 documents dated 2026-11-11 or later (after every model's
release, so not memorized), 12 each from arXiv abstracts, newly created
Wikipedia articles, Hacker News comments, LessWrong posts, and personal blogs.
Within each source, candidates are ordered by the SHA-256 of their URL and the
first 12 kept; alternate documents go to dev and test. Each is cut to at most
3,000 characters at a sentence end. `corpus/manifest.json` lists them.

## Metric

Bits per character (bpc): total surprisal of the essay's tokens divided by the
characters those tokens cover, pooled over a split. Characters rather than
tokens so that models with different tokenizers are comparable. Lower means a
better predictor of this text. The essay's first token is excluded under every
framing, since under F0 some models give it no probability. Prefix tokens are
never counted.

Also reported, not used for selection: bpc per source, and the mean of
per-document bpc with a bootstrap 95% interval over documents.

## Selection rule, biased toward the simplest thing that works

1. For each model, find its best framing by dev bpc. Choose the
   lowest-numbered framing whose dev bpc is within 2% of that best.
2. The production candidate is the (model, chosen framing) with the lowest dev
   bpc. Among models within 2% of it, prefer the lower-numbered framing, then
   the cheaper model.
3. Score each model's chosen framing on the test split once and report it.
   Nothing about the framings changes after test results are seen.

## Comparison with the pretrained model

If the reference model is available: report its test bpc, the ratio of the
production candidate's test bpc to it, and the Spearman correlation between
the two models' per-word surprisal on the test split (a token's surprisal goes
to the word containing its first non-space character).

## Decision

- Reference available: switch the site to the production candidate if its
  test bpc is at most 1.10 times the reference's.
- Reference unavailable: switch provisionally if the candidate's test bpc is
  at most 1.0, a rough bar from memory of what small pretrained models reach
  on English prose, and state that the direct comparison is still owed.
- Otherwise the site stays on the pretrained model.

## Failures and limits

Requests are retried up to five times. A document that fails under any framing
of a model is dropped from all framings of that model, so comparisons stay
paired. A model that cannot complete 80% of the dev split is excluded.

Anything tried beyond this document will be labelled exploratory.
