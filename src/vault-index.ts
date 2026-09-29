import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { type LinkRef, type ParsedNote, parseNote } from "./parse.ts";
import { isUnder } from "./paths.ts";

export interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface NoteEntry extends FileEntry, ParsedNote {
  hash: string;
  text: string;
}

export interface ResolvedLink extends LinkRef {
  /** Resolved vault path, or null when unresolved. */
  resolved: string | null;
  via?: "path" | "relative" | "suffix" | "name" | "alias" | "self";
  /** Other candidates when a bare name matched several files. */
  ambiguous?: string[];
}

export interface Edge {
  from: string;
  link: ResolvedLink;
}

const RESCAN_TTL_MS = 1500;

export const hashText = (t: string) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);
export const stripMd = (p: string) => (p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p);
export const lc = (s: string) => s.normalize("NFC").toLowerCase();

export class VaultIndex {
  readonly cfg: Config;
  private files = new Map<string, FileEntry>();
  private notes = new Map<string, NoteEntry>();
  private byLowerPath = new Map<string, string>();
  private byName = new Map<string, string[]>();
  private byAlias = new Map<string, string[]>();
  private out = new Map<string, ResolvedLink[]>();
  private back = new Map<string, Edge[]>();
  private lastScan = 0;
  private scanning: Promise<void> | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /** Force the next access to rescan (call after writes). */
  invalidate(): void {
    this.lastScan = 0;
  }

  async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastScan < RESCAN_TTL_MS) return;
    this.scanning ??= this.rescan().finally(() => (this.scanning = null));
    await this.scanning;
  }

  private async walk(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    const visit = async (relDir: string) => {
      const dirents = await fs.readdir(path.join(this.cfg.vaultRoot, relDir), { withFileTypes: true });
      await Promise.all(
        dirents.map(async (d) => {
          if (d.name.startsWith(".")) return;
          const rel = relDir ? `${relDir}/${d.name}` : d.name;
          if (this.cfg.ignorePaths.some((p) => isUnder(rel, p))) return;
          if (d.isDirectory()) return visit(rel);
          if (!d.isFile()) return;
          const st = await fs.stat(path.join(this.cfg.vaultRoot, rel)).catch(() => null);
          if (st) out.push({ path: rel.normalize("NFC"), mtimeMs: st.mtimeMs, size: st.size });
        }),
      );
    };
    await visit("");
    return out;
  }

  private async rescan(): Promise<void> {
    const entries = await this.walk();
    const nextFiles = new Map(entries.map((e) => [e.path, e]));
    const nextNotes = new Map<string, NoteEntry>();
    await Promise.all(
      entries
        .filter((e) => e.path.toLowerCase().endsWith(".md"))
        .map(async (e) => {
          const prev = this.notes.get(e.path);
          if (prev && prev.mtimeMs === e.mtimeMs && prev.size === e.size) return void nextNotes.set(e.path, prev);
          const text = await fs.readFile(path.join(this.cfg.vaultRoot, e.path), "utf8").catch(() => null);
          if (text !== null) nextNotes.set(e.path, { ...e, ...parseNote(text), hash: hashText(text), text });
        }),
    );
    this.files = nextFiles;
    this.notes = nextNotes;
    this.rebuildLookups();
    this.rebuildGraph();
    this.lastScan = Date.now();
  }

  private rebuildLookups(): void {
    this.byLowerPath.clear();
    this.byName.clear();
    this.byAlias.clear();
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };
    for (const p of this.files.keys()) {
      this.byLowerPath.set(lc(p), p);
      const base = path.posix.basename(p);
      push(this.byName, lc(base), p);
      if (base.toLowerCase().endsWith(".md")) push(this.byName, lc(stripMd(base)), p);
    }
    for (const n of this.notes.values()) for (const a of n.aliases) push(this.byAlias, lc(a), n.path);
  }

  private rebuildGraph(): void {
    this.out.clear();
    this.back.clear();
    for (const n of this.notes.values()) {
      const resolved = n.links.map((l) => this.resolveLinkRef(l, n.path));
      this.out.set(n.path, resolved);
      for (const r of resolved) {
        if (!r.resolved || r.resolved === n.path) continue;
        const arr = this.back.get(r.resolved);
        const edge = { from: n.path, link: r };
        if (arr) arr.push(edge);
        else this.back.set(r.resolved, [edge]);
      }
    }
  }

  private pick(candidates: string[], source: string): { best: string; others: string[] } {
    const dir = path.posix.dirname(source);
    const sorted = [...candidates].sort((a, b) => {
      const sa = path.posix.dirname(a) === dir ? 0 : 1;
      const sb = path.posix.dirname(b) === dir ? 0 : 1;
      if (sa !== sb) return sa - sb;
      // Prefer notes over same-named attachments, then shallower paths.
      const ma = a.toLowerCase().endsWith(".md") ? 0 : 1;
      const mb = b.toLowerCase().endsWith(".md") ? 0 : 1;
      if (ma !== mb) return ma - mb;
      return a.split("/").length - b.split("/").length || a.localeCompare(b);
    });
    return { best: sorted[0]!, others: sorted.slice(1) };
  }

  /** Resolve a link path the way Obsidian does (approximately). */
  resolveLinkpath(
    linkpath: string,
    source: string,
    allowAlias = false,
  ): { resolved: string | null; via?: ResolvedLink["via"]; ambiguous?: string[] } {
    let lp = linkpath.trim().replace(/\\/g, "/").normalize("NFC");
    if (!lp) return { resolved: source, via: "self" };
    const tryPath = (p: string) => this.byLowerPath.get(lc(p)) ?? this.byLowerPath.get(lc(p + ".md")) ?? null;

    if (lp.startsWith("./") || lp.startsWith("../")) {
      const joined = path.posix.normalize(path.posix.join(path.posix.dirname(source), lp));
      const hit = joined.startsWith("..") ? null : tryPath(joined);
      if (hit) return { resolved: hit, via: "relative" };
    }
    lp = lp.replace(/^\/+/, "");
    if (lp.includes("/")) {
      const exact = tryPath(lp);
      if (exact) return { resolved: exact, via: "path" };
      const suffix = lc(lp);
      const hits = [...this.byLowerPath.entries()]
        .filter(([k]) => k.endsWith("/" + suffix) || k.endsWith("/" + suffix + ".md"))
        .map(([, v]) => v);
      if (hits.length) {
        const { best, others } = this.pick(hits, source);
        return { resolved: best, via: "suffix", ...(others.length ? { ambiguous: others } : {}) };
      }
      return { resolved: null };
    }

    const byName = this.byName.get(lc(lp));
    if (byName?.length) {
      const { best, others } = this.pick(byName, source);
      return { resolved: best, via: "name", ...(others.length ? { ambiguous: others } : {}) };
    }
    // Obsidian itself does not resolve [[alias]]; only callers opt in.
    const byAlias = allowAlias ? this.byAlias.get(lc(lp)) : undefined;
    if (byAlias?.length) {
      const { best, others } = this.pick(byAlias, source);
      return { resolved: best, via: "alias", ...(others.length ? { ambiguous: others } : {}) };
    }
    return { resolved: null };
  }

  private resolveLinkRef(l: LinkRef, source: string): ResolvedLink {
    return { ...l, ...this.resolveLinkpath(l.target, source) };
  }

  // ---- queries (call ensureFresh() first) ----

  allFiles(): FileEntry[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  allNotes(): NoteEntry[] {
    return [...this.notes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  note(p: string): NoteEntry | undefined {
    return this.notes.get(p);
  }

  hasFile(p: string): boolean {
    return this.files.has(p);
  }

  outgoing(p: string): ResolvedLink[] {
    return this.out.get(p) ?? [];
  }

  backlinks(p: string): Edge[] {
    return this.back.get(p) ?? [];
  }

  /** Find the note a caller means: exact path, path without .md, or link-style name. */
  resolveNoteRef(ref: string): { path: string | null; candidates: string[] } {
    const s = ref.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0]!.split("#")[0]!.trim().normalize("NFC");
    const direct = this.byLowerPath.get(lc(s)) ?? this.byLowerPath.get(lc(s + ".md"));
    if (direct && this.notes.has(direct)) return { path: direct, candidates: [] };
    const r = this.resolveLinkpath(s, "", true);
    if (r.resolved && this.notes.has(r.resolved)) {
      return { path: r.resolved, candidates: r.ambiguous?.filter((c) => this.notes.has(c)) ?? [] };
    }
    return { path: null, candidates: [] };
  }
}
