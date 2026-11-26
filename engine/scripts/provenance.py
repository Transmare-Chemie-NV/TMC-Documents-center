"""
HARD RULE — no invented content.
================================
Every piece of text in a produced document must be traceable to one of exactly
two places:

  1. the source document, or
  2. a value the operator supplied explicitly (entity block, product name,
     file number), or a literal declared in ALLOWED_LITERALS below.

Anything else is invented, and a document containing invented text is not
allowed to exist. check() returns the violations; the callers delete the
output and abort when the list is non-empty. There is no override flag.
"""
import hashlib
import re
import unicodedata
import zipfile

# Fixed labels the builder itself writes. Every literal the code is permitted
# to add is listed here, so the set of injectable strings stays auditable.
ALLOWED_LITERALS = (
    "Supplier",     # section 1.3 heading word, SDS only
    "VAT:",         # label in front of the entity VAT number
    "T",            # telephone marker in front of the entity phone
    "TMC file nr:",  # label in front of the supplied file number
    ":",            # the colon column the SDS two-column layout uses
)

# Text already present in the approved TMC template is not invented: it is part
# of the template. template_strings() adds it to the allowed set.


def norm(text):
    t = unicodedata.normalize("NFKD", text or "")
    t = re.sub(r"[̀-ͯ]", "", t)
    t = (t.replace("–", "-").replace("—", "-")
          .replace("’", "'").replace(" ", " "))
    t = re.sub(r"[^A-Za-z0-9]+", " ", t)
    return " ".join(t.lower().split())


def build_corpus(source_texts):
    """Normalised haystack. Pass the source's linear page text AND every table
    cell string, plus scrubbed variants, so that legitimate reflow and the
    supplier->TMC removal do not read as invention. The whole document joined
    is added too, so a value continuing across a page break still matches."""
    parts = [norm(t) for t in source_texts if norm(t)]
    return parts + [" ".join(parts)]


def docx_strings(path):
    """Every visible text run in body, headers and footers."""
    out = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not re.match(r"word/(document|header\d*|footer\d*)\.xml$", name):
                continue
            xml = z.read(name).decode("utf-8", "ignore")
            for para in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
                # a line break or tab between runs is white space, not a join
                # (v0.6.0: TDS values span several lines inside one cell)
                bits = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>|<w:(?:br|tab|cr)\b[^>]*/>", para, re.S)
                txt = "".join(bt if bt else " " for bt in bits)
                txt = (txt.replace("&amp;", "&").replace("&lt;", "<")
                          .replace("&gt;", ">").replace("&quot;", '"')
                          .replace("&apos;", "'"))
                if txt.strip():
                    out.append((name, txt.strip()))
    return out


def _image_hashes_docx(path):
    out = set()
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.startswith("word/media/"):
                out.add(hashlib.sha256(z.read(name)).hexdigest())
    return out


def _image_hashes_pdf(pdf_path):
    """Hash every image in the source, both as stored and as re-encoded PNG,
    so a picture carried into the output can be matched either way."""
    out = set()
    try:
        import pymupdf
    except ImportError:
        return out
    doc = pymupdf.open(pdf_path)
    for xref in {i[0] for pno in range(len(doc)) for i in doc[pno].get_images(full=True)}:
        try:
            raw = doc.extract_image(xref)["image"]
            out.add(hashlib.sha256(raw).hexdigest())
        except Exception:
            pass
        try:
            pix = pymupdf.Pixmap(doc, xref)
            if pix.n - pix.alpha > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            out.add(hashlib.sha256(pix.tobytes("png")).hexdigest())
        except Exception:
            pass
    doc.close()
    return out


def template_strings(template_path):
    """Every string in the approved TMC template - labels, headers, footers."""
    if not template_path:
        return []
    try:
        return [t for _, t in docx_strings(template_path)]
    except Exception:
        return []


MAX_INDEX_WORDS = 20_000
MAX_TOKENS_PER_LINE = 200
SAME_COL_GAP_PT = 14.0
MAX_WRAPS = 4
MAX_WRAP_LINE_GAP_PT = 18.0
MAX_BOX_HEIGHT_PT = 65.0
MAX_MATCH_STEPS = 10_000


def build_word_index(words):
    """Group PDF words by page into horizontal lines of normalized tokens + start-token lookup.
    Capped at MAX_INDEX_WORDS / MAX_TOKENS_PER_LINE (M-1).
    Returns {"pages": {page: [(line_top, [(tok, x0, x1, raw), ...], [x0, ...]), ...]},
             "starts": {tok: [(page, li, wi), ...]}}."""
    if not words:
        return {"pages": {}, "starts": {}}
    by_page = {}
    count = 0
    for w in words:
        if count >= MAX_INDEX_WORDS:
            break
        if not isinstance(w, dict):
            continue
        p = w.get("page")
        raw_txt = w.get("text") or ""
        nt = norm(raw_txt)
        if not p or not nt:
            continue
        by_page.setdefault(p, []).append((float(w["top"]), float(w["x0"]), float(w["x1"]), nt.split(), raw_txt))
        count += 1

    pages = {}
    starts = {}
    for p, items in by_page.items():
        items.sort(key=lambda t: (t[0], t[1]))
        lines = []
        for top, x0, x1, toks, raw_txt in items:
            if lines and abs(lines[-1][0] - top) <= 4.0:
                lines[-1][1].append((x0, x1, toks, raw_txt))
            else:
                lines.append([top, [(x0, x1, toks, raw_txt)]])
        built = []
        for top, raw in lines:
            raw.sort(key=lambda t: t[0])
            flat = []
            for x0, x1, toks, raw_txt in raw:
                for tok in toks:
                    if len(flat) >= MAX_TOKENS_PER_LINE:
                        break
                    flat.append((tok, x0, x1, raw_txt))
                if len(flat) >= MAX_TOKENS_PER_LINE:
                    break
            if flat:
                li = len(built)
                xs = [t[1] for t in flat]
                built.append((top, flat, xs))
                for wi, (tok, _x0, _x1, _raw) in enumerate(flat):
                    starts.setdefault(tok, []).append((p, li, wi))
        if built:
            pages[p] = built
    return {"pages": pages, "starts": starts}


def match_column_boxes(nv, word_index, max_matches=80):
    """Find every spatially coherent single-column box matching normalized text `nv`.
    Returns list of (page, y_top, y_bot, x_left, x_right) tuples.

    Strict Hard Rule 1 invariants (C-1 / M-1):
      - Never skips a word continuing the same column on the current line (<= SAME_COL_GAP_PT).
      - Immutable anchor_x0 (never ratchets left across column boundaries).
      - Wrapped matches must start at the left edge of their column on the first line,
        wrap at most MAX_WRAPS times, stay within MAX_WRAP_LINE_GAP_PT per wrap and
        MAX_BOX_HEIGHT_PT total, and never skip a line in the same column band.
      - Bounded by MAX_MATCH_STEPS (fails closed with [] on pathological inputs).
    """
    import bisect

    tokens = nv.split()
    pages = word_index.get("pages") if isinstance(word_index, dict) else None
    starts = word_index.get("starts") if isinstance(word_index, dict) else None
    if not tokens or not pages or not starts:
        return []
    candidates = starts.get(tokens[0])
    if not candidates:
        return []

    matches = []
    steps = 0
    for page, li, wi in candidates:
        steps += 1
        if steps > MAX_MATCH_STEPS:
            return []
        lines = pages[page]
        n_lines = len(lines)
        ltop, ltoks, _lxs = lines[li]
        _tok, x0, x1, _raw = ltoks[wi]

        # True when tokens[0] is at the left edge of its column on line `li`
        at_col_start = (wi == 0) or (x0 - ltoks[wi - 1][2] > SAME_COL_GAP_PT)
        anchor_x0 = x0
        col_x1 = x1
        prev_x1 = x1
        cur_li, cur_wi = li, wi
        y_top = y_bot = ltop
        wraps = 0
        ok = True

        for want in tokens[1:]:
            steps += 1
            if steps > MAX_MATCH_STEPS:
                return []
            cur_line = lines[cur_li][1]
            # 1. Check whether another word continues the SAME column on this line
            if cur_wi + 1 < len(cur_line):
                ntok, nx0, nx1, _nraw = cur_line[cur_wi + 1]
                if nx0 - prev_x1 <= SAME_COL_GAP_PT:
                    if ntok == want:
                        cur_wi += 1
                        prev_x1 = nx1
                        if nx1 > col_x1:
                            col_x1 = nx1
                        continue
                    # Another word continues this same column on this line and does NOT match `want`:
                    # NEVER skip it or fall through to wrap (C-1).
                    ok = False
                    break

            # 2. Reached end of this column on cur_li -> wrap to next line inside anchored column band
            if not at_col_start or wraps >= MAX_WRAPS:
                ok = False
                break
            wrapped = False
            band_lo = anchor_x0 - 10.0
            band_hi = max(col_x1 + 8.0, anchor_x0 + 18.0)
            for nli in range(cur_li + 1, n_lines):
                steps += 1
                if steps > MAX_MATCH_STEPS:
                    return []
                ntop, ntoks, nxs = lines[nli]
                if ntop - y_bot > MAX_WRAP_LINE_GAP_PT or ntop - y_top > MAX_BOX_HEIGHT_PT:
                    break
                k = bisect.bisect_left(nxs, band_lo)
                if k >= len(ntoks) or nxs[k] > band_hi:
                    continue  # this line has no words in our column band
                ntok, nx0, nx1, _nraw = ntoks[k]
                # Require wrapped token to sit at the left edge of our anchored column (no leading-word skip)
                wrap_at_col_start = (k == 0) or (nx0 - ntoks[k - 1][2] > SAME_COL_GAP_PT)
                if ntok == want and wrap_at_col_start and anchor_x0 - 10.0 <= nx0 <= anchor_x0 + 18.0:
                    cur_li, cur_wi = nli, k
                    y_bot = ntop
                    if nx1 > col_x1:
                        col_x1 = nx1
                    prev_x1 = nx1
                    wraps += 1
                    wrapped = True
                # First non-empty line in our column band either matched or didn't: never skip a line
                break
            if not wrapped:
                ok = False
                break

        if ok:
            matches.append((page, y_top, y_bot, anchor_x0, col_x1))
            if len(matches) >= max_matches:
                return matches
    return matches


def row_band_has_literal(raw_symbol, page, y_top, y_bot, word_index):
    """True when non-alphanumeric symbol (e.g. '%') appears literally in a PDF word on this row band."""
    pages = word_index.get("pages") if isinstance(word_index, dict) else None
    if not pages or page not in pages:
        return False
    want = raw_symbol.strip()
    if not want:
        return True
    for ltop, ltoks, _lxs in pages[page]:
        if y_top - 6.0 <= ltop <= y_bot + 6.0:
            if any(want in raw for _t, _x0, _x1, raw in ltoks):
                return True
    return False


def traced(n, corpus):
    """True when the normalised text `n` is printed in the source corpus (build_corpus).
    A short string matched loosely ("29" inside "1129") would be a hole, so anything under
    four characters must match on word boundaries. Shared with the AI reader's check."""
    if len(n) < 4:
        pat = re.compile(r"(?:^| )%s(?:$| )" % re.escape(n))
        return any(pat.search(c) for c in corpus)
    return any(n in c for c in corpus)


def check(docx_path, source_texts, allowed_values, template_path=None,
          source_pdf=None, source_words=None):
    """-> list of (location, offending text). Empty means fully traceable."""
    corpus = build_corpus(source_texts)
    word_index = build_word_index(source_words) if source_words else None
    allowed = [norm(v) for v in (list(allowed_values) + list(ALLOWED_LITERALS)
                                 + template_strings(template_path)) if norm(v)]

    violations = []

    # Images are content too: every picture in the output must be one that was
    # in the source document or in the approved TMC template. Nothing may be
    # substituted from any other collection of pictograms.
    if source_pdf:
        allowed_imgs = _image_hashes_pdf(source_pdf)
        if template_path:
            allowed_imgs |= _image_hashes_docx(template_path)
        for h in _image_hashes_docx(docx_path) - allowed_imgs:
            violations.append(("word/media", f"<image sha256:{h[:16]}> not from the source"))

    for where, raw in docx_strings(docx_path):
        n = norm(raw)
        if not n:
            continue
        if traced(n, corpus):
            continue
        if word_index and len(n.split()) >= 2 and match_column_boxes(n, word_index, max_matches=1):
            continue
        if any(n in a or a == n for a in allowed):
            continue
        # A line the builder composed from supplied values plus a declared
        # label (e.g. "VAT: BE 0435 913 050") is traceable token by token -
        # but ONLY against the supplied values, never against the source.
        # Matching body text token-by-token against the source would let an
        # invented sentence pass whenever its individual words happen to occur
        # somewhere in the document, so the source demands a contiguous match.
        tokens = n.split()
        pool = " ".join(allowed)
        if tokens and all(re.search(r"(?:^| )%s(?:$| )" % re.escape(tok), pool)
                          for tok in tokens):
            continue
        violations.append((where, raw))
    return violations


def assert_clean(docx_path, source_texts, allowed_values, on_fail=None,
                 template_path=None, source_pdf=None, source_words=None):
    v = check(docx_path, source_texts, allowed_values, template_path, source_pdf, source_words=source_words)
    if v:
        if on_fail:
            on_fail()
        lines = "\n".join(f"    [{w}] {t[:110]}" for w, t in v[:25])
        raise RuntimeError(
            "HARD RULE VIOLATED - text in the output cannot be traced to the "
            f"source or to a supplied value ({len(v)} item(s)):\n{lines}\n"
            "The output has been deleted. Nothing is guessed: fix the input "
            "or the mapping, then re-run.")
    return True
