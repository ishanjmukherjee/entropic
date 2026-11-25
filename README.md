# entropic

Could an LLM have written your essay? Paste text in and see which tokens a
language model saw coming (green) and which it could not have
guessed (red).

Live at https://ishanjmukherjee.github.io/entropic/

## How it works

The page sends your text to a language model and reads back the
log-probability the model assigned to each token given everything before it.
Each token has a surprisal, `-log2(p)`: 0 bits means the model was certain,
10 bits means a one-in-a-thousand guess. Single tokens are noisy, so by
default the page shades passages of one to three sentences by their mean
surprisal; hovering a passage shows its mean and the tokens that drove it.
Ticking "per token" shades every token on its own, and hovering one shows
what the model expected instead. The summary reports mean surprisal in bits
per token and how often your token was the model's first guess.

The text is the entire prompt: no instructions, no chat formatting. The model
is `moonshotai/Kimi-K3` served by [Featherless](https://featherless.ai), with
`moonshotai/Kimi-K2.6` and `deepseek-ai/DeepSeek-V4-Flash` as fallbacks when
it is busy. These are instruction-tuned models used as plain next-token
predictors. That choice, and the choice of no hidden prompt, came out of a
preregistered evaluation on recent human writing; see
[eval/RESULTS.md](eval/RESULTS.md). A pretrained model would be the natural
fit, but the only one callable this way (`google/gemma-4-26B-A4B`) is rarely
available, and a direct comparison against it is still owed.

Two Featherless behaviours shape the request in `main.js`:

- Log-probabilities are only returned on streamed responses (`stream: true`);
  the non-streamed response has `logprobs: null`.
- Only some model backends honour `echo: true`, which returns log-probabilities
  for the prompt itself. With it, a whole essay is scored in one request.

Long texts are split into windows of about 24,000 characters, each sent with
4,000 characters of preceding context whose scores are discarded.

## Files

- `index.html`, `style.css`, `main.js`, `score.js`: the whole app; there is no
  build step and no server. `score.js` holds the pure helpers: token
  alignment, windowing, sentence splitting and passage grouping.
- `samples.js`: the three sample texts and their measured reference scores.
- `scripts/measure.mjs`: re-measures the reference scores. Run it after
  changing a sample or the model list, and paste its output into `samples.js`.
- `eval/`: the preregistration, corpus builder, runner and results for the
  model and prompt choice.

## Running locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## The API key

The Featherless key in `main.js` is public by design: a static page has
nowhere to hide it. It is a prepaid key with a small balance, and texts scored
with it are capped at 60,000 characters. Visitors can supply their own key
under "settings and privacy"; it is stored only in their browser.

## To do

- Add more writings to the baseline.
  - https://diffuse.one/
  - Claude's Constitution(s)
  - Frontier and neolab blog posts
  - Wikipedia and other encyclopedia articles
  - Andrej Karpathy's X posts
  - Aaron Swartz
  - Docs for code libraries
  - Guides/how-tos for products such as consumer electronics
  - Ben Kuhn
