"use strict";

/*
Sample texts for the "or try" buttons. They double as the reference points on
the result ruler, so REFERENCES below must be re-measured (scripts/measure.mjs)
whenever a sample or the scoring model changes.
*/
window.SAMPLES = {
  // Lincoln's Gettysburg Address (1863), public domain. Widely memorized by models.
  classic: `Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.

Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure. We are met on a great battle-field of that war. We have come to dedicate a portion of that field, as a final resting place for those who here gave their lives that that nation might live. It is altogether fitting and proper that we should do this.

But, in a larger sense, we can not dedicate -- we can not consecrate -- we can not hallow -- this ground. The brave men, living and dead, who struggled here, have consecrated it, far above our poor power to add or detract. The world will little note, nor long remember what we say here, but it can never forget what they did here. It is for us the living, rather, to be dedicated here to the unfinished work which they who fought here have thus far so nobly advanced. It is rather for us to be here dedicated to the great task remaining before us -- that from these honored dead we take increased devotion to that cause for which they gave the last full measure of devotion -- that we here highly resolve that these dead shall not have died in vain -- that this nation, under God, shall have a new birth of freedom -- and that government of the people, by the people, for the people, shall not perish from the earth.`,

  // Written by an LLM (Claude) when asked for a generic explainer.
  explainer: `Neural networks are a type of machine learning model inspired by the structure of the human brain. They consist of layers of interconnected nodes, or neurons, that process information and learn to recognize patterns in data.

At a high level, a neural network learns by adjusting its weights. Each connection between neurons has a weight that determines how much influence one neuron has on another. During training, the network makes a prediction, compares it to the correct answer, and calculates the error using a loss function. The goal of training is to minimize this loss.

To do this, the network uses an algorithm called backpropagation. Backpropagation works by calculating the gradient of the loss function with respect to each weight in the network. These gradients tell us how much each weight contributed to the error. An optimization algorithm, such as gradient descent, then updates the weights in the direction that reduces the loss.

This process is repeated many times over a large dataset. With each iteration, the network gets a little better at making predictions. Over time, the early layers learn to detect simple features, while deeper layers learn to combine them into more complex representations.

In summary, neural networks learn by making predictions, measuring how wrong they are, and gradually adjusting their weights to improve. This simple but powerful idea is the foundation of modern deep learning.`,

  // Written by a person: the original pitch for this tool.
  pitch: `Idea: "could an LLM have written your essay?" A tool for seeing how much of your essay an LLM could have written easily. I enjoy writing blog posts and essays, but fewer & fewer essays are worth writing now that Claude Opus is so good at explaining stuff. Fundamentally, base LLMs are next word predictors. This means we can create a web utility where you can paste in your essay, and it spits back a heatmap: green for the words which the LLM predicted as highly likely, red for those it couldn't predict. In practice, this means that if you write yet another explainer of how neural networks learn, your text will be highly green -- DeepSeek could've explained neural networks just as well. But if your post is an original perspective like why selling perfumes with banned ingredients like oakmoss is an actually feasible business (it is), it'll be redder: the essay is worth writing. This is a broadly useful editing tool.`,
};

// Mean surprisal of each sample, in bits per token, per scoring model.
window.REFERENCES = [
  {"model": "moonshotai/Kimi-K3", "sample": "classic", "bits": 0.08, "label": "memorized classic", "phrase": "the Gettysburg Address, which it has memorized"},
  {"model": "moonshotai/Kimi-K3", "sample": "explainer", "bits": 0.93, "label": "LLM explainer", "phrase": "an explainer written by an LLM"},
  {"model": "moonshotai/Kimi-K3", "sample": "pitch", "bits": 3.77, "label": "human pitch", "phrase": "a short pitch written by a person"},
  {"model": "moonshotai/Kimi-K2.6", "sample": "classic", "bits": 0.15, "label": "memorized classic", "phrase": "the Gettysburg Address, which it has memorized"},
  {"model": "moonshotai/Kimi-K2.6", "sample": "explainer", "bits": 1.16, "label": "LLM explainer", "phrase": "an explainer written by an LLM"},
  {"model": "moonshotai/Kimi-K2.6", "sample": "pitch", "bits": 4.08, "label": "human pitch", "phrase": "a short pitch written by a person"},
  {"model": "deepseek-ai/DeepSeek-V4-Flash", "sample": "classic", "bits": 0.07, "label": "memorized classic", "phrase": "the Gettysburg Address, which it has memorized"},
  {"model": "deepseek-ai/DeepSeek-V4-Flash", "sample": "explainer", "bits": 1.13, "label": "LLM explainer", "phrase": "an explainer written by an LLM"},
  {"model": "deepseek-ai/DeepSeek-V4-Flash", "sample": "pitch", "bits": 4.28, "label": "human pitch", "phrase": "a short pitch written by a person"},
];
