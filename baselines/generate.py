"""Generates the language-model texts for the baseline study.

    FEATHERLESS_API_KEY=... python3 baselines/generate.py [--sets essay,poem] [--models a,b] [--dry]

One sample per (prompt, model). Raw responses go to generated/raw/, cleaned
texts to generated/texts/gen-<set>/ and metadata to
generated/manifests/gen-<set>.jsonl. Existing outputs are never regenerated.
Featherless models run with hidden reasoning off (or at its lowest setting
where it cannot be turned off) to keep cost down; Claude runs through
`claude -p` with a one-line system prompt and no tools.
"""
import argparse, concurrent.futures as cf, datetime, json, os, re, subprocess, sys, tempfile, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "generated")

NO_THINK = {"chat_template_kwargs": {"enable_thinking": False}}
LOW = {"reasoning_effort": "low"}
MODELS = {
    "kimi-k3": {"family": "Moonshot", "id": "moonshotai/Kimi-K3", "extra": NO_THINK},
    "kimi-k2.6": {"family": "Moonshot", "id": "moonshotai/Kimi-K2.6", "extra": NO_THINK},
    "deepseek-v4-pro": {"family": "DeepSeek", "id": "deepseek-ai/DeepSeek-V4-Pro"},
    "glm-5.3": {"family": "Zhipu", "id": "zai-org/GLM-5.3", "extra": LOW},
    "qwen3.8": {"family": "Alibaba", "id": "Qwen/Qwen3.8-2.4T-A95B", "extra": LOW},
    "qwen3-coder": {"family": "Alibaba", "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct"},
    "mistral-medium-3.5": {"family": "Mistral", "id": "mistralai/Mistral-Medium-3.5-128B"},
    "gpt-oss-120b": {"family": "OpenAI", "id": "openai/gpt-oss-120b", "extra": LOW},
    "gemma-4-31b": {"family": "Google", "id": "google/gemma-4-31B-it"},
    "llama-3.3-70b": {"family": "Meta", "id": "unsloth/Llama-3.3-70B-Instruct"},
    "claude-fable-5.2": {"family": "Anthropic", "claude": "claude-fable-5-2"},
    "claude-opus-5.5": {"family": "Anthropic", "claude": "claude-opus-5-5"},
    "claude-haiku-5.5": {"family": "Anthropic", "claude": "claude-haiku-5-5"},
}

ESSAY_ALL = ["kimi-k2.6", "deepseek-v4-pro", "glm-5.3", "qwen3.8", "mistral-medium-3.5", "gpt-oss-120b",
             "gemma-4-31b", "llama-3.3-70b", "claude-fable-5.2", "claude-haiku-5.5"]
ESSAY_STYLED = ["kimi-k2.6", "deepseek-v4-pro", "glm-5.3", "claude-fable-5.2"]
CREATIVE = ["claude-fable-5.2", "claude-opus-5.5", "kimi-k3", "kimi-k2.6", "glm-5.3", "deepseek-v4-pro"]
CODE = ["claude-fable-5.2", "claude-haiku-5.5", "qwen3-coder", "deepseek-v4-pro", "glm-5.3"]
PAPER = ["claude-fable-5.2", "deepseek-v4-pro", "glm-5.3"]

ESSAYS = {
    "crypto": "Write an essay explaining how public-key cryptography works.",
    "remote": "Write an essay arguing for or against the claim that remote work is better than office work for software teams.",
    "city": "Write a personal essay about moving to a new city.",
    "subway": "Write an essay on why building subways costs so much more in some countries than in others.",
    "canal": "Write an essay about the Erie Canal and what it changed.",
    "phd": "Write an essay of advice for a new PhD student on choosing a research problem.",
    "book": "Write an essay reviewing a book you think is underrated.",
    "animals": "Write an essay on whether it is wrong to eat animals.",
}
ESSAY_TAIL = " About 800 words. Output only the essay, with no title."
ESSAY_STYLE = """Write an essay of about 800 words on the subject below.

Write it the way an excellent, idiosyncratic human essayist would: someone with real expertise and strong opinions, writing in the first person for their own blog. Commit to a specific thesis that a thoughtful reader might disagree with. Use concrete particulars (names, numbers, incidents, things only someone who had done the work would know) in place of general statements. Vary sentence length. No headings, no bullet points, no summary paragraph at the end, and none of the stock phrases of AI writing.

Output only the essay, with no title.

Subject: {subject}"""

POEMS = {
    "sea": ("Write a poem about the sea.", "the sea", "free verse, 14 to 30 lines"),
    "insomnia": ("Write a sonnet about insomnia.", "insomnia", "a sonnet: keep the fourteen lines and the turn; rhyme only if the rhymes surprise"),
    "father": ("Write a poem about a father's hands.", "a father's hands", "free verse, 14 to 30 lines"),
    "bus": ("Write a poem about a city bus at night.", "a city bus at night", "free verse, 14 to 30 lines"),
    "forgetting": ("Write a villanelle about forgetting.", "forgetting", "a villanelle; the refrains may shift slightly each time they return if that serves the poem"),
    "love": ("Write a love poem.", "love", "free verse, 14 to 30 lines"),
    "autumn": ("Write a poem about autumn.", "autumn", "free verse, 14 to 30 lines"),
    "kitchen": ("Write a poem about a kitchen.", "a kitchen", "free verse, 14 to 30 lines"),
}
POEM_TAIL = " Output only the poem, with no title."
POEM_CRAFT = """Write one poem. Subject: {subject}. Form: {form}.

Before writing, settle privately on particulars: one place that could be found on a map, one object, one hour of the day. Build the poem out of things that can be seen, handled or overheard, and let any idea arrive through them. Do not name the emotion. Prefer the exact noun and the plain verb to the adjective. Leave out the furniture of generic verse: no tapestries, whispers, echoes, dances of light, souls or journeys; no moral; no closing epiphany. Break lines where the breath or the sense turns, not at every phrase. At least once, say something the previous line gave the reader no way to expect. End on an image, not a statement.

Output only the poem: no title, no commentary."""

SONGS = {
    "breakup": ("pop", "a breakup"),
    "town": ("country", "leaving a small town"),
    "night": ("hip-hop", "a night out in the city"),
    "river": ("folk", "a river being dammed"),
}
SONG_BARE = "Write the lyrics of a {genre} song about {subject}. Output only the lyrics."
SONG_CRAFT = """Write the lyrics of a {genre} song about {subject}.

Write it as a working songwriter would, to be sung: lines that scan against a steady beat, a chorus that earns its repetition by meaning something slightly different each time it comes back, and verses that move a story forward through particular scenes, names, brands and street-level detail. Say the thing sideways: no line that states the feeling outright, no stock phrases, no word chosen only because it rhymes. Put one detail in each verse that only this story could contain.

Output only the lyrics, as plain lines with a blank line between sections: no title, no section labels, no chords, no commentary."""

STORIES = {
    "lighthouse": ("Write a short story about a lighthouse keeper.", "a lighthouse keeper"),
    "job": ("Write a short story about a first day at a new job.", "a first day at a new job"),
    "contact": ("Write a science fiction short story about first contact.", "first contact with an alien intelligence"),
    "house": ("Write a short story about two siblings clearing out their late mother's house.", "two siblings clearing out their late mother's house"),
}
STORY_TAIL = " About 800 words. Output only the story, with no title."
STORY_CRAFT = """Write a short story of about 800 words. Premise: {premise}.

Write it as a fine literary short-story writer would. Open in the middle of a particular moment, not with scene-setting or weather. Give each character a want that is never stated. Let the important thing happen slightly off the page or in what goes unsaid, and trust the reader. Use precise, unglamorous physical detail in place of adjectives; dialogue people would actually say, oblique and at cross purposes; and at least one turn the premise does not predict. Choose names a census would contain. No sentence that explains what a moment meant, and no ending on a lesson, a reconciliation or a sunrise.

Output only the story, with no title."""

PLAYS = {
    "funeral": "two estranged brothers meet at their father's funeral",
    "interview": "a job interview goes wrong",
    "messenger": "a messenger brings a queen bad news from the war",
}
PLAY_BARE = "Write a scene for a stage play in which {situation}. About 700 words. Output only the script."
PLAY_CRAFT = """Write a scene for a stage play, about 700 words. Situation: {situation}.

Write it as a skilled playwright would. Each character wants something from the other and will not say what; the scene is the manoeuvring. Lines should be short and speakable, with people cutting across each other, changing the subject, answering the question they wish they had been asked. Keep stage directions few and physical. Let one object on stage matter. No speech that explains a feeling or a history, and no tidy resolution: end on an action or a line that leaves the question open.

Format: character names in capitals on their own line, the speech on the next line, stage directions in parentheses. Output only the script, with no title or cast list."""

CODE_TASKS = {
    "lru-c": ("systems", "C", "implements an LRU cache with a hash table and a doubly linked list"),
    "todo-api-py": ("web-backend", "Python", "serves a small JSON HTTP API for a to-do list using only the standard library"),
    "combobox-tsx": ("web-frontend", "TypeScript (React)", "implements an accessible autocomplete combobox component"),
    "forecast-py": ("data-science", "Python", "loads a CSV of daily sales, cleans it, and fits and evaluates a seasonal forecast with pandas and statsmodels"),
    "sensor-c": ("embedded", "C", "is a driver for an I2C temperature and humidity sensor on a bare-metal ARM microcontroller, keeping a ring buffer of readings"),
    "parser-rs": ("compilers", "Rust", "implements a tokenizer and recursive-descent parser for arithmetic expressions with variables, producing an AST"),
    "tetris-cpp": ("games", "C++", "implements the core logic of a falling-block puzzle game: board, pieces, rotation, collision and line clearing, without rendering"),
    "articles-swift": ("mobile", "Swift (SwiftUI)", "implements a view and view model for a paginated list of articles fetched from a JSON API"),
    "backup-sh": ("devops", "Bash", "backs up a PostgreSQL database to S3 with rotation of old backups and error handling"),
    "library-sql": ("databases", "SQL (PostgreSQL)", "defines the schema for a library lending system and the queries for checking out, returning and reporting overdue loans"),
    "nbody-py": ("scientific", "Python", "runs an N-body gravitational simulation with a leapfrog integrator using NumPy"),
    "rbtree-hs": ("functional", "Haskell", "implements a persistent red-black tree with insert, member and toList"),
    "dupes-go": ("tooling", "Go", "is a command-line tool that walks a directory tree and reports duplicate files by content hash"),
}
CODE_PROMPT = "Write a complete, production-quality {language} source file that {task}. Output only the code."


def jobs():
    out = []
    def add(set_, kind, pid, style, prompt, models, max_tokens, **extra):
        for m in models:
            out.append({"set": set_, "kind": kind, "prompt_id": pid, "style": style, "prompt": prompt, "model": m,
                        "max_tokens": max_tokens, **extra})
    for k, p in ESSAYS.items():
        add("essay", "essay", f"essay-{k}", "bare", p + ESSAY_TAIL, ESSAY_ALL + (["kimi-k3"] if k in ("crypto", "remote", "city", "subway") else []), 1600)
        subject = p[len("Write "):].rstrip(".")
        add("essay", "essay", f"essay-{k}", "styled", ESSAY_STYLE.format(subject=subject), ESSAY_STYLED + (["kimi-k3"] if k in ("crypto", "remote", "city", "subway") else []), 1600)
    matched = os.path.join(HERE, "matched.json")
    if os.path.exists(matched):
        for m in json.load(open(matched)):
            if m["kind"] == "essay":
                add("essay", "essay", f"essay-m-{m['key']}", "matched", f"Write an essay titled “{m['title']}”. {m['subject']}" + ESSAY_TAIL, ESSAY_ALL, 1600, matched_to=m["doc"])
            if m["kind"] == "paper":
                add("paper", "paper", f"paper-m-{m['key']}", "matched", f"Write the introduction section of an academic paper titled “{m['title']}”. {m['subject']} About 700 words. Output only the text of the introduction, with no heading.", PAPER, 1500, matched_to=m["doc"])
    for k, (bare, subject, form) in POEMS.items():
        add("poem", "poem", f"poem-{k}", "bare", bare + POEM_TAIL, CREATIVE, 700)
        add("poem", "poem", f"poem-{k}", "craft", POEM_CRAFT.format(subject=subject, form=form), CREATIVE, 700)
    creative = [m for m in CREATIVE if m != "claude-opus-5.5"]
    for k, (genre, subject) in SONGS.items():
        add("song", "song", f"song-{k}", "bare", SONG_BARE.format(genre=genre, subject=subject), creative, 900)
        add("song", "song", f"song-{k}", "craft", SONG_CRAFT.format(genre=genre, subject=subject), creative, 900)
    no_k3 = [m for m in creative if m != "kimi-k3"]
    for k, (bare, premise) in STORIES.items():
        add("fiction", "fiction", f"story-{k}", "bare", bare + STORY_TAIL, no_k3, 1600)
        add("fiction", "fiction", f"story-{k}", "craft", STORY_CRAFT.format(premise=premise), creative, 1600)
    for k, situation in PLAYS.items():
        add("play", "play", f"play-{k}", "bare", PLAY_BARE.format(situation=situation), no_k3, 1500)
        add("play", "play", f"play-{k}", "craft", PLAY_CRAFT.format(situation=situation), creative, 1500)
    for k, (domain, language, task) in CODE_TASKS.items():
        add("code", "code", f"code-{k}", "bare", CODE_PROMPT.format(language=language, task=task), CODE, 3000, domain=domain, language=language)
    for j in out:
        j["id"] = f"{j['prompt_id']}-{j['style']}-{j['model']}".replace(".", "")
    return out


LABEL = re.compile(r"^\s*[\[\(\*]*\s*(verse|chorus|bridge|pre-?chorus|post-?chorus|outro|intro|hook|refrain|final chorus|interlude)\b[^\n]{0,24}$", re.I)

def clean(raw, kind):
    text = re.sub(r"<think>.*?</think>", "", raw, flags=re.S).replace("\r\n", "\n").strip()
    if kind == "code":
        # The first fenced block: from the first line that opens a fence to the
        # next line that starts with one (or the end, if the output was cut
        # off). Fences inside doc comments do not start a line.
        lines = text.split("\n")
        fences = [i for i, l in enumerate(lines) if l.startswith("```")]
        if fences:
            text = "\n".join(lines[fences[0] + 1:fences[1] if len(fences) > 1 else len(lines)])
        return "\n".join(l.rstrip() for l in text.split("\n")).strip("\n")
    lines = text.split("\n")
    if lines and re.match(r"^(sure|certainly|of course|okay|here('s| is| are))\b.*[:!.]\s*$", lines[0], re.I) and len(lines[0]) < 120:
        lines = lines[1:]
    while lines and not lines[0].strip():
        lines = lines[1:]
    if lines and (lines[0].startswith("#") or re.fullmatch(r"\*\*[^*]+\*\*", lines[0].strip())):
        lines = lines[1:]
    paras = "\n".join(lines).strip().split("\n\n")
    while paras and re.match(r"^\W*(would you like|let me know|i hope this|feel free|\(?word count|note:)", paras[-1].strip(), re.I):
        paras = paras[:-1]
    out = []
    for line in "\n\n".join(paras).split("\n"):
        if re.fullmatch(r"\s*([-*_]\s*){3,}", line):
            continue
        if kind == "song" and LABEL.match(line.strip()) and len(line.strip()) < 40:
            continue
        line = re.sub(r"^\s{0,3}#{1,6}\s+", "", line)
        line = re.sub(r"^\s{0,3}>\s?", "", line)
        line = re.sub(r"^(\s*)[*•]\s+", r"\1- ", line)
        line = re.sub(r"(\*\*|__)(.+?)\1", r"\2", line)
        line = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"\1", line)
        line = re.sub(r"(?<![\w_])_([^_\n]+)_(?![\w_])", r"\1", line)
        out.append(line.rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def call_featherless(spec, prompt, max_tokens):
    body = {"model": spec["id"], "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, **spec.get("extra", {})}
    req = urllib.request.Request("https://api.featherless.ai/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + os.environ["FEATHERLESS_API_KEY"], "Content-Type": "application/json", "User-Agent": "curl/8"})
    d = json.load(urllib.request.urlopen(req, timeout=600))
    c = d["choices"][0]
    return c["message"].get("content") or "", c.get("finish_reason"), d.get("usage", {})


def call_claude(spec, prompt):
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run(["claude", "-p", "--model", spec["claude"], "--system-prompt", "You are a helpful assistant.",
                            "--tools", "", "--setting-sources", "project"], input=prompt, capture_output=True, text=True, cwd=tmp, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"claude exited {r.returncode}: {r.stderr[-200:]}")
    return r.stdout, "stop", {}


def run(job):
    raw_path = os.path.join(OUT, "raw", job["id"] + ".json")
    if os.path.exists(raw_path):
        return job["id"], "cached", 0
    spec = MODELS[job["model"]]
    last = None
    for attempt in range(3):
        try:
            if "claude" in spec:
                raw, finish, usage = call_claude(spec, job["prompt"])
            else:
                raw, finish, usage = call_featherless(spec, job["prompt"], job["max_tokens"])
            if not raw.strip():
                raise RuntimeError(f"empty output (finish={finish})")
            break
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code} {e.read()[:120]!r}"
        except Exception as e:
            last = str(e)[:200]
    else:
        return job["id"], "FAILED " + str(last), 0
    rec = {**job, "model_id": spec.get("id") or spec["claude"], "family": spec["family"], "raw": raw, "finish_reason": finish,
           "usage": usage, "generated": datetime.date.today().isoformat()}
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    json.dump(rec, open(raw_path, "w"), ensure_ascii=False, indent=1)
    return job["id"], "ok" + (" TRUNCATED" if finish == "length" else ""), float(usage.get("cost") or 0)


def rebuild():
    """Writes cleaned texts and manifests from everything in generated/raw."""
    rows = {}
    raw_dir = os.path.join(OUT, "raw")
    for name in sorted(os.listdir(raw_dir)) if os.path.isdir(raw_dir) else []:
        rec = json.load(open(os.path.join(raw_dir, name)))
        text = clean(rec["raw"], rec["kind"])
        group = "gen-" + rec["set"]
        os.makedirs(os.path.join(OUT, "texts", group), exist_ok=True)
        open(os.path.join(OUT, "texts", group, rec["id"] + ".txt"), "w").write(text)
        row = {"id": rec["id"], "group": group, "author": rec["model"], "title": rec["prompt_id"], "url": "", "date": rec["generated"],
               "origin": "llm", "kind": rec["kind"], "popularity": "low", "popularity_basis": "generated for this study",
               "position": "whole", "source_format": "api", "period": "post", "chars": len(text), "model": rec["model"],
               "model_id": rec["model_id"], "family": rec["family"], "prompt_id": rec["prompt_id"], "style": rec["style"],
               "finish_reason": rec["finish_reason"]}
        for k in ("domain", "language", "matched_to"):
            if k in rec:
                row[k] = rec[k]
        rows.setdefault(group, []).append(row)
    os.makedirs(os.path.join(OUT, "manifests"), exist_ok=True)
    for group, rs in rows.items():
        with open(os.path.join(OUT, "manifests", group + ".jsonl"), "w") as f:
            for r in rs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return {g: len(r) for g, r in rows.items()}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets"); ap.add_argument("--models"); ap.add_argument("--dry", action="store_true")
    ap.add_argument("--workers", type=int, default=8); ap.add_argument("--rebuild", action="store_true")
    a = ap.parse_args()
    if a.rebuild:
        print(rebuild()); sys.exit()
    todo = [j for j in jobs() if (not a.sets or j["set"] in a.sets.split(",")) and (not a.models or j["model"] in a.models.split(","))]
    print(len(todo), "jobs")
    if a.dry:
        from collections import Counter
        print(Counter((j["set"], j["style"]) for j in todo)); print(Counter(j["model"] for j in todo)); sys.exit()
    spent = 0.0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for id_, status, cost in ex.map(run, todo):
            spent += cost
            if status != "cached":
                print(f"{id_}: {status}", flush=True)
    print(f"spent ${spent:.3f}"); print(rebuild())
