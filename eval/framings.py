"""Candidate framings: the hidden text placed before the essay, per model.

F0 sends the essay alone. F1 adds the model's beginning-of-sequence token.
F2 opens a user turn in the model's official chat format and places the essay
in it. F3 adds a fixed one-line request and places the essay in the
assistant's reply. F2 and F3 strings were rendered from each model's published
chat template (Hugging Face repo, 2026-11-25) for a single user message with
thinking disabled; Kimi K3 publishes an encoder script rather than a template,
so only the template-free framings are defined for it.
"""

REQUEST = "Write a piece of text."

_GPT_OSS_SYSTEM = (
    "<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.\n"
    "Knowledge cutoff: 2024-06\nCurrent date: 2026-11-25\n\nReasoning: medium\n\n"
    "# Valid channels: analysis, commentary, final. Channel must be included for every message.<|end|>"
)

FRAMINGS = {
    "google/gemma-4-31B-it": {
        "F0": "",
        "F1": "<bos>",
        "F2": "<bos><|turn>user\n",
        "F3": "<bos><|turn>user\n" + REQUEST + "<turn|>\n<|turn>model\n<|channel>thought\n<channel|>",
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
        "F0": "",
        "F1": "<｜begin▁of▁sentence｜>",
        "F2": "<｜begin▁of▁sentence｜><｜User｜>",
        "F3": "<｜begin▁of▁sentence｜><｜User｜>" + REQUEST + "<｜Assistant｜></think>",
    },
    "openai/gpt-oss-120b": {
        "F0": "",
        "F1": "<|startoftext|>",
        "F2": _GPT_OSS_SYSTEM + "<|start|>user<|message|>",
        "F3": _GPT_OSS_SYSTEM + "<|start|>user<|message|>" + REQUEST
              + "<|end|><|start|>assistant<|channel|>final<|message|>",
    },
    "moonshotai/Kimi-K2.6": {
        "F0": "",
        "F1": "[BOS]",
        "F2": "<|im_user|>user<|im_middle|>",
        "F3": "<|im_user|>user<|im_middle|>" + REQUEST
              + "<|im_end|><|im_assistant|>assistant<|im_middle|><think></think>",
    },
    "moonshotai/Kimi-K3": {
        "F0": "",
        "F1": "[BOS]",
    },
}

# Pretrained reference, scored with the essay alone.
BASE_MODEL = "google/gemma-4-26B-A4B"
