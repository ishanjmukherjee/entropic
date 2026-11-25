"""Builds the evaluation corpus: recent human-written text from five sources.

Every document is dated on or after CUTOFF, later than the release of any
model under test, so none of it can be memorized. Candidates are ordered by
the SHA-256 of their URL and the first PER_SOURCE are kept, which removes any
choice on our part; alternating documents go to the dev and test splits.

Texts are written to corpus/texts/ (not committed: third-party content).
corpus/manifest.json records URL, date, length and hash for each document.

    python3 build_corpus.py
"""
import hashlib
import html
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

CUTOFF = "2026-11-10"
PER_SOURCE = 12
MIN_CHARS = 1000
MAX_CHARS = 3000
HERE = pathlib.Path(__file__).parent
UA = {"User-Agent": "corpus-builder/0.1"}

BLOG_FEEDS = [
    "https://simonwillison.net/atom/entries/",
    "https://marginalrevolution.com/feed",
    "https://www.astralcodexten.com/feed",
    "https://thezvi.substack.com/feed",
    "https://www.construction-physics.com/feed",
    "https://www.noahpinion.blog/feed",
    "https://dynomight.net/feed.xml",
    "https://www.experimental-history.com/feed",
    "https://scottaaronson.blog/?feed=rss2",
    "https://www.overcomingbias.com/feed",
    "https://danluu.com/atom.xml",
    "https://jvns.ca/atom.xml",
]
ARXIV_CATEGORIES = ["econ.GN", "q-bio.PE", "physics.soc-ph", "cs.CY", "astro-ph.EP", "math.HO",
                    "cs.CL", "physics.hist-ph", "q-fin.GN", "cs.HC", "stat.AP", "cond-mat.soft"]


def get(url, data=None, headers=None, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=60) as f:
                return f.read().decode("utf-8", errors="replace")
        except Exception as err:  # network sources are flaky; retry then give up on this URL
            last = err
            time.sleep(2 + 3 * attempt)
    print("  failed:", url[:90], last)
    return None


class _Text(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "blockquote", "tr", "pre"}
    SKIP = {"script", "style", "figure", "figcaption", "iframe", "svg", "table", "pre", "code"}

    def __init__(self):
        super().__init__()
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag in self.BLOCK:
            self.out.append("\n\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag in self.BLOCK:
            self.out.append("\n\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_to_text(s):
    p = _Text()
    p.feed(s)
    return clean("".join(p.out))


def clean(s):
    s = html.unescape(s).replace("\r", "").replace(" ", " ")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" ?\n ?", "\n", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def truncate(s):
    if len(s) <= MAX_CHARS:
        return s
    cut = s[:MAX_CHARS]
    ends = [m.end() for m in re.finditer(r"[.!?][\"')\]]?(?=\s)", cut)]
    if ends and ends[-1] > MAX_CHARS * 0.6:
        return cut[:ends[-1]]
    return cut[:cut.rfind(" ")]


def arxiv():
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for cat in ARXIV_CATEGORIES:
        xml = get("http://export.arxiv.org/api/query?search_query=cat:%s&sortBy=submittedDate"
                  "&sortOrder=descending&max_results=15" % cat)
        time.sleep(3)
        if not xml:
            continue
        for e in ET.fromstring(xml).findall("a:entry", ns):
            date = e.findtext("a:published", "", ns)[:10]
            text = clean(re.sub(r"\s+", " ", e.findtext("a:summary", "", ns)))
            yield e.findtext("a:id", "", ns), date, text


def wikipedia():
    api = "https://en.wikipedia.org/w/api.php?format=json&"
    rc = get(api + "action=query&list=recentchanges&rctype=new&rcnamespace=0&rcshow=!redirect"
             "&rclimit=500&rcprop=title|timestamp|ids&rcend=%sT00:00:00Z" % CUTOFF)
    changes = json.loads(rc)["query"]["recentchanges"] if rc else []
    for i in range(0, len(changes), 20):
        batch = changes[i:i + 20]
        ids = "|".join(str(c["pageid"]) for c in batch)
        res = get(api + "action=query&prop=extracts&explaintext=1&exlimit=20&exintro=0&pageids=" + ids)
        if not res:
            continue
        pages = json.loads(res)["query"].get("pages", {})
        when = {str(c["pageid"]): c["timestamp"][:10] for c in batch}
        for pid, page in pages.items():
            text = clean(re.sub(r"\n==+ .*? ==+\n", "\n\n", page.get("extract", "")))
            yield "https://en.wikipedia.org/?curid=" + pid, when.get(pid, ""), text


def hackernews():
    ts = int(time.mktime(time.strptime(CUTOFF, "%Y-%m-%d")))
    for page in range(5):
        res = get("https://hn.algolia.com/api/v1/search_by_date?tags=comment&hitsPerPage=1000"
                  "&numericFilters=created_at_i>%d&page=%d" % (ts, page))
        if not res:
            continue
        for h in json.loads(res)["hits"]:
            yield ("https://news.ycombinator.com/item?id=%s" % h["objectID"], h["created_at"][:10],
                   html_to_text(h.get("comment_text") or ""))


def lesswrong():
    query = ('{posts(input:{terms:{view:"new",limit:150,after:"%s"}}){results{pageUrl postedAt '
             'contents{html}}}}' % CUTOFF)
    res = get("https://www.lesswrong.com/graphql", data=json.dumps({"query": query}).encode(),
              headers={"Content-Type": "application/json"})
    if not res:
        return
    for p in json.loads(res)["data"]["posts"]["results"]:
        body = (p.get("contents") or {}).get("html") or ""
        yield p["pageUrl"], p["postedAt"][:10], html_to_text(body)


def blogs():
    ns = {"a": "http://www.w3.org/2005/Atom", "c": "http://purl.org/rss/1.0/modules/content/"}
    for feed in BLOG_FEEDS:
        xml = get(feed)
        if not xml:
            continue
        try:
            root = ET.fromstring(xml.encode("utf-8"))
        except ET.ParseError:
            continue
        for it in root.iter("item"):
            date = it.findtext("pubDate", "")
            try:
                date = time.strftime("%Y-%m-%d", time.strptime(date[5:16], "%d %b %Y"))
            except ValueError:
                date = ""
            body = it.findtext("c:encoded", "", ns) or it.findtext("description", "")
            yield it.findtext("link", ""), date, html_to_text(body)
        for e in root.findall("a:entry", ns):
            link = e.find("a:link", ns)
            body = e.findtext("a:content", "", ns) or e.findtext("a:summary", "", ns)
            date = (e.findtext("a:published", "", ns) or e.findtext("a:updated", "", ns))[:10]
            yield (link.get("href") if link is not None else ""), date, html_to_text(body)


SOURCES = {"arxiv": arxiv, "wikipedia": wikipedia, "hackernews": hackernews,
           "lesswrong": lesswrong, "blogs": blogs}


def main():
    texts = HERE / "corpus" / "texts"
    texts.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, fn in SOURCES.items():
        seen, cands = set(), []
        for url, date, text in fn():
            # arXiv abstracts are short by nature; everything else must clear MIN_CHARS.
            floor = 700 if name == "arxiv" else MIN_CHARS
            if not url or url in seen or date < CUTOFF or len(text) < floor:
                continue
            seen.add(url)
            cands.append((hashlib.sha256(url.encode()).hexdigest(), url, date, truncate(text)))
        cands.sort()
        # At most two documents per blog, so one prolific author cannot dominate.
        kept, per_host = [], {}
        for h, url, date, text in cands:
            host = urllib.parse.urlparse(url).netloc
            if name == "blogs" and per_host.get(host, 0) >= 2:
                continue
            per_host[host] = per_host.get(host, 0) + 1
            kept.append((h, url, date, text))
            if len(kept) == PER_SOURCE:
                break
        print("%-10s %4d candidates, kept %d" % (name, len(cands), len(kept)))
        for i, (h, url, date, text) in enumerate(kept):
            doc_id = "%s-%02d" % (name, i)
            (texts / (doc_id + ".txt")).write_text(text, encoding="utf-8")
            manifest.append({"id": doc_id, "source": name, "split": "dev" if i % 2 == 0 else "test",
                             "url": url, "date": date, "chars": len(text),
                             "sha256": hashlib.sha256(text.encode()).hexdigest()})
    (HERE / "corpus" / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(len(manifest), "documents,", sum(m["chars"] for m in manifest), "chars")


if __name__ == "__main__":
    main()
