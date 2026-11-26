"""
Bordered table reader for scanned COAs (26/11/2026).

Native vector PDFs carry PDF ruling lines that pdfplumber.extract_tables() reads directly.
A scanned COA has the same black grid lines as pixels in the page image, so pdfplumber sees
no vector lines and returns tables=[]. This module detects the dark horizontal and vertical
grid lines from the rendered page image (pymupdf + numpy) and places the already-OCR'd words
into their exact cell boxes in pure column reading order.

Hard-rule & resource safety:
  - Nothing is ever invented: every cell holds only OCR words whose centre falls strictly
    inside that cell box.
  - Full-page outer frames never pull letterhead, signatures, or factory footers into the
    table: vertical line clustering uses symmetric IoU overlap and clips [y_top, y_bot] to
    the vertical span covered by interior column dividers (H-1 / Hard Rule 3).
  - Bounded rendering (MAX_PAGE_DIM_PX / MAX_RENDER_PIXELS / MAX_PAGES / MAX_WORDS_PER_PAGE)
    prevents OOM or CPU DoS on giant /MediaBox PDFs (H-2).
"""
import math
import numpy as np

DPI = 150
DARK_MAX = 185
MAX_PAGES = 15
MAX_ROWS = 200
MAX_COLS = 12
MAX_PAGE_DIM_PX = 2600
MAX_RENDER_PIXELS = 5_000_000
MAX_WORDS_PER_PAGE = 5_000


def _long_runs(mask, min_len, max_gap=4):
    """Contiguous True runs in a 1D bool array allowing short scan gaps <= max_gap."""
    idx = np.flatnonzero(mask)
    if idx.size < min_len:
        return []
    splits = np.flatnonzero(np.diff(idx) > max_gap + 1)
    starts = np.concatenate(([0], splits + 1))
    ends = np.concatenate((splits, [idx.size - 1]))
    runs = []
    for s, e in zip(starts, ends):
        a, b = int(idx[s]), int(idx[e])
        if b - a + 1 >= min_len:
            runs.append((a, b))
    return runs


def _merge_segments(raw, pos_tol=5):
    """Merge nearby parallel line segments (pos, span_start, span_end) -> [(pos_mid, s0, s1)]."""
    if not raw:
        return []
    raw = sorted(raw, key=lambda t: (t[0], t[1]))
    merged = []
    for pos, s0, s1 in raw:
        placed = False
        for i in range(len(merged) - 1, -1, -1):
            p_sum, p_cnt, ms0, ms1, p_last = merged[i]
            if pos - p_last > pos_tol:
                break
            if min(s1, ms1) >= max(s0, ms0) - 10:
                merged[i] = (p_sum + pos, p_cnt + 1, min(s0, ms0), max(s1, ms1), pos)
                placed = True
                break
        if not placed:
            merged.append((pos, 1, s0, s1, pos))
    return [(p_sum / p_cnt, s0, s1) for p_sum, p_cnt, s0, s1, _ in merged]


def _detect_grid_boxes(gray):
    """Detect bordered table grids in a grayscale uint8 page image.
    -> list of (xs_px, ys_px) tuples sorted top-to-bottom."""
    h, w = gray.shape
    if h < 100 or w < 100:
        return []
    dark = gray < DARK_MAX

    # 1. Vertical borders (3-col OR tolerates ~0.5 deg residual scan skew)
    min_v = max(60, int(0.10 * h))
    col_counts = dark.sum(axis=0)
    raw_v = []
    for x in range(0, w - 2):
        if int(col_counts[x:x + 3].sum()) < min_v:
            continue
        band = dark[:, x:x + 3].any(axis=1)
        for y0, y1 in _long_runs(band, min_v, max_gap=4):
            raw_v.append((x + 1, y0, y1))
    v_lines = _merge_segments(raw_v, pos_tol=6)
    if len(v_lines) < 3:
        return []

    # 2. Horizontal borders (3-row OR tolerates slight scan skew; 30% page width catches sub-row dividers)
    min_h = max(80, int(0.30 * w))
    row_counts = dark.sum(axis=1)
    raw_h = []
    for y in range(0, h - 2):
        if int(row_counts[y:y + 3].sum()) < min_h:
            continue
        band = dark[y:y + 3, :].any(axis=0)
        for x0, x1 in _long_runs(band, min_h, max_gap=4):
            raw_h.append((y + 1, x0, x1))
    h_lines = _merge_segments(raw_h, pos_tol=6)
    if len(h_lines) < 3:
        return []

    # 3. Cluster vertical lines by symmetric IoU vertical overlap (H-1: prevents a tall full-page
    # outer border from swallowing an inner table and pulling letterhead/footers into the grid).
    clusters = []
    for vx, vy0, vy1 in sorted(v_lines, key=lambda t: (t[1], t[0])):
        vh = vy1 - vy0
        placed = False
        for cl in clusters:
            cy0, cy1 = cl["y0"], cl["y1"]
            overlap = min(vy1, cy1) - max(vy0, cy0)
            if overlap >= 0.65 * max(vh, cy1 - cy0):
                cl["xs"].append((vx, vy0, vy1))
                placed = True
                break
        if not placed:
            clusters.append({"xs": [(vx, vy0, vy1)], "y0": vy0, "y1": vy1})

    # If a full-page outer frame exists (two long outer vertical lines bracketing shorter interior
    # column dividers), attach the bracketing x bounds WITHOUT expanding [y_top, y_bot] beyond the
    # interior column dividers' span (H-1).
    outer_lines = [t for cl in clusters if len(cl["xs"]) <= 2 for t in cl["xs"]]
    grids = []
    for cl in clusters:
        lines_in = list(cl["xs"])
        if len(lines_in) >= 1 and len(outer_lines) >= 2:
            # Interior span defined strictly by this cluster's lines
            iy0 = float(np.median([t[1] for t in lines_in]))
            iy1 = float(np.median([t[2] for t in lines_in]))
            for ox, oy0, oy1 in outer_lines:
                if oy0 <= iy0 + 10 and oy1 >= iy1 - 10:
                    lines_in.append((ox, iy0, iy1))
        if len(lines_in) < 3:
            continue

        # Sort and deduplicate vertical line positions; clip [y_top, y_bot] to where >= 3 lines coexist
        lines_in.sort(key=lambda t: t[0])
        dedup = []
        for vx, vy0, vy1 in lines_in:
            if not dedup or vx - dedup[-1][0] >= 12:
                dedup.append((vx, vy0, vy1))
        if len(dedup) < 3 or len(dedup) - 1 > MAX_COLS:
            continue

        xs = [t[0] for t in dedup]
        x_left, x_right = xs[0], xs[-1]
        tbl_w = x_right - x_left
        if tbl_w < 0.35 * w:
            continue

        # Vertical table span = tight intersection where at least 3 vertical lines exist (never union!)
        y_top = float(sorted(t[1] for t in dedup)[2])       # 3rd-highest start (ignores 2 outer frame lines)
        y_bot = float(sorted(t[2] for t in dedup)[-3])      # 3rd-lowest end (ignores 2 outer frame lines)
        if y_bot - y_top < min_v:
            continue

        ys_raw = [y_top, y_bot]
        for hy, hx0, hx1 in h_lines:
            if y_top - 6 <= hy <= y_bot + 6:
                ov = min(hx1, x_right) - max(hx0, x_left)
                if ov >= 0.38 * tbl_w:
                    ys_raw.append(hy)
        ys_raw.sort()
        ys = []
        for y in ys_raw:
            if not ys or y - ys[-1] >= 10:
                ys.append(y)
        if len(ys) < 3 or len(ys) - 1 > MAX_ROWS:
            continue
        grids.append((xs, ys))

    grids.sort(key=lambda g: g[1][0])
    return grids


def _join_cell_words(cell_words):
    """Join words inside one cell box in natural reading order (lines within 3.5 pt, left to right)."""
    if not cell_words:
        return ""
    lines = []
    for w in sorted(cell_words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= 3.5:
            lines[-1].append(w)
        else:
            lines.append([w])
    return " ".join(" ".join(w["text"] for w in sorted(ln, key=lambda w: w["x0"])) for ln in lines).strip()


def _words_to_rows(page_words, xs_pt, ys_pt):
    n_rows = len(ys_pt) - 1
    n_cols = len(xs_pt) - 1
    cells = [[[] for _ in range(n_cols)] for _ in range(n_rows)]
    x_min, x_max = xs_pt[0], xs_pt[-1]
    y_min, y_max = ys_pt[0], ys_pt[-1]

    for w in page_words[:MAX_WORDS_PER_PAGE]:
        cx = (w["x0"] + w["x1"]) / 2.0
        cy = (w["top"] + w.get("bottom", w["top"] + 8.0)) / 2.0
        if not (x_min - 2.0 <= cx <= x_max + 2.0 and y_min - 2.0 <= cy <= y_max + 2.0):
            continue
        col = next((c for c in range(n_cols) if xs_pt[c] - 1.5 <= cx <= xs_pt[c + 1] + 1.5), None)
        row = next((r for r in range(n_rows) if ys_pt[r] - 1.5 <= cy <= ys_pt[r + 1] + 1.5), None)
        if col is not None and row is not None:
            cells[row][col].append(w)

    rows = []
    for r in range(n_rows):
        row_text = [_join_cell_words(cells[r][c]) for c in range(n_cols)]
        if any(row_text):
            rows.append(row_text)
    return rows


def _safe_render_scale(rect_w, rect_h, dpi=DPI):
    """Clamp render scale to MAX_PAGE_DIM_PX and MAX_RENDER_PIXELS (H-2 OOM guard).
    Returns None if page geometry is invalid or absurdly huge."""
    if rect_w <= 0 or rect_h <= 0:
        return None
    scale = dpi / 72.0
    max_dim = max(rect_w, rect_h)
    if max_dim * scale > MAX_PAGE_DIM_PX:
        scale = MAX_PAGE_DIM_PX / max_dim
    est_pixels = (rect_w * scale) * (rect_h * scale)
    if est_pixels > MAX_RENDER_PIXELS:
        scale *= math.sqrt(MAX_RENDER_PIXELS / est_pixels)
    return scale if scale >= 0.5 else None


def extract_scan_grid_tables(pdf_path, words, existing_table_pages=()):
    """Extract bordered tables from scanned PDF pages that had no pdfplumber vector tables.
    -> list of {"page": pno, "rows": [[cell, ...], ...]} matching pdfplumber's table shape."""
    if not words:
        return []
    try:
        import pymupdf
    except ImportError:
        return []

    by_page = {}
    for w in words:
        lst = by_page.setdefault(w["page"], [])
        if len(lst) < MAX_WORDS_PER_PAGE:
            lst.append(w)

    skip = set(existing_table_pages or ())
    out = []
    try:
        doc = pymupdf.open(pdf_path)
    except Exception:
        return []
    try:
        for pno_0 in range(min(len(doc), MAX_PAGES)):
            pno = pno_0 + 1
            if pno in skip or pno not in by_page:
                continue
            page = doc[pno_0]
            scale = _safe_render_scale(float(page.rect.width), float(page.rect.height), DPI)
            if scale is None:
                continue
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY)
            if pix.width < 100 or pix.height < 100 or pix.n != 1 or len(pix.samples) != pix.height * pix.width:
                continue
            gray = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
            scale_x = float(page.rect.width) / pix.width
            scale_y = float(page.rect.height) / pix.height
            for xs_px, ys_px in _detect_grid_boxes(gray):
                xs_pt = [x * scale_x for x in xs_px]
                ys_pt = [y * scale_y for y in ys_px]
                rows = _words_to_rows(by_page[pno], xs_pt, ys_pt)
                if len(rows) >= 2:
                    out.append({"page": pno, "rows": rows})
    except Exception:
        return out
    finally:
        doc.close()
    return out
