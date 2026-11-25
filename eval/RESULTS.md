# Results: instruction-tuned models as plain text predictors

Run on 2026-11-25 following [PREREGISTRATION.md](PREREGISTRATION.md), which was
committed before any corpus document was scored. All numbers are bits per
character (bpc) on human-written text dated 2026-11-11 or later; lower means a
better predictor. Summaries are in `results/dev.json` and `results/test.json`.

## Outcome

- The simplest framing won. For the three models that predict text well, the
  essay alone (F0, no hidden prompt, no chat formatting) was within 2% of the
  best framing, so the rule selected it for each.
- The production candidate is `moonshotai/Kimi-K3` with F0: 0.636 bpc on dev,
  0.714 on test.
- The pretrained reference (`google/gemma-4-26B-A4B`) was at capacity for the
  whole run, so the head-to-head comparison is **still owed**. Under the
  preregistered fallback (test bpc at most 1.0) the site switches to the
  candidate provisionally.

## Dev split (30 documents)

| Model | F0 essay alone | F1 + BOS token | F2 in a user turn | F3 as assistant reply | Chosen |
|---|---|---|---|---|---|
| Kimi K3 | 0.636 | **0.635** | not run | not run | F0 |
| Kimi K2.6 | 0.702 | **0.694** | 0.806 | 0.703 | F0 |
| DeepSeek V4 Flash | 0.741 | **0.728** | 0.748 | 0.748 | F0 |
| gpt-oss-120b | **1.141** | 1.482 | 2.822 | 3.741 | F0 |
| Gemma 4 31B-it | 2.504 | 2.546 | 3.016 | **1.163** | F3 |

Bold is each model's best; "chosen" is the lowest-numbered framing within 2%
of it. Bootstrap 95% intervals on the per-document mean are about ±0.05 bpc
for the first three models, so differences between their framings are small
next to document-to-document variation, while the gaps between models are
consistent across sources.

## Test split, each model's chosen framing, scored once

| Model | Framing | Test bpc | Same 29 documents | Bits per token |
|---|---|---|---|---|
| Kimi K3 | F0 | 0.714 (29 docs) | 0.714 | 3.44 |
| Kimi K2.6 | F0 | 0.774 (29 docs) | 0.774 | 3.72 |
| DeepSeek V4 Flash | F0 | 0.813 | 0.817 | 3.89 |
| gpt-oss-120b | F0 | 1.236 | 1.222 | 5.97 |
| Gemma 4 31B-it | F3 | 1.253 | 1.251 | 5.82 |

One test document (`blogs-01`) failed on both Kimi models and was dropped for
them, as preregistered: their tokenizer split a multi-byte character across
tokens and the evaluation's aligner rejected the response. The "same 29
documents" column recomputes every model without that document so the
comparison is paired. The ranking is the same on dev and test, and within
every source.

Test bpc by source, on the 29 shared documents:

| Model | arXiv | blogs | Hacker News | LessWrong | Wikipedia |
|---|---|---|---|---|---|
| Kimi K3 | 0.676 | 0.693 | 0.852 | 0.743 | 0.567 |
| Kimi K2.6 | 0.751 | 0.756 | 0.900 | 0.800 | 0.622 |
| DeepSeek V4 Flash | 0.804 | 0.810 | 0.929 | 0.842 | 0.657 |
| gpt-oss-120b | 0.899 | 1.432 | 1.232 | 1.362 | 0.937 |
| Gemma 4 31B-it | 1.252 | 1.295 | 1.358 | 1.248 | 1.052 |

## What this does and does not show

Shown: on text no model can have memorized, Kimi K3, Kimi K2.6 and DeepSeek V4
Flash given raw text assign it high probability (0.7 to 0.8 bpc), and chat
formatting does not help them. Gemma 4 31B-it and gpt-oss-120b are poor raw
text predictors under every framing tried; for Gemma the assistant-reply
framing helps a great deal but still leaves it far behind.

Not shown:

- That these models match a pretrained model token for token. The reference
  model never had capacity, so there is no bpc ratio and no per-word
  correlation yet. `python3 run_eval.py --split test --base` produces the
  reference numbers when it does.
- That low surprisal from these models means "an LLM would have written this".
  The metric here is prediction of human text. Whether instruction tuning
  makes assistant-style prose look more predictable than a pretrained model
  would find it is exactly what the owed comparison would reveal.
- Anything about texts longer than 3,000 characters, or languages other than
  English.

## Notes

- The Featherless backend is not deterministic: rescoring the same text moves
  the mean by about 0.01 bits per token.
- Kimi K3 costs $3 per million input tokens, against $0.80 for Kimi K2.6 and
  $0.14 for DeepSeek V4 Flash. K2.6 is 8% worse on test bpc and DeepSeek 14%
  worse. The site uses K3 and falls back to the other two, in that order,
  when a model is busy.
- Kimi K3 was scored under F0 and F1 only, as preregistered.
- The site's aligner (`score.js`) was fixed afterwards to merge split
  characters; the evaluation numbers above were not rerun with it.
