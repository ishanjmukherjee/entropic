"""Scores corpus documents under each (model, framing) and summarises bpc.

    FEATHERLESS_API_KEY=... python3 run_eval.py --split dev
    FEATHERLESS_API_KEY=... python3 run_eval.py --split test --config MODEL=F1 ...
    FEATHERLESS_API_KEY=... python3 run_eval.py --split test --base

Per-document token scores are cached in results/raw/ (not committed, since
they reproduce the texts); summaries go to results/<split>.json.
"""
import argparse
import concurrent.futures
import json
import math
import os
import pathlib
import random
import time
import urllib.error
import urllib.request

from framings import BASE_MODEL, FRAMINGS

HERE = pathlib.Path(__file__).parent
RAW = HERE / "results" / "raw"
ENDPOINT = "https://api.featherless.ai/v1/completions"
LN2 = math.log(2)


def request_logprobs(model, prompt, key):
    body = {"model": model, "prompt": prompt, "max_tokens": 1, "temperature": 0,
            "logprobs": 1, "echo": True, "stream": True}
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "curl/8"})
    best = None
    with urllib.request.urlopen(req, timeout=180) as f:
        for line in f:
            line = line.decode("utf-8").strip()
            if not line.startswith("data:") or line.endswith("[DONE]"):
                continue
            msg = json.loads(line[5:])
            if msg.get("error"):
                raise RuntimeError(json.dumps(msg["error"])[:200])
            for choice in msg.get("choices", []):
                lp = choice.get("logprobs")
                if lp and lp.get("tokens") and (best is None or len(lp["tokens"]) > len(best["tokens"])):
                    best = lp
    if best is None:
        raise RuntimeError("no logprobs in response")
    return best


def essay_tokens(prompt, prefix_len, lp):
    """[(start, length, logprob)] for tokens lying inside the essay, offsets relative to it."""
    out, pos = [], 0
    for i, tok in enumerate(lp["tokens"]):
        if pos >= len(prompt):
            break  # the one generated token
        logprob = lp["token_logprobs"][i]
        if i == 0 and logprob is None and not prompt.startswith(tok):
            continue  # a leading special token the backend added itself
        if not prompt.startswith(tok, pos):
            raise RuntimeError("echoed tokens do not match the prompt at %d: %r" % (pos, tok))
        if pos >= prefix_len:
            out.append((pos - prefix_len, len(tok), logprob))
        elif pos + len(tok) > prefix_len:
            raise RuntimeError("a token straddles the prefix boundary")
        pos += len(tok)
    if pos != len(prompt):
        raise RuntimeError("prompt not echoed in full (%d of %d chars)" % (pos, len(prompt)))
    return out


def score_doc(model, framing, prefix, doc, key):
    path = RAW / ("%s__%s__%s.json" % (model.replace("/", "_"), framing, doc["id"]))
    if path.exists():
        return json.loads(path.read_text())
    text = (HERE / "corpus" / "texts" / (doc["id"] + ".txt")).read_text(encoding="utf-8")
    err = None
    for attempt in range(5):
        try:
            lp = request_logprobs(model, prefix + text, key)
            toks = essay_tokens(prefix + text, len(prefix), lp)
            rec = {"model": model, "framing": framing, "doc": doc["id"], "tokens": toks}
            RAW.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(rec))
            return rec
        except urllib.error.HTTPError as e:
            err = "HTTP %d %s" % (e.code, e.read().decode("utf-8", "replace")[:120])
        except Exception as e:  # network and upstream errors are retried alike
            err = "%s: %s" % (type(e).__name__, str(e)[:160])
        time.sleep(3 * (attempt + 1))
    return {"model": model, "framing": framing, "doc": doc["id"], "error": err}


def doc_stats(rec):
    """Bits and characters over scored essay tokens, skipping the essay's first token."""
    bits = chars = n = 0
    for start, length, logprob in rec["tokens"][1:]:
        if logprob is None:
            continue
        bits += -logprob / LN2
        chars += length
        n += 1
    return bits, chars, n


def summarise(recs, docs):
    by_id = {d["id"]: d for d in docs}
    bits = chars = toks = 0
    per_doc, per_source = [], {}
    for rec in recs:
        b, c, n = doc_stats(rec)
        bits += b; chars += c; toks += n
        per_doc.append(b / c)
        s = per_source.setdefault(by_id[rec["doc"]]["source"], [0.0, 0])
        s[0] += b; s[1] += c
    rng = random.Random(0)
    means = sorted(sum(rng.choices(per_doc, k=len(per_doc))) / len(per_doc) for _ in range(2000))
    return {
        "docs": len(recs), "bpc": bits / chars, "bits_per_token": bits / toks,
        "doc_mean_bpc": sum(per_doc) / len(per_doc),
        "doc_mean_ci95": [means[50], means[1949]],
        "by_source": {k: v[0] / v[1] for k, v in sorted(per_source.items())},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=["dev", "test"])
    ap.add_argument("--config", nargs="*", help="MODEL=FRAMING pairs; default is every framing of every model")
    ap.add_argument("--base", action="store_true", help="score the pretrained reference model instead")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    key = os.environ["FEATHERLESS_API_KEY"]
    docs = [d for d in json.loads((HERE / "corpus" / "manifest.json").read_text()) if d["split"] == args.split]

    if args.base:
        configs = [(BASE_MODEL, "F0", "")]
    elif args.config:
        configs = [(m, f, FRAMINGS[m][f]) for m, f in (c.split("=") for c in args.config)]
    else:
        configs = [(m, f, p) for m, fs in FRAMINGS.items() for f, p in fs.items()]

    results = {}
    for model in dict.fromkeys(m for m, _, _ in configs):
        mine = [(f, p) for m, f, p in configs if m == model]
        jobs = [(f, p, d) for f, p in mine for d in docs]
        with concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
            recs = list(pool.map(lambda j: score_doc(model, j[0], j[1], j[2], key), jobs))
        failed = sorted({r["doc"] for r in recs if "error" in r})
        for r in recs:
            if "error" in r:
                print("  FAILED", model, r["framing"], r["doc"], r["error"])
        for f, _ in mine:
            ok = [r for r in recs if r["framing"] == f and r["doc"] not in failed]
            results["%s=%s" % (model, f)] = dict(summarise(ok, docs), dropped=failed) if ok else {"docs": 0, "dropped": failed}
            s = results["%s=%s" % (model, f)]
            print("%-34s %s  docs %2d  bpc %s" % (model, f, s["docs"], "%.4f" % s["bpc"] if ok else "n/a"))

    out = HERE / "results" / (args.split + ".json")
    merged = json.loads(out.read_text()) if out.exists() else {}
    merged.update(results)
    out.write_text(json.dumps(merged, indent=1, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
