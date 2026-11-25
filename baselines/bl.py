"""Shared helper for the baseline corpus. Usage from a script run with `python -I`:

    import sys; sys.path.insert(0, "<repo>/baselines"); import bl   # BL_ROOT=<corpus dir>
    bl.add_doc(group="blogs-tech", id="goedecke-post-1", text=body, author="Sean Goedecke", ...)

CLI: python -I bl.py check <group>     summary table and validation of a group
"""
import json, os, re, sys, unicodedata, datetime

# The corpus lives outside the repository; point BL_ROOT at it.
ROOT = os.environ.get("BL_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POST_FROM = "2026-08-01"
PRE_BEFORE = "2025-07-01"
MAX_CHARS = 40000
REQUIRED = ["author", "title", "url", "date", "origin", "kind", "popularity", "popularity_basis", "position", "source_format"]
ENUMS = {
    "origin": {"human", "llm", "mixed"},
    "kind": {"essay", "news", "magazine", "paper", "transcript", "poem", "fiction", "play", "song", "code", "comment", "tweet", "review"},
    "popularity": {"high", "mid", "low"},
    "position": {"opening", "interior", "whole"},
}

def normalize(text, kind):
    text = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    if kind != "code":
        text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip("\n")
    if kind != "code":
        text = text.strip()
    if len(text) > MAX_CHARS:
        cut = text.rfind("\n\n", 0, MAX_CHARS)
        text = text[: cut if cut > MAX_CHARS // 2 else MAX_CHARS].rstrip()
    return text

def period_of(date):
    if date >= POST_FROM: return "post"
    if date < PRE_BEFORE: return "pre"
    return "mid"

def add_doc(group, id, text, **meta):
    assert re.fullmatch(r"[a-z0-9][a-z0-9-]{2,80}", id), "id must be a lowercase slug"
    assert re.fullmatch(r"[a-z0-9-]+", group)
    missing = [k for k in REQUIRED if not meta.get(k)]
    assert not missing, f"missing fields: {missing}"
    for k, allowed in ENUMS.items():
        assert meta[k] in allowed, f"{k}={meta[k]!r} not in {sorted(allowed)}"
    date = meta["date"]
    assert re.fullmatch(r"\d{4}(-\d{2}(-\d{2})?)?", date), "date must be YYYY, YYYY-MM or YYYY-MM-DD"
    if date >= "2025":
        assert len(date) == 10, "dates from 2025 on must be exact (YYYY-MM-DD)"
        assert date <= datetime.date.today().isoformat(), "date is in the future"
    text = normalize(text, meta["kind"])
    assert len(text) >= 200, "text too short"
    row = {"id": id, "group": group, **meta, "period": period_of(date), "chars": len(text)}
    os.makedirs(f"{ROOT}/texts/{group}", exist_ok=True)
    os.makedirs(f"{ROOT}/manifests", exist_ok=True)
    with open(f"{ROOT}/texts/{group}/{id}.txt", "w", encoding="utf-8") as f:
        f.write(text)
    path = f"{ROOT}/manifests/{group}.jsonl"
    rows = load(group)
    rows = [r for r in rows if r["id"] != id] + [row]
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return row

def remove_doc(group, id):
    rows = [r for r in load(group) if r["id"] != id]
    with open(f"{ROOT}/manifests/{group}.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    p = f"{ROOT}/texts/{group}/{id}.txt"
    if os.path.exists(p): os.remove(p)

def load(group):
    path = f"{ROOT}/manifests/{group}.jsonl"
    if not os.path.exists(path): return []
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]

def check(group):
    rows = load(group)
    print(f"{len(rows)} docs in {group}")
    for r in sorted(rows, key=lambda r: (r["author"], r["date"])):
        p = f"{ROOT}/texts/{group}/{r['id']}.txt"
        ok = os.path.exists(p)
        head = open(p, encoding="utf-8").read(70).replace("\n", " / ") if ok else "MISSING FILE"
        print(f"{r['author'][:22]:22} {r['date']:10} {r['period']:4} {r['kind']:10} {r['popularity']:4} {r['chars']:6} {r['id'][:34]:34} | {head}")

if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "check": check(sys.argv[2])
    else: print(__doc__)
