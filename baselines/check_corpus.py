"""Mechanical checks on a collected group: flags texts that look unclean.

    python3 -I baselines/check_corpus.py ROOT GROUP [--show N]

Prints one line per flagged document and, with --show, the head and tail of
the first N documents so a reader can eyeball them.
"""
import collections, json, os, re, sys

root, group = sys.argv[1], sys.argv[2]
show = int(sys.argv[sys.argv.index("--show") + 1]) if "--show" in sys.argv else 0
rows = [json.loads(l) for l in open(f"{root}/manifests/{group}.jsonl", encoding="utf-8") if l.strip()]

BOILER = re.compile(r"subscribe|sign up|share this|cookie|all rights reserved|read more|click here|newsletter|log in|advertisement|"
                    r"paid subscribers|leave a comment|©|\bRSS\b|follow (me|us) on|originally published|transcript by", re.I)
MOJIBAKE = re.compile(r"â€|Ã©|Ã¢|â\x80|�")
MARKUP = re.compile(r"<[a-z/][^>]{0,40}>|\*\*|\]\(http|^#{1,6} |&[a-z]+;|\[\d+\]|\{\{", re.M)
PROSE = {"essay", "news", "magazine", "paper", "transcript", "review", "comment", "tweet", "fiction"}
MIN = {"poem": 200, "song": 200, "comment": 1200, "tweet": 1200, "news": 2000, "code": 2000}

seen = {}
counts = collections.Counter()
for r in rows:
    path = f"{root}/texts/{group}/{r['id']}.txt"
    flags = []
    if not os.path.exists(path):
        print(f"{r['id']}: MISSING FILE"); continue
    t = open(path, encoding="utf-8").read()
    kind = r["kind"]
    head = t[:4000]
    if len(t) < MIN.get(kind, 3000): flags.append(f"short ({len(t)} chars)")
    for m in BOILER.finditer(head):
        flags.append(f"boilerplate? '{head[max(0, m.start() - 25):m.end() + 25]!r}'"); break
    if BOILER.search(t[-400:]): flags.append(f"boilerplate at end? {t[-160:]!r}")
    if MOJIBAKE.search(t): flags.append("mojibake")
    if kind != "code":
        mk = MARKUP.findall(head)
        if mk: flags.append(f"markup x{len(mk)} e.g. {mk[0]!r}")
        if "http://" in head or "https://" in head: flags.append("url in text")
    if kind in PROSE:
        lines = [l for l in head.split("\n") if l.strip()]
        singles = len(re.findall(r"[^\n]\n[^\n]", head))
        if lines and singles > 8 and sorted(len(l) for l in lines)[len(lines) // 2] < 110:
            flags.append(f"hard-wrapped? {singles} single line breaks")
        if re.search(r"\w-\n\w", head): flags.append("hyphenated line break")
        if not re.search(r"[.!?…\"”’)]\s*$", t[-3:] + " ") and kind != "transcript": flags.append(f"ends mid-sentence? {t[-60:]!r}")
    if r["period"] == "mid": flags.append(f"date {r['date']} is between the windows")
    key = t[:300]
    if key in seen: flags.append(f"same opening as {seen[key]}")
    seen[key] = r["id"]
    counts[(r["period"], kind, r["popularity"])] += 1
    if flags:
        print(f"{r['id']} [{kind} {r['date']}]: " + "; ".join(flags))
print()
for k, v in sorted(counts.items()): print(f"{v:4}  {k[0]:4} {k[1]:10} {k[2]}")
print(f"{len(rows)} documents")
for r in rows[:show]:
    t = open(f"{root}/texts/{group}/{r['id']}.txt", encoding="utf-8").read()
    print(f"\n== {r['id']} | {r['author']} | {r['date']} | {r['title'][:60]}\n{t[:240]!r}\n...\n{t[-160:]!r}")
