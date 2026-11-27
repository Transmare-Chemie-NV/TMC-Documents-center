"use client";

// Our own on-screen editor of the check screen (Willem 19/10 option A; own editor 20/10, so no
// outside licence). The worker shows the draft as a view in which every piece of text has a
// number; the person types in it and sets bold, italic, underline or removes a yellow mark.
// Only the changed pieces go back, and the worker writes them into its own Word file, so the
// TMC layout cannot break. The editor sits behind this one component, so it can be swapped (for
// example for Word for the web in phase 4) without touching the pages.
import { createContext, memo, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { ALIGNS, cleanDocText, type Edits, type Piece, type TableOp } from "@/lib/documents/edits";
import {
  addColPlan,
  allGroups,
  allTables,
  applyOp,
  baseGrid,
  cellPieces,
  collectEdits,
  dim,
  parseView,
  pointsOf,
  readGroup,
  safeColor,
  safeFont,
  safeImage,
  segments,
  startParaPieces,
  startPieces,
  type Block,
  type Cell,
  type DomLike,
  type Grid,
  type Item,
  type Para,
  type RunItem,
  type Table,
  type View,
} from "./doc-editor-model";

export type DocEditorHandle = { getEdits: () => Edits };
export type DocEditorState = "loading" | "ready" | "error";

type Props = {
  /** the editor view of the draft (/api/files/<id>/view) */
  src: string;
  /** the person's last edit that did not become Final, shown again */
  pending: Edits | null;
  onState: (s: DocEditorState) => void;
  /** live count of remaining yellow parts in the editor DOM */
  onYellowCount?: (n: number) => void;
  ref: Ref<DocEditorHandle>;
};

const CLEAR_BG = new Set([
  "",
  "transparent",
  "rgba(0,0,0,0)",
  "inherit",
  "initial",
  "unset",
  "white",
  "#fff",
  "#ffffff",
  "rgb(255,255,255)",
]);

function effectiveHighlightAncestor(textNode: Node, stopAt: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = textNode.parentElement;
  while (cur && cur !== stopAt) {
    const raw = cur.style?.backgroundColor;
    if (raw) {
      const c = raw.replace(/\s/g, "").toLowerCase();
      return CLEAR_BG.has(c) ? null : cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

function findMarkedYellow(root: HTMLElement | null): HTMLElement[] {
  if (!root || typeof document === "undefined") return [];
  const out: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  root.querySelectorAll<HTMLElement>("[data-g]").forEach((group) => {
    const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const hl = effectiveHighlightAncestor(node, group);
      if (hl && !seen.has(hl)) {
        seen.add(hl);
        out.push(hl);
      }
    }
  });
  return out;
}

function isFollowingConnected(anchor: Node, target: Node): boolean {
  const pos = anchor.compareDocumentPosition(target);
  return !(pos & Node.DOCUMENT_POSITION_DISCONNECTED) && Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING);
}

function countYellowParts(marked: HTMLElement[]): number {
  const seen = new Set<string>();
  let count = 0;
  for (const el of marked) {
    const rid = el.closest("[data-r]")?.getAttribute("data-r");
    const gid = el.closest("[data-g]")?.getAttribute("data-g");
    if (rid && gid) {
      const key = `${gid}:${rid}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    count++;
  }
  return count;
}

export function DocEditor({ src, pending, onState, onYellowCount, ref }: Props) {
  const [view, setView] = useState<View | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const report = useRef(onState);
  const reportYellow = useRef(onYellowCount);
  useEffect(() => {
    report.current = onState;
    reportYellow.current = onYellowCount;
  });

  useEffect(() => {
    let cancelled = false;
    report.current("loading");
    fetch(src, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("view not available");
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        setView(parseView(json));
        report.current("ready");
      })
      .catch(() => !cancelled && report.current("error"));
    return () => {
      cancelled = true;
    };
  }, [src]);

  // unsaved changes: the browser asks before leaving the page
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    const changed = () => (dirty.current = true);
    const el = host.current;
    window.addEventListener("beforeunload", warn);
    el?.addEventListener("beforeinput", changed, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      el?.removeEventListener("beforeinput", changed, true);
    };
  }, []);

  const groups = useMemo(() => (view ? allGroups(view) : new Map<string, never>()), [view]);
  const tablesById = useMemo(() => (view ? allTables(view) : new Map<string, Table>()), [view]);

  // Rows and columns (Willem 22/10): the changes are kept here, in order, and drawn by each table.
  const [tableOps, setTableOps] = useState<Record<string, TableOp[]>>(() =>
    Object.fromEntries((pending?.tables ?? []).map((t) => [t.id, t.ops])),
  );
  const history = useRef<string[]>([]);
  const nextNew = useRef(
    1 + Math.max(-1, ...(pending?.tables ?? []).flatMap((t) => t.ops.flatMap((o) => ("ids" in o ? o.ids : []))).map((i) => Number(i?.slice(1) ?? -1))),
  );
  const [notice, setNotice] = useState("");
  const [fitWidth, setFitWidth] = useState(true);
  const [hostWidth, setHostWidth] = useState(0);
  const [yellowCount, setYellowCount] = useState<number | null>(null);

  function syncYellowCount() {
    const n = countYellowParts(findMarkedYellow(host.current));
    setYellowCount(n);
    reportYellow.current?.(n);
    return n;
  }

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const next = Math.round(el.clientWidth);
      setHostWidth((prev) => (Math.abs(prev - next) > 2 ? next : prev));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!view) return;
    const id = requestAnimationFrame(() => {
      const n = countYellowParts(findMarkedYellow(host.current));
      setYellowCount(n);
      reportYellow.current?.(n);
    });
    return () => cancelAnimationFrame(id);
  }, [view, tableOps]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let raf = 0;
    const onInput = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const n = countYellowParts(findMarkedYellow(host.current));
        setYellowCount(n);
        reportYellow.current?.(n);
      });
    };
    el.addEventListener("input", onInput, true);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("input", onInput, true);
    };
  }, []);

  const pageWidthMm = dim(view?.page.width) ?? 210;
  const pagePx = pageWidthMm * (96 / 25.4);
  const scale = fitWidth && hostWidth > 0 && hostWidth - 24 < pagePx ? Math.max(0.45, Math.min(1, (hostWidth - 24) / pagePx)) : 1;

  useImperativeHandle(
    ref,
    () => ({
      getEdits: () => {
        const read = new Map<string, ReturnType<typeof readGroup>>();
        const cells: Edits["cells"] = [];
        host.current?.querySelectorAll<HTMLElement>("[data-g]").forEach((el) => {
          const key = el.dataset.g ?? "";
          if (key.startsWith("new:")) {
            const parts = cellPieces(readGroup(el as unknown as DomLike, []));
            if (parts.length) cells.push({ id: key.slice(4), parts });
            return;
          }
          const g = groups.get(key);
          if (g) read.set(key, readGroup(el as unknown as DomLike, g.runs.map((r: RunItem) => r.id!)));
        });
        const layout: Edits["layout"] = [];
        host.current?.querySelectorAll<HTMLElement>("[data-p]").forEach((el) => {
          const now = el.style.textAlign;
          if (now && now !== (el.dataset.align ?? "") && (ALIGNS as readonly string[]).includes(now)) {
            layout.push({ id: el.dataset.p!, align: now as (typeof ALIGNS)[number] });
          }
        });
        const tables = Object.entries(tableOps)
          .filter(([, ops]) => ops.length)
          .map(([id, ops]) => ({ id, ops }));
        dirty.current = false;
        return { ...collectEdits(groups, read), layout, tables, cells };
      },
    }),
    [groups, tableOps],
  );

  /** The paragraph or table cell the cursor is in. */
  function at(selector: string): HTMLElement | null {
    const node = window.getSelection()?.anchorNode;
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    const found = el?.closest<HTMLElement>(selector) ?? null;
    return found && host.current?.contains(found) ? found : null;
  }

  function align(to: (typeof ALIGNS)[number]) {
    const p = at("[data-p]");
    if (!p) return setNotice("Click in a paragraph of the page first (the TMC header and footer keep their layout).");
    p.style.textAlign = to;
    dirty.current = true;
    setNotice("");
  }

  // Bigger or smaller letters for the selected text, in fixed steps.
  function resize(step: 1 | -1) {
    const sel = window.getSelection();
    const el = at("[data-g]");
    if (!sel || !el || sel.isCollapsed) return setNotice("Select the text first.");
    const node = sel.anchorNode!;
    const now = pointsOf(getComputedStyle(node.nodeType === 1 ? (node as Element) : node.parentElement!).fontSize) ?? 10;
    const next = step > 0 ? SIZES.find((s) => s > now) : [...SIZES].reverse().find((s) => s < now);
    if (!next) return;
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7"); // marks the selection; replaced by the real size just below
    host.current?.querySelectorAll("font[size='7']").forEach((f) => {
      const span = document.createElement("span");
      span.style.fontSize = `${next}pt`;
      while (f.firstChild) span.appendChild(f.firstChild);
      span.querySelectorAll<HTMLElement>("[style]").forEach((inner) => (inner.style.fontSize = ""));
      f.replaceWith(span);
    });
    dirty.current = true;
    setNotice("");
  }

  function table(kind: "rowAbove" | "rowBelow" | "delRow" | "colLeft" | "colRight" | "delCol") {
    const td = at("td[data-t]");
    if (!td) return setNotice("Click in a table cell first.");
    const id = td.dataset.t!;
    const t = tablesById.get(id);
    if (!t?.plain) return setNotice("This table has cells merged across rows: change its rows and columns in Word.");
    const ops = tableOps[id] ?? [];
    const grid = gridOf(t, ops);
    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    const span = Number(td.dataset.span);
    const fresh = () => `n${nextNew.current++}`;
    let op: TableOp;
    if (kind === "rowAbove" || kind === "rowBelow") {
      op = { op: "addRow", at: kind === "rowAbove" ? row : row + 1, from: row, ids: grid.rows[row].cells.map(fresh) };
    } else if (kind === "colLeft" || kind === "colRight") {
      const pos = kind === "colLeft" ? col : col + span;
      op = { op: "addCol", at: pos, ids: addColPlan(grid, pos).map((p) => (p === "widen" ? null : fresh())) };
    } else op = { op: kind, at: kind === "delRow" ? row : col };
    if (!applyOp(grid, op)) return setNotice("That would leave the table without rows or columns.");
    history.current.push(id);
    setTableOps({ ...tableOps, [id]: [...ops, op] });
    dirty.current = true;
    setNotice("");
  }

  function undoTable() {
    const id = history.current.pop();
    if (!id) return setNotice("No table change to undo.");
    setTableOps({ ...tableOps, [id]: (tableOps[id] ?? []).slice(0, -1) });
    setNotice("");
  }

  function selectElement(el: HTMLElement) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.closest<HTMLElement>("[data-g]")?.focus({ preventScroll: true });
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // Toolbar commands act on the text the person selected (the browser's own editing commands).
  function command(name: "bold" | "italic" | "underline" | "unmark"): boolean {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    const group = el?.closest("[data-g]");
    if (!sel || !group || !host.current?.contains(group)) return false;
    if (name === "unmark") {
      if (sel.isCollapsed) {
        // nothing selected: the whole piece of text the cursor is in (also when bold split it)
        const id = el?.closest("[data-r]")?.getAttribute("data-r");
        const all = id ? group.querySelectorAll(`[data-r="${CSS.escape(id)}"]`) : [];
        if (!all.length) return false;
        const last = all[all.length - 1];
        const range = document.createRange();
        range.setStart(all[0], 0);
        range.setEnd(last, last.childNodes.length);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("hiliteColor", false, "transparent");
      document.execCommand("styleWithCSS", false, "false");
      dirty.current = true;
      setNotice("");
      syncYellowCount();
      return true;
    }
    document.execCommand(name);
    dirty.current = true;
    setNotice("");
    return true;
  }

  // Jump to the next yellow part after the cursor, so none is missed.
  function nextYellow() {
    const marked = findMarkedYellow(host.current);
    setYellowCount(countYellowParts(marked));
    reportYellow.current?.(countYellowParts(marked));
    if (!marked.length) {
      setNotice("No yellow parts left on the page.");
      return;
    }
    setNotice("");
    const sel = window.getSelection();
    const anchor = sel?.anchorNode ?? null;
    const next = marked.find((e) => anchor && !e.contains(anchor) && isFollowingConnected(anchor, e)) ?? marked[0];
    selectElement(next);
  }

  // One-click human review step (Hard Rule 2): only clears the ONE yellow part the cursor is
  // currently on, then jumps straight to the next remaining yellow part. Never bulk-clears.
  function confirmAndNext() {
    const marked = findMarkedYellow(host.current);
    if (!marked.length) {
      syncYellowCount();
      setNotice("All yellow parts are cleared.");
      return;
    }
    const sel = window.getSelection();
    const anchor = sel?.anchorNode ?? null;
    const current = anchor ? marked.find((e) => e === anchor || e.contains(anchor)) : null;
    if (!current) {
      // Not positioned on a yellow part yet: jump to the first one so the person inspects it first.
      setNotice("Check this yellow part, then click Confirm & next again.");
      selectElement(marked[0]);
      return;
    }
    // Select the full run of the current yellow mark and clear only this one mark.
    const rid = current.closest("[data-r]")?.getAttribute("data-r");
    const group = current.closest("[data-g]");
    if (rid && group) {
      const all = group.querySelectorAll(`[data-r="${CSS.escape(rid)}"]`);
      if (all.length) {
        const range = document.createRange();
        range.setStart(all[0], 0);
        range.setEnd(all[all.length - 1], all[all.length - 1].childNodes.length);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    } else {
      selectElement(current);
    }
    command("unmark");
    const remaining = findMarkedYellow(host.current);
    const remainingCount = countYellowParts(remaining);
    setYellowCount(remainingCount);
    reportYellow.current?.(remainingCount);
    if (!remaining.length) {
      setNotice("All yellow parts are cleared. Ready to save and finalise.");
      return;
    }
    const next = remaining.find((e) => isFollowingConnected(current, e)) ?? remaining[0];
    setNotice("");
    selectElement(next);
  }

  const tool = "rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-800 transition-colors hover:bg-gray-100";
  const keep = (e: React.MouseEvent) => e.preventDefault(); // keep the selection in the text
  const pendingKey = useMemo(() => JSON.stringify(pending ?? null), [pending]);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xs">
      {/* Row 1: Review actions (yellow counter, Confirm & next, zoom) */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-slate-50 px-2.5 py-2" role="toolbar" aria-label="Review controls">
        <div className="flex flex-wrap items-center gap-1.5">
          {yellowCount !== null && (
            <button
              type="button"
              onMouseDown={keep}
              onClick={nextYellow}
              title={yellowCount > 0 ? "Jump to next remaining yellow part" : "All yellow parts cleared"}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset transition-colors ${
                yellowCount > 0
                  ? "bg-amber-100 text-amber-950 ring-amber-300 hover:bg-amber-200/80"
                  : "bg-emerald-50 text-emerald-800 ring-emerald-200"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${yellowCount > 0 ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden />
              {yellowCount > 0 ? `${yellowCount} yellow left` : "0 yellow left · ready"}
            </button>
          )}
          {yellowCount !== 0 && (
            <button
              type="button"
              className="rounded-md bg-tmc px-2.5 py-1 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-tmc-dark"
              onMouseDown={keep}
              onClick={confirmAndNext}
              title="Clear yellow on the current item (after you inspect it) and jump to the next yellow part"
            >
              Confirm &amp; next
            </button>
          )}
          <button type="button" className={tool} onMouseDown={keep} onClick={nextYellow}>
            Next yellow
          </button>
          <button type="button" className={tool} onMouseDown={keep} onClick={() => command("unmark")} title="Remove the yellow mark of the selected text">
            Remove yellow
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={tool}
            onMouseDown={keep}
            onClick={() => setFitWidth((f) => !f)}
            title="Switch between fitting the full page width and 100% A4 zoom"
          >
            {fitWidth ? "Zoom: Fit" : "Zoom: 100%"}
          </button>
        </div>
      </div>

      {/* Row 2: Text formatting and table tools */}
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 bg-gray-50/70 px-2.5 py-1.5" role="toolbar" aria-label="Formatting and table tools">
        <button type="button" className={`${tool} font-bold`} onMouseDown={keep} onClick={() => command("bold")} title="Bold (Ctrl+B)">
          B
        </button>
        <button type="button" className={`${tool} italic`} onMouseDown={keep} onClick={() => command("italic")} title="Italic (Ctrl+I)">
          I
        </button>
        <button type="button" className={`${tool} underline`} onMouseDown={keep} onClick={() => command("underline")} title="Underline (Ctrl+U)">
          U
        </button>
        <span className="mx-1 h-4 w-px bg-gray-300" aria-hidden />
        <button type="button" className={tool} onMouseDown={keep} onClick={() => resize(-1)} title="Smaller letters for the selected text">
          A−
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => resize(1)} title="Bigger letters for the selected text">
          A+
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => align("left")} title="Align the paragraph left">
          Left
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => align("center")} title="Centre the paragraph">
          Centre
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => align("right")} title="Align the paragraph right">
          Right
        </button>
        <span className="mx-1 h-4 w-px bg-gray-300" aria-hidden />
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("rowAbove")}>
          + Row above
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("rowBelow")}>
          + Row below
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("delRow")}>
          Delete row
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("colLeft")}>
          + Col left
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("colRight")}>
          + Col right
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("delCol")}>
          Delete col
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={undoTable}>
          Undo table
        </button>
        {notice && (
          <span role="status" className="ml-2 text-xs font-medium text-amber-800">
            {notice}
          </span>
        )}
      </div>

      <div ref={host} className="h-[78vh] overflow-auto bg-slate-100 p-3" style={{ scrollbarGutter: "stable" }}>
        <div style={{ zoom: scale < 1 ? scale : undefined }}>
          <TablesContext value={tableOps}>
            {view && <Page key={pendingKey} view={view} pending={pending} />}
          </TablesContext>
        </div>
      </div>
    </div>
  );
}

// ---- the page: rendered once, then the browser edits it in place ---------------------------

const Page = memo(function Page({ view, pending }: { view: View; pending: Edits | null }) {
  const { page } = view;
  const ctx: Ctx = { media: view.media, pending };
  return (
    <div
      className="mx-auto bg-white shadow"
      style={{
        width: `${dim(page.width) ?? 210}mm`,
        padding: `${(dim(page.top) ?? 20) / 2}mm ${dim(page.right) ?? 20}mm ${(dim(page.bottom) ?? 20) / 2}mm ${dim(page.left) ?? 20}mm`,
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: "10pt",
        color: "#000",
      }}
    >
      {view.parts.map((part, k) => (
        <div key={k} className={part.kind === "body" ? "py-2" : "border border-dashed border-gray-300 px-1"}>
          {part.kind !== "body" && (
            <div className="select-none text-[8pt] text-gray-400">{part.kind === "header" ? "Header" : "Footer"}</div>
          )}
          <Blocks blocks={part.blocks} ctx={{ ...ctx, body: part.kind === "body" }} />
        </div>
      ))}
    </div>
  );
});

/** body = false in the TMC header and footer: their text may change, their layout never (review M3). */
type Ctx = { media: Record<string, string>; pending: Edits | null; body?: boolean };

function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  return (
    <>
      {blocks.map((b, k) => (b.t === "p" ? <Paragraph key={k} p={b} ctx={ctx} /> : <TableView key={k} t={b} ctx={ctx} />))}
    </>
  );
}

const ALIGN: Record<string, CSSProperties["textAlign"]> = { left: "left", center: "center", right: "right", justify: "justify" };

function Paragraph({ p, ctx }: { p: Para; ctx: Ctx }) {
  const align = ctx.pending?.layout.find((l) => l.id === p.id)?.align ?? p.align;
  return (
    <div
      data-p={ctx.body ? p.id : undefined}
      data-align={p.align ?? ""}
      style={{
        textAlign: align ? ALIGN[align] : undefined,
        marginTop: dim(p.before) ? `${dim(p.before)}pt` : undefined,
        marginBottom: dim(p.after) ? `${dim(p.after)}pt` : undefined,
        paddingLeft: dim(p.indent) ? `${dim(p.indent)}mm` : undefined,
        whiteSpace: "pre-wrap",
        minHeight: "1.2em",
      }}
    >
      {segments(p).map((s, k) =>
        s.kind === "group" ? (
          <Group key={s.key} id={s.key} empty={!s.runs.length}>
            {s.para
              ? startParaPieces(s.para, ctx.pending).map((pc, n) => (
                  <span key={n} style={pieceStyle(null, pc)}>
                    {pc.text}
                  </span>
                ))
              : s.runs.map((run) =>
                  startPieces(run, ctx.pending).map((pc, n) => (
                    <span key={`${run.id}-${n}`} data-r={run.id!} style={pieceStyle(run, pc)}>
                      {pc.text}
                    </span>
                  )),
                )}
          </Group>
        ) : (
          <Fixed key={k} item={s.item} ctx={ctx} />
        ),
      )}
    </div>
  );
}

function pieceStyle(run: RunItem | null, pc: Piece): CSSProperties {
  const font = safeFont(run?.font);
  return {
    fontWeight: pc.b ? 700 : 400,
    fontStyle: pc.i ? "italic" : "normal",
    textDecorationLine: pc.u ? "underline" : "none",
    backgroundColor: pc.hl ? "#ffff00" : undefined,
    fontSize: dim(pc.size ?? run?.size, 100) ? `${dim(pc.size ?? run?.size, 100)}pt` : undefined,
    fontFamily: font ? `"${font}", Arial, sans-serif` : undefined,
    color: safeColor(run?.color),
  };
}

const clean = cleanDocText;

/**
 * Types text over the selection. When the selection lies inside one piece of text, the new text
 * stays in that piece: the browser would otherwise drop a piece whose whole text is replaced,
 * and the new text would take the formatting of the piece next to it.
 */
function selectionInOnePiece(): Range | null {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount === 1 ? sel.getRangeAt(0) : null;
  const pieceOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest("[data-r]") ?? null;
  if (!range || range.collapsed) return null;
  const piece = pieceOf(range.startContainer);
  return piece && piece === pieceOf(range.endContainer) ? range : null;
}

function insertPlain(text: string) {
  const range = selectionInOnePiece();
  if (!range) {
    document.execCommand("insertText", false, text);
    return;
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** One editable stretch of text. Enter is a line break; pasted text comes in as plain text. */
function Group({ id, empty, children }: { id: string; empty: boolean; children: ReactNode }) {
  const self = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = self.current;
    const typed = (e: InputEvent) => {
      if ((e.inputType === "insertText" || e.inputType === "insertReplacementText") && selectionInOnePiece()) {
        e.preventDefault();
        insertPlain(clean(e.data ?? e.dataTransfer?.getData("text/plain") ?? ""));
      }
    };
    el?.addEventListener("beforeinput", typed);
    return () => el?.removeEventListener("beforeinput", typed);
  }, []);
  return (
    <span
      ref={self}
      data-g={id}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label="Document text"
      className={`rounded-sm outline-none focus:ring-1 focus:ring-tmc/40 ${empty ? "inline-block min-w-[3em] border-b border-dotted border-gray-300" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault(); // no new paragraphs: the layout stays as the engine made it
          insertPlain("\n");
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        insertPlain(clean(e.clipboardData.getData("text/plain")).slice(0, 5000));
      }}
      onDrop={(e) => e.preventDefault()}
    >
      {children}
    </span>
  );
}

function Fixed({ item, ctx }: { item: Item; ctx: Ctx }) {
  if (item.t === "r") return <span style={pieceStyle(item, item)}>{item.text}</span>;
  if (item.t === "box")
    return (
      <div className="my-1 inline-block max-w-full border border-dashed border-gray-400 p-1 align-top">
        <Blocks blocks={item.blocks} ctx={ctx} />
      </div>
    );
  const src = item.m ? safeImage(ctx.media[item.m]) : null;
  const size: CSSProperties = { width: dim(item.w) ? `${dim(item.w)}mm` : undefined, height: dim(item.h) ? `${dim(item.h)}mm` : undefined };
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- a picture of the document itself, from the view
    <img src={src} alt="" className="inline-block align-middle" style={{ ...size, maxWidth: "100%" }} />
  ) : (
    <span className="inline-block bg-gray-100 px-1 align-middle text-[8pt] text-gray-500 ring-1 ring-gray-300" style={size}>
      picture
    </span>
  );
}

/** The rows and columns made on screen, per table number. */
const TablesContext = createContext<Record<string, TableOp[]>>({});

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28];

/** A table as it is now: the view, then the person's row and column changes in order. */
function gridOf(t: Table, ops: TableOp[]): Grid {
  return ops.reduce<Grid>((g, op) => applyOp(g, op) ?? g, baseGrid(t));
}

function TableView({ t, ctx }: { t: Table; ctx: Ctx }) {
  const ops = useContext(TablesContext)[t.id ?? ""] ?? [];
  const grid = gridOf(t, ops);
  const width = grid.cols.reduce((a, b) => a + b, 0);
  const shade = (cell: Cell | null) => safeColor(cell?.shade);
  return (
    <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: width ? `${width}mm` : "100%" }}>
      <colgroup>
        {grid.cols.map((c, k) => (
          <col key={k} style={{ width: `${c}mm` }} />
        ))}
      </colgroup>
      <tbody>
        {grid.rows.map((row, r) => {
          let col = 0;
          return (
            <tr key={row.key}>
              {row.cells.map((cell) => {
                const start = col;
                col += cell.span;
                return (
                  <td
                    key={cell.key}
                    data-t={t.id ?? undefined}
                    data-row={r}
                    data-col={start}
                    data-span={cell.span}
                    colSpan={dim(cell.span, 64)}
                    rowSpan={ops.length ? undefined : dim(cell.orig?.rowspan, 1000)}
                    style={{ border: t.lines ? "1px solid #444" : "1px dotted #d1d5db", background: shade(cell.orig), verticalAlign: "top", padding: "1px 4px" }}
                  >
                    {cell.orig ? (
                      <Blocks blocks={cell.orig.blocks} ctx={ctx} />
                    ) : (
                      <div style={{ whiteSpace: "pre-wrap", minHeight: "1.2em" }}>
                        <Group id={`new:${cell.newId}`} empty>
                          {(ctx.pending?.cells.find((x) => x.id === cell.newId)?.parts ?? []).map((pc, n) => (
                            <span key={n} style={pieceStyle(null, pc)}>
                              {pc.text}
                            </span>
                          ))}
                        </Group>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
