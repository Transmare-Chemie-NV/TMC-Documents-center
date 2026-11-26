#!/usr/bin/env python3
"""Tests for scanned bordered-table grid reading, OBSERVATIONS headers, merged sub-rows,
ocrmypdf venv discovery, and wrapped multi-line AI cell verification (26/11/2026).

Reproduces the exact Acutaas Propyl Paraben USP bordered scanned COA layout (rasterized
image-only PDF with zero vector text or vector table lines, run through real ocrmypdf +
scan_grid + neutralize_docx) and verifies:
  1. _find_ocrmypdf() locates ocrmypdf in the active venv bin directory.
  2. Real OCR + scan_grid extracts all 9 numbered tests including Identification A/B and
     all 3 Related Substances sub-rows (12 rows total) with zero supplier identity leaks.
  3. Provenance gate passes 100% on the generated TMC Word document.
  4. AI reader column-box verification accepts wrapped multi-line cells (whose columns are
     interleaved in linear text) while still rejecting cross-row mismatches, invented text,
     and supplier identities.

Run:  python tests/test_scan_grid_and_wrapped_ai.py
"""
import io
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "scripts"))

import docx as _docx  # noqa: E402
import pymupdf  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

import ai_reader as A  # noqa: E402
import neutralize_docx as N  # noqa: E402
import provenance  # noqa: E402

ok = bad = 0


def check(name, cond, info=""):
    global ok, bad
    print(("  ok  " if cond else "  XX  ") + name + ("" if cond else f"\n{str(info)[:1500]}"))
    ok, bad = ok + bool(cond), bad + (not cond)


def build_acutaas_like_scan_pdf(out_path: Path):
    """Draw a vector COA matching the Acutaas Propyl Paraben USP layout, rasterize it at 250 DPI
    into a pure image-only PDF (zero embedded text, zero vector lines) so OCR + scan_grid run."""
    buf = io.BytesIO()
    W, H = A4  # 595 x 842 pt
    c = canvas.Canvas(buf, pagesize=A4)

    # Supplier header (outside table - must NEVER leak into TMC output)
    c.setFont("Helvetica-Bold", 15)
    c.drawString(50, H - 55, "EXAMPLE ORGANICS LIMITED")
    c.setFont("Helvetica", 8)
    c.drawString(50, H - 70, "(Formerly Known as Example Organics Pvt Ltd)")
    c.drawString(380, H - 60, "SOP No. ACL3-QA-015")

    c.setFont("Helvetica-Bold", 12)
    c.drawCentredString(W / 2, H - 96, "CERTIFICATE OF ANALYSIS")

    # Metadata block
    c.setFont("Helvetica", 9)
    c.drawString(48, H - 118, "Product          : PROPYL PARABEN USP              (CAS No. 94-13-3)")
    c.drawString(48, H - 131, "Batch No         : U3/P1/PP/0320725")
    c.drawString(48, H - 144, "Pack Size        : 126 X 25 Kg          Mfg. Date       : July-2025")
    c.drawString(48, H - 157, "Quantity         : 3,150 Kg             Exp. Date       : June-2030")
    c.drawString(48, H - 170, "A.R.No           : U3/QC/FP/25/00355    Date of Release : 05.08.2025")

    # Bordered table: Sr. No. | TESTS | SPECIFICATIONS | OBSERVATIONS
    xs = [44, 72, 206, 424, 550]
    y_top = H - 184

    def draw_row(y1, y2, cells, line_cols=None, bold=False):
        c.setLineWidth(0.8)
        # horizontal bottom line (full or partial columns)
        hx0 = xs[line_cols[0]] if line_cols else xs[0]
        hx1 = xs[line_cols[1]] if line_cols else xs[-1]
        c.line(hx0, y2, hx1, y2)
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 8.5)
        for ci, lines in enumerate(cells):
            if not lines:
                continue
            ty = y1 - 11
            for ln in lines:
                c.drawString(xs[ci] + 4, ty, ln)
                ty -= 10.5

    c.setLineWidth(0.8)
    c.line(xs[0], y_top, xs[-1], y_top)

    y = y_top
    spec_rows = [
        (26, [["Sr.", "No."], ["TESTS"], ["SPECIFICATIONS"], ["OBSERVATIONS"]], None, True),
        (26, [["1"], ["Description"], ["Small, colorless crystals or white powder."], ["White crystalline", "powder."]], None, False),
        (36, [["2"], ["Solubility"], ["Freely soluble in alcohol and in ether, slightly", "soluble in boiling water, very slightly soluble", "in water."], ["Complies."]], None, False),
        (16, [["3"], ["Identification"], [], []], (1, 4), False),
        (16, [[], ["A. IR Absorption <197 M>"], ["Passes the test"], ["Passes."]], (1, 4), False),
        (26, [[], ["B. Melting Range or", "Temperature, C"], ["96 C to 99 C"], ["97.8 C"]], None, False),
        (36, [["4"], ["Color of solution"], ["The sample solution is clear and not more", "intensely coloured than alcohol or the", "comparison solution."], ["Complies."]], None, False),
        (36, [["5"], ["Acidity"], ["Not more than 0.1 mL of 0.10 N sodium", "hydroxide is required to produce a blue color."], ["0.04 mL of 0.10 N", "sodium hydroxide is", "required."]], None, False),
        (20, [["6"], ["Related Substances by", "HPLC"], ["p-Hydroxybenzoic acid: NMT 0.5%"], ["Not detected."]], (2, 4), False),
        (16, [[], [], ["Unspecified impurities: NMT 0.5%"], ["Not detected."]], (2, 4), False),
        (16, [[], [], ["Total impurities: NMT 1.0%"], ["Not detected."]], None, False),
        (46, [["7"], ["Residual solvents", "n-Propanol", "Toluene"], ["USP general chapter <467>. Meets the", "requirement (USP/NF).", "NMT 5000 ppm", "NMT 890 ppm"], ["", "", "Not detected.", "Not detected."]], None, False),
        (18, [["8"], ["Residue on Ignition"], ["Not more than 0.1%, determined on 1.0 g"], ["0.05%"]], None, False),
        (26, [["9"], ["Assay, By HPLC", "(as C10H12O3)"], ["98.0% to 102.0%"], ["99.75%"]], None, False),
    ]
    for rh, cells, lcols, is_bold in spec_rows:
        draw_row(y, y - rh, cells, line_cols=lcols, bold=is_bold)
        y -= rh

    # Vertical grid lines spanning [y_top, y]
    for vx in xs:
        c.line(vx, y_top, vx, y)

    # Remarks, signatures, and supplier factory footer (outside table - must NEVER enter output)
    c.setFont("Helvetica", 8.5)
    c.drawString(48, y - 18, "Remarks: Material meets USP 44-NF 39 Specification.")
    c.drawString(70, y - 55, "Prepared By: (Officer-QC)     Checked By: (Manager-QC)     Approved By: (Manager-QA)")
    c.drawString(48, y - 92, "Factory: Plot No. 910/1/B, GIDC, Industrial Estate, India. Tel No.: +91-7861812602")
    c.drawString(48, y - 104, "Regd. Office: Plot No. 440, Road No. 82/A, Surat, India. www.example-organics.in")
    c.save()

    # Rasterize to a genuine image-only scanned PDF (zero embedded text, zero vector lines)
    src_doc = pymupdf.open(stream=buf.getvalue(), filetype="pdf")
    scan_doc = pymupdf.open()
    for p in src_doc:
        pix = p.get_pixmap(dpi=250)
        page = scan_doc.new_page(width=p.rect.width, height=p.rect.height)
        page.insert_image(page.rect, stream=pix.tobytes("png"))
    scan_doc.save(str(out_path))
    scan_doc.close()
    src_doc.close()


# 1. _find_ocrmypdf() discovers venv ocrmypdf even when PATH does not include venv/bin
old_path = os.environ.get("PATH", "")
try:
    os.environ["PATH"] = "/usr/bin:/bin"
    found_ocr = N._find_ocrmypdf()
    check("_find_ocrmypdf() finds ocrmypdf beside sys.executable even without venv on PATH",
          bool(found_ocr) and Path(found_ocr).name.startswith("ocrmypdf"), found_ocr)
finally:
    os.environ["PATH"] = old_path

# 2. Real image-only Acutaas-like scan -> OCR + scan_grid + parse_coa_fields + DOCX + provenance gate
with tempfile.TemporaryDirectory() as tmp:
    tmp_dir = Path(tmp)
    scan_pdf = tmp_dir / "acutaas_propyl_paraben_scan.pdf"
    build_acutaas_like_scan_pdf(scan_pdf)

    # Confirm the test PDF really has ZERO embedded text and ZERO vector tables before OCR
    raw_before = N._extract_pdf_raw(str(scan_pdf))
    check("synthetic scan PDF has zero embedded text before OCR", len(raw_before["full_text"].strip()) == 0)

    extracted = N.extract_pdf(str(scan_pdf))
    check("extract_pdf runs searchable OCR and recovers bordered grid table from scan",
          bool(extracted.get("tables")) and bool(extracted.get("words")),
          f"tables={len(extracted.get('tables') or [])}, words={len(extracted.get('words') or [])}")

    fields = N.parse_coa_fields(extracted)
    rows = fields.get("results_table") or []
    params = [r[0] for r in rows]
    check("batch, Mfg. Date, and Exp. Date all extracted cleanly from scan",
          fields.get("batch_lot") == "U3/P1/PP/0320725"
          and fields.get("manufacture_date") == "July-2025"
          and fields.get("expiry_date") == "June-2030",
          {k: fields.get(k) for k in ("batch_lot", "manufacture_date", "expiry_date")})

    # All 9 numbered tests including sub-rows A/B and all 3 Related Substances impurities = 12 rows!
    expected_keywords = [
        "description",
        "solubility",
        "ir absorption",
        "melting range",
        "color of solution",
        "acidity",
        "related substances",
        "unspecified impurities",
        "total impurities",
        "residual solvents",
        "residue on ignition",
        "assay",
    ]
    joined_params = " | ".join(p.lower() for p in params)
    missing = [kw for kw in expected_keywords if kw not in joined_params]
    check("all 9 Acutaas tests + sub-rows (12 rows) extracted from scanned bordered table",
          len(rows) >= 12 and not missing, f"got {len(rows)} rows, missing={missing}, params={params}")

    all_cells = " ".join(c for r in rows for c in r)
    check("no supplier letterhead, signatures, or factory address leaked into results table (Hard Rule 3)",
          not any(bad_s in all_cells.lower() for bad_s in ("example organics", "prepared by", "910/1/b", "7861812602", "www.")),
          all_cells)

    # Build real TMC DOCX and verify Hard Rule 1 provenance gate passes 100%
    out_docx = tmp_dir / "TMC_COA_840.S0850_Propyl_Paraben_USP_U3_P1_PP_0320725.docx"
    N.build_docx(fields, {"doc_ref": "840.S0850"}, "Propyl Paraben USP", str(out_docx))
    src_texts = N._source_texts(extracted, {}, fields)
    entity = N.load_entity(None)
    allowed = ["Propyl Paraben USP", "840.S0850", fields.get("batch_lot") or "", "Production date"] + list(entity.values())
    violations = provenance.check(str(out_docx), src_texts, allowed, template_path=str(N.TEMPLATE_DOC))
    check("provenance gate passes with 0 violations on full 12-row scanned COA output (Hard Rule 1)",
          violations == [], violations)
    doc = _docx.Document(str(out_docx))
    check("TMC Word output results table contains all 12 rows",
          len(doc.tables[1].rows) >= 13, len(doc.tables[1].rows))

# 3. AI reader column-box verification & security regressions (C-1, H-1, H-2, H-3, M-3)
import scan_grid as SG  # noqa: E402


def mk_words(specs):
    """specs: list of (top, x0, x1, text) on page 1."""
    return [{"page": 1, "top": top, "bottom": top + 9, "x0": x0, "x1": x1, "text": t} for top, x0, x1, t in specs]


wrapped_words = mk_words([
    # Row 1 (y=100): "Not detected." in result col (C-1 word-skipping trap with Row 2 "Passes.")
    (100, 40, 105, "Impurities"),
    (100, 180, 210, "NMT"), (100, 214, 238, "10"), (100, 242, 265, "ppm"),
    (100, 420, 438, "Not"), (100, 441, 485, "detected."),
    # Row 2 (y=118, 18 pt below Row 1): "Passes." right under "Not" (C-1 & H-3 adjacent row trap)
    (118, 40, 110, "Identification"),
    (118, 180, 210, "IR"), (118, 214, 245, "test"),
    (118, 420, 455, "Passes."),
    # Row 3 (y=140): Solubility wrapped 3 lines in col 2 while "Complies." sits on line 1 in col 3
    (140, 40, 95, "Solubility"),
    (140, 180, 215, "Freely"), (140, 218, 255, "soluble"), (140, 258, 268, "in"), (140, 271, 310, "alcohol"),
    (140, 420, 470, "Complies."),
    (152, 180, 215, "slightly"), (152, 218, 255, "soluble"), (152, 258, 268, "in"), (152, 271, 310, "boiling"),
    (164, 180, 215, "water."),
    # Row 9 (y=220): Assay wrapped 2 lines in col 1 while spec & result sit on line 1
    (220, 40, 75, "Assay,"), (220, 78, 92, "By"), (220, 95, 125, "HPLC"),
    (220, 180, 215, "98.0%"), (220, 218, 230, "to"), (220, 233, 270, "102.0%"),
    (220, 420, 460, "99.75%"),
    (232, 40, 55, "(as"), (232, 58, 115, "C10H12O3)"),
    # Supplier & signatory lines below (must be rejected)
    (400, 40, 90, "Example"), (400, 94, 140, "Chemie"), (400, 144, 160, "BV"), (400, 420, 460, "Passed"),
    (420, 40, 88, "Prepared"), (420, 92, 108, "By"), (420, 420, 465, "Officer-QC"),
])
interleaved_src = [
    "Impurities NMT 10 ppm Not detected.",
    "Identification IR test Passes.",
    "Solubility Freely soluble in alcohol Complies. slightly soluble in boiling water.",
    "Assay, By HPLC 98.0% to 102.0% 99.75% (as C10H12O3)",
    "Example Chemie BV Passed",
    "Prepared By Officer-QC",
]

# C-1: word-skipping across same-column lines MUST fail ("Not detected" + "Passes" != "Not Passes")
widx = provenance.build_word_index(wrapped_words)
check("C-1: match_column_boxes never skips trailing same-line words ('Not detected' + 'Passes' != 'Not Passes')",
      provenance.match_column_boxes("not passes", widx) == [], provenance.match_column_boxes("not passes", widx))

ai_answer = {
    "fields": {
        "batch": {"value": "", "quote": "", "page": 1},
        "production_date": {"value": "", "quote": "", "page": 1},
        "expiry_date": {"value": "", "quote": "", "page": 1},
    },
    "rows": [
        # Valid wrapped specification (interrupted by "Complies." in linear text)
        {
            "parameter": "Solubility",
            "specification": "Freely soluble in alcohol slightly soluble in boiling water.",
            "result": "Complies.",
            "unit": "",
            "method": "",
            "quote": "Solubility Freely soluble in alcohol slightly soluble in boiling water. Complies.",
            "page": 1,
        },
        # Valid wrapped parameter (interrupted by spec/result in linear text; % and HPLC sit on same row)
        {
            "parameter": "Assay, By HPLC (as C10H12O3)",
            "specification": "98.0% to 102.0%",
            "result": "99.75%",
            "unit": "%",
            "method": "HPLC",
            "quote": "Assay, By HPLC (as C10H12O3) 98.0% to 102.0% 99.75%",
            "page": 1,
        },
        # C-1 abuse: stitched "Not Passes." skipping "detected." -> MUST BE DROPPED
        {
            "parameter": "Impurities",
            "specification": "NMT 10 ppm",
            "result": "Not Passes.",
            "unit": "",
            "method": "",
            "quote": "Impurities Not Passes.",
            "page": 1,
        },
        # H-3 abuse: adjacent 18 pt row swap (Row 1 Impurities paired with Row 2 Passes.) -> MUST BE DROPPED
        {
            "parameter": "Impurities",
            "specification": "NMT 10 ppm",
            "result": "Passes.",
            "unit": "",
            "method": "",
            "quote": "Impurities Passes.",
            "page": 1,
        },
        # H-3 abuse: cross-row unit smuggling ("ppm" from Row 1 injected onto Row 9 Assay) -> MUST BE DROPPED
        {
            "parameter": "Assay, By HPLC (as C10H12O3)",
            "specification": "98.0% to 102.0%",
            "result": "99.75%",
            "unit": "ppm",
            "method": "HPLC",
            "quote": "Assay, By HPLC (as C10H12O3) 98.0% to 102.0% 99.75% ppm",
            "page": 1,
        },
        # Invented value -> MUST BE DROPPED
        {
            "parameter": "Solubility",
            "specification": "Freely soluble in alcohol",
            "result": "99.99%",
            "unit": "",
            "method": "",
            "quote": "Solubility 99.99%",
            "page": 1,
        },
        # M-3 abuse: EU supplier company form (BV) -> MUST BE DROPPED
        {
            "parameter": "Example Chemie BV",
            "specification": "",
            "result": "Passed",
            "unit": "",
            "method": "",
            "quote": "Example Chemie BV Passed",
            "page": 1,
        },
        # M-3 abuse: signatory line -> MUST BE DROPPED
        {
            "parameter": "Prepared By",
            "specification": "",
            "result": "Officer-QC",
            "unit": "",
            "method": "",
            "quote": "Prepared By Officer-QC",
            "page": 1,
        },
    ],
}

f, r, d = A.verify(ai_answer, frozenset({"rows"}), interleaved_src, [], helpers=N, words=wrapped_words)
check("AI wrapped-cell verifier accepts both wrapped multi-line rows and drops all 6 abuse rows (C-1, H-3, M-3)",
      len(r) == 2 and [row[0] for row in r] == ["Solubility", "Assay, By HPLC (as C10H12O3)"] and d == 6,
      (r, d))

# Independent provenance check WITHOUT any AI self-whitelisting into src_texts (C-1)
with tempfile.TemporaryDirectory() as tmp2:
    ai_docx = Path(tmp2) / "wrapped_ai.docx"
    N.build_docx({"batch_lot": "L-1", "manufacture_date": "01.2026", "expiry_date": "01.2028", "results_table": []},
                 {"doc_ref": "840.S0999"}, "Propyl Paraben", str(ai_docx), ai=A.Proposal(rows=r))
    allowed_ai = ["Propyl Paraben", "840.S0999", "L-1", "01.2026", "01.2028", "Production date", A.AI_NOTE]
    v_ok = provenance.check(str(ai_docx), interleaved_src, allowed_ai, template_path=str(N.TEMPLATE_DOC),
                            source_words=wrapped_words)
    check("C-1: independent provenance.check(source_words=...) accepts genuine wrapped AI rows with 0 violations",
          v_ok == [], v_ok)

# Without words, interleaved linear text still fails closed
f0, r0, d0 = A.verify(ai_answer, frozenset({"rows"}), interleaved_src, [], helpers=N)
check("without word positions, interleaved wrapped rows stay strictly checked (fail-closed)",
      r0 == [] and d0 == 8, (r0, d0))

# H-1 regression: merged sub-row whose split head is an identity label MUST drop completely (never fall back!)
merged_abuse = N.parse_coa_fields({
    "full_text": "",
    "layout_text": "",
    "tables": [{
        "page": 1,
        "rows": [
            ["Sr. No.", "TESTS", "SPECIFICATIONS", "OBSERVATIONS"],
            ["1", "Related Substances", "p-Hydroxybenzoic acid: NMT 0.5%", "Not detected."],
            ["", "", "Manufacturer: Acme Organics Pvt. Ltd.", "India"],
            ["", "", "Mobile phase: Clear", "Clear"],
        ],
    }],
})
m_rows = merged_abuse.get("results_table") or []
check("H-1 & M-3: merged sub-row 'Manufacturer: ...' is dropped completely while HPLC 'Mobile phase' stays",
      not any("acme" in c.lower() or "manufacturer" in c.lower() for r_ in m_rows for c in r_)
      and any("mobile phase" in r_[0].lower() for r_ in m_rows),
      m_rows)

# H-1 regression: full-page outer frame border in scan_grid must NOT pull letterhead or factory footer into table
with tempfile.TemporaryDirectory() as tmp3:
    framed_pdf = Path(tmp3) / "framed_scan.pdf"
    buf = io.BytesIO()
    W, H = A4
    c = canvas.Canvas(buf, pagesize=A4)
    c.setLineWidth(1.0)
    c.rect(24, 30, W - 48, H - 60)  # full-page outer frame wrapping EVERYTHING
    c.setFont("Helvetica-Bold", 13)
    c.drawString(50, H - 60, "ACME CHEMICALS BV")
    c.drawCentredString(W / 2, H - 90, "CERTIFICATE OF ANALYSIS")
    c.setFont("Helvetica", 9)
    c.drawString(50, H - 115, "Batch No: B-9901  Mfg. Date: 01.2026  Exp. Date: 01.2029")
    xs = [44, 200, 390, 540]
    yt, yb = H - 150, H - 270
    for i, row_txt in enumerate([
        ("TESTS", "SPECIFICATIONS", "OBSERVATIONS"),
        ("Description", "White powder", "White powder"),
        ("Assay", "98.0% to 102.0%", "99.5%"),
        ("Loss on drying", "NMT 0.5%", "0.1%"),
    ]):
        ry = yt - i * 30
        c.line(xs[0], ry, xs[-1], ry)
        for ci, txt in enumerate(row_txt):
            c.drawString(xs[ci] + 4, ry - 18, txt)
    c.line(xs[0], yb, xs[-1], yb)
    for vx in xs:
        c.line(vx, yt, vx, yb)
    c.drawString(50, 70, "Factory: Plot 99, Surat. Tel +91-1234567890")
    c.save()
    src_d = pymupdf.open(stream=buf.getvalue(), filetype="pdf")
    sc_d = pymupdf.open()
    for p in src_d:
        pix = p.get_pixmap(dpi=250)
        pg = sc_d.new_page(width=p.rect.width, height=p.rect.height)
        pg.insert_image(pg.rect, stream=pix.tobytes("png"))
    sc_d.save(str(framed_pdf))
    sc_d.close()
    src_d.close()

    f_ext = N.extract_pdf(str(framed_pdf))
    f_fields = N.parse_coa_fields(f_ext)
    f_rows = f_fields.get("results_table") or []
    f_text = " ".join(c for r_ in f_rows for c in r_).lower()
    check("H-1: full-page outer frame does not pull letterhead or factory footer into scan_grid table",
          len(f_rows) == 3 and "acme" not in f_text and "plot" not in f_text and "1234567890" not in f_text,
          f_rows)

# H-2 regression: giant MediaBox (200x200 inches = 14400x14400 pt) is rejected safely without OOM
check("H-2: scan_grid _safe_render_scale rejects absurd giant MediaBox (14400x14400 pt) and caps normal pages",
      SG._safe_render_scale(14400, 14400) is None
      and SG._safe_render_scale(0, 842) is None
      and (SG._safe_render_scale(595, 842) or 0) > 1.5,
      (SG._safe_render_scale(14400, 14400), SG._safe_render_scale(595, 842)))

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
