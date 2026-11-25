# entropic

Could an LLM have written your essay? Paste text in and see which tokens a
pretrained language model saw coming (green) and which it could not have
guessed (red).

Live at https://ishanjmukherjee.github.io/entropic/

## How it works

The page sends your text to a pretrained, non-chat model and reads back the
log-probability the model assigned to each token given everything before it.
Each token is shaded by its surprisal, `-log2(p)`: 0 bits means the model was
certain, 10 bits means a one-in-a-thousand guess. The summary reports mean
surprisal in bits per token and how often your token was the model's first
guess. Hovering a token shows what the model expected instead.

The model is `google/gemma-4-26B-A4B` served by
[Featherless](https://featherless.ai), with `google/gemma-4-E4B` as a smaller
pretrained fallback when the first is at capacity.

Two Featherless behaviours shape the request in `main.js`:

- Log-probabilities are only returned on streamed responses (`stream: true`);
  the non-streamed response has `logprobs: null`.
- Only some model backends honour `echo: true`, which returns log-probabilities
  for the prompt itself. With it, a whole essay is scored in one request.
  Models whose backend ignores `echo` (the Llama, Qwen, and Mistral base models
  at the time of writing) would need one request per token.

Long texts are split into windows of about 24,000 characters, each sent with
4,000 characters of preceding context whose scores are discarded.

## Files

- `index.html`, `style.css`, `main.js`: the whole app; there is no build step
  and no server.
- `samples.js`: the three sample texts and their measured reference scores.
- `scripts/measure.mjs`: re-measures the reference scores. Run it after
  changing a sample or the model list, and paste its output into `samples.js`.

## Running locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## The API key

The Featherless key in `main.js` is public by design: a static page has
nowhere to hide it. It is a prepaid key with a small balance. Visitors can
supply their own key under "settings and privacy"; it is stored only in their
browser.
