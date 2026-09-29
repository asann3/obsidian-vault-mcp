import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { appendToEnd, editSection, readSection, replaceText, updateFrontmatter } from "./edit.ts";
import { assertWritable, isUnder, normalizeRel, toAbs, UserError } from "./paths.ts";
import { hashText, lc, type NoteEntry, stripMd, type VaultIndex } from "./vault-index.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
});

function wrap<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (e instanceof UserError) return { content: [{ type: "text", text: e.message }], isError: true };
      throw e;
    }
  };
}

const noteArg = z
  .string()
  .describe('Vault-relative path ("folder/note.md") or note name as used in a wikilink ("Note Name")');
const folderArg = z.string().optional().describe("Vault-relative folder to restrict to");
const hashArg = z
  .string()
  .optional()
  .describe("Hash returned by read_note; the edit is refused if the note changed since (optimistic locking)");

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s);

export function registerTools(server: McpServer, index: VaultIndex): void {
  const cfg = index.cfg;

  const getNote = async (ref: string): Promise<NoteEntry> => {
    await index.ensureFresh();
    const r = index.resolveNoteRef(ref);
    if (!r.path) throw new UserError(`note not found: ${ref}. Use search_notes or list_notes to find it.`);
    if (r.candidates.length)
      throw new UserError(`"${ref}" matches several notes; pass a full path:\n${[r.path, ...r.candidates].join("\n")}`);
    return index.note(r.path)!;
  };

  const inFolder = (p: string, folder?: string) => !folder || isUnder(p, normalizeRel(folder));

  const writeNote = async (rel: string, text: string, expectedHash?: string, mustExist = true) => {
    assertWritable(cfg, rel);
    const abs = await toAbs(cfg, rel);
    const current = await fs.readFile(abs, "utf8").catch(() => null);
    if (mustExist && current === null) throw new UserError(`note not found: ${rel}`);
    if (expectedHash && current !== null && hashText(current) !== expectedHash)
      throw new UserError(`${rel} changed since it was read (hash ${hashText(current)}); read it again before editing`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Hidden temp file: LiveSync ignores dotfiles, so only the final rename is synced.
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, abs);
    index.invalidate();
    return { path: rel, hash: hashText(text), bytes: Buffer.byteLength(text), created: current === null };
  };

  // ---------------- read ----------------

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List notes (and optionally attachments) in the vault or a folder, newest first.",
      inputSchema: z.object({
        folder: folderArg,
        include_attachments: z.boolean().default(false),
        limit: z.number().int().min(1).max(2000).default(300),
      }),
      annotations: READ,
    },
    wrap(async ({ folder, include_attachments, limit }) => {
      await index.ensureFresh();
      const items = index
        .allFiles()
        .filter((f) => inFolder(f.path, folder) && (include_attachments || f.path.toLowerCase().endsWith(".md")))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      return {
        total: items.length,
        notes: items.slice(0, limit).map((f) => ({
          path: f.path,
          modified: new Date(f.mtimeMs).toISOString(),
          size: f.size,
        })),
      };
    }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read a note's markdown. Optionally only one heading section. Returns a hash to pass to edit tools.",
      inputSchema: z.object({
        note: noteArg,
        section: z.string().optional().describe('Heading text, or "Parent > Child" for nested headings'),
        offset: z.number().int().min(0).default(0).describe("Character offset for paging long notes"),
        max_chars: z.number().int().min(1000).max(200000).default(40000),
      }),
      annotations: READ,
    },
    wrap(async ({ note, section, offset, max_chars }) => {
      const n = await getNote(note);
      const body = section ? readSection(n.text, section) : n.text;
      const chunk = body.slice(offset, offset + max_chars);
      const more = offset + chunk.length < body.length;
      const header = [
        `path: ${n.path}`,
        `hash: ${n.hash}`,
        `modified: ${new Date(n.mtimeMs).toISOString()}`,
        more ? `truncated: showing ${offset}-${offset + chunk.length} of ${body.length} chars; call again with offset=${offset + chunk.length}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return `${header}\n---- content ----\n${chunk}`;
    }),
  );

  server.registerTool(
    "get_note_info",
    {
      title: "Note metadata",
      description:
        "Metadata without the body: frontmatter, tags, aliases, headings outline, link counts, hash.",
      inputSchema: z.object({ note: noteArg }),
      annotations: READ,
    },
    wrap(async ({ note }) => {
      const n = await getNote(note);
      const out = index.outgoing(n.path);
      return {
        path: n.path,
        hash: n.hash,
        modified: new Date(n.mtimeMs).toISOString(),
        size: n.size,
        frontmatter: n.frontmatter,
        ...(n.frontmatterError ? { frontmatter_error: n.frontmatterError } : {}),
        aliases: n.aliases,
        tags: n.tags,
        headings: n.headings.map((h) => `${"#".repeat(h.level)} ${h.text} (L${h.line})`),
        outgoing_links: out.length,
        unresolved_links: out.filter((l) => !l.resolved).length,
        backlinks: new Set(index.backlinks(n.path).map((e) => e.from)).size,
      };
    }),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Full-text search. Plain mode: all whitespace-separated terms must appear (case-insensitive, works for Japanese). Regex mode: JavaScript regex. Title and alias matches rank higher.",
      inputSchema: z.object({
        query: z.string().min(1),
        regex: z.boolean().default(false),
        folder: folderArg,
        tag: z.string().optional().describe("Only notes with this tag (nested tags included), without #"),
        limit: z.number().int().min(1).max(100).default(20),
        snippets_per_note: z.number().int().min(0).max(10).default(3),
      }),
      annotations: READ,
    },
    wrap(async ({ query, regex, folder, tag, limit, snippets_per_note }) => {
      await index.ensureFresh();
      let test: (line: string) => boolean;
      let score: (n: NoteEntry) => number;
      if (regex) {
        let re: RegExp;
        try {
          re = new RegExp(query, "iu");
        } catch (e) {
          throw new UserError(`invalid regex: ${(e as Error).message}`);
        }
        test = (l) => re.test(l);
        score = (n) => (re.test(n.path) ? 10 : 0) + n.text.split("\n").filter(test).length;
      } else {
        const terms = query.split(/\s+/).filter(Boolean).map(lc);
        test = (l) => terms.some((t) => lc(l).includes(t));
        score = (n) => {
          const body = lc(n.text);
          const title = lc(n.path + " " + n.aliases.join(" "));
          if (!terms.every((t) => body.includes(t) || title.includes(t))) return 0;
          return terms.reduce((s, t) => s + (title.includes(t) ? 10 : 0) + (body.split(t).length - 1), 0);
        };
      }
      const t = tag?.replace(/^#/, "").toLowerCase();
      const hits = index
        .allNotes()
        .filter((n) => inFolder(n.path, folder))
        .filter((n) => !t || n.tags.some((x) => x.toLowerCase() === t || x.toLowerCase().startsWith(t + "/")))
        .map((n) => ({ n, s: score(n) }))
        .filter((h) => h.s > 0)
        .sort((a, b) => b.s - a.s || b.n.mtimeMs - a.n.mtimeMs);
      return {
        total: hits.length,
        results: hits.slice(0, limit).map(({ n, s }) => ({
          path: n.path,
          score: s,
          snippets: n.text
            .split("\n")
            .map((line, i) => ({ line: i + 1, text: clip(line.trim()) }))
            .filter((x) => x.text && test(x.text))
            .slice(0, snippets_per_note),
        })),
      };
    }),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "All tags in the vault with note counts.",
      inputSchema: z.object({ prefix: z.string().optional(), folder: folderArg }),
      annotations: READ,
    },
    wrap(async ({ prefix, folder }) => {
      await index.ensureFresh();
      const counts = new Map<string, number>();
      for (const n of index.allNotes())
        if (inFolder(n.path, folder)) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      const p = prefix?.replace(/^#/, "").toLowerCase();
      return [...counts]
        .filter(([t]) => !p || t.toLowerCase().startsWith(p))
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count }));
    }),
  );

  // ---------------- graph ----------------

  server.registerTool(
    "resolve_link",
    {
      title: "Resolve wikilink",
      description: "Show which file a [[link]] points to, as Obsidian would resolve it from a given note.",
      inputSchema: z.object({
        link: z.string().describe('Link text, e.g. "Note", "folder/Note#Heading", "[[Note|alias]]"'),
        from: z.string().optional().describe("Vault-relative path of the note containing the link"),
      }),
      annotations: READ,
    },
    wrap(async ({ link, from }) => {
      await index.ensureFresh();
      const inner = link.trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0]!;
      const [target, ...sub] = inner.split("#");
      return { link, ...index.resolveLinkpath(target!, from ? normalizeRel(from) : ""), subpath: sub.length ? "#" + sub.join("#") : "" };
    }),
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Backlinks",
      description:
        "Notes that link to this note, with the linking line as context. Optionally also plain-text (unlinked) mentions of its title/aliases.",
      inputSchema: z.object({
        note: noteArg,
        include_unlinked_mentions: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: READ,
    },
    wrap(async ({ note, include_unlinked_mentions, limit }) => {
      const n = await getNote(note);
      const edges = index.backlinks(n.path);
      const linked = edges.slice(0, limit).map((e) => {
        const src = index.note(e.from)!;
        return {
          from: e.from,
          line: e.link.line,
          ...(e.link.subpath ? { subpath: e.link.subpath } : {}),
          ...(e.link.embed ? { embed: true } : {}),
          ...(e.link.kind === "frontmatter" ? { in_frontmatter: true } : {}),
          context: e.link.line ? clip(src.text.split("\n")[e.link.line - 1]!.trim()) : undefined,
        };
      });
      const result: Record<string, unknown> = {
        note: n.path,
        linked_count: edges.length,
        linking_notes: new Set(edges.map((e) => e.from)).size,
        linked,
      };
      if (include_unlinked_mentions) {
        const names = [stripMd(path.posix.basename(n.path)), ...n.aliases].filter((x) => x.length >= 2).map(lc);
        const linkedFrom = new Set(edges.map((e) => e.from));
        const mentions: { from: string; line: number; context: string }[] = [];
        for (const other of index.allNotes()) {
          if (other.path === n.path || linkedFrom.has(other.path)) continue;
          other.text.split("\n").forEach((line, i) => {
            if (mentions.length < limit && names.some((nm) => lc(line).includes(nm)))
              mentions.push({ from: other.path, line: i + 1, context: clip(line.trim()) });
          });
        }
        result.unlinked_mentions = mentions;
      }
      return result;
    }),
  );

  server.registerTool(
    "get_outgoing_links",
    {
      title: "Outgoing links",
      description: "Links from this note (wikilinks, markdown links, embeds, frontmatter links) and where they resolve.",
      inputSchema: z.object({ note: noteArg, unresolved_only: z.boolean().default(false) }),
      annotations: READ,
    },
    wrap(async ({ note, unresolved_only }) => {
      const n = await getNote(note);
      return index
        .outgoing(n.path)
        .filter((l) => !unresolved_only || !l.resolved)
        .map((l) => ({
          target: l.target + l.subpath,
          resolved: l.resolved,
          line: l.line,
          ...(l.display ? { display: l.display } : {}),
          ...(l.embed ? { embed: true } : {}),
          ...(l.kind !== "wiki" ? { kind: l.kind } : {}),
          ...(l.ambiguous ? { ambiguous: l.ambiguous } : {}),
        }));
    }),
  );

  server.registerTool(
    "graph_neighbors",
    {
      title: "Graph neighborhood",
      description:
        "Breadth-first walk of the link graph around a note: which notes are within N hops, following outgoing links, backlinks, or both.",
      inputSchema: z.object({
        note: noteArg,
        depth: z.number().int().min(1).max(4).default(1),
        direction: z.enum(["both", "out", "in"]).default("both"),
        include_attachments: z.boolean().default(false),
        max_nodes: z.number().int().min(1).max(1000).default(150),
      }),
      annotations: READ,
    },
    wrap(async ({ note, depth, direction, include_attachments, max_nodes }) => {
      const start = await getNote(note);
      const keep = (p: string) => include_attachments || p.toLowerCase().endsWith(".md");
      const dist = new Map<string, number>([[start.path, 0]]);
      const edges = new Set<string>();
      let frontier = [start.path];
      let truncated = false;
      for (let d = 1; d <= depth && frontier.length; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          const nbrs: [string, string][] = [];
          if (direction !== "in")
            for (const l of index.outgoing(cur)) if (l.resolved && l.resolved !== cur) nbrs.push([cur, l.resolved]);
          if (direction !== "out") for (const e of index.backlinks(cur)) nbrs.push([e.from, cur]);
          for (const [a, b] of nbrs) {
            const other = a === cur ? b : a;
            if (!keep(other)) continue;
            if (!dist.has(other)) {
              if (dist.size >= max_nodes) {
                truncated = true;
                continue;
              }
              dist.set(other, d);
              next.push(other);
            }
            edges.add(`${a}\u0000${b}`);
          }
        }
        frontier = next;
      }
      return {
        center: start.path,
        truncated,
        nodes: [...dist].map(([p, d]) => ({ path: p, depth: d })).sort((a, b) => a.depth - b.depth),
        edges: [...edges].map((e) => {
          const [from, to] = e.split("\u0000");
          return { from, to };
        }),
      };
    }),
  );

  server.registerTool(
    "find_unresolved_links",
    {
      title: "Unresolved links",
      description: "Links pointing to notes that do not exist yet, grouped by target.",
      inputSchema: z.object({ folder: folderArg, limit: z.number().int().min(1).max(1000).default(200) }),
      annotations: READ,
    },
    wrap(async ({ folder, limit }) => {
      await index.ensureFresh();
      const byTarget = new Map<string, Set<string>>();
      for (const n of index.allNotes()) {
        if (!inFolder(n.path, folder)) continue;
        for (const l of index.outgoing(n.path))
          if (!l.resolved) byTarget.set(l.target, (byTarget.get(l.target) ?? new Set()).add(n.path));
      }
      return [...byTarget]
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, limit)
        .map(([target, from]) => ({ target, referenced_by: [...from] }));
    }),
  );

  server.registerTool(
    "find_orphans",
    {
      title: "Orphan notes",
      description: "Notes that no other note links to (optionally: that also link to nothing).",
      inputSchema: z.object({ folder: folderArg, also_no_outgoing: z.boolean().default(false) }),
      annotations: READ,
    },
    wrap(async ({ folder, also_no_outgoing }) => {
      await index.ensureFresh();
      return index
        .allNotes()
        .filter((n) => inFolder(n.path, folder) && index.backlinks(n.path).length === 0)
        .filter((n) => !also_no_outgoing || !index.outgoing(n.path).some((l) => l.resolved && l.resolved !== n.path))
        .map((n) => n.path);
    }),
  );

  // ---------------- write ----------------

  server.registerTool(
    "write_note",
    {
      title: "Create or overwrite note",
      description:
        "Create a new note at a path. Overwriting an existing note requires overwrite=true (prefer edit_section / replace_in_note for changes).",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path ending in .md"),
        content: z.string(),
        overwrite: z.boolean().default(false),
        expected_hash: hashArg,
      }),
      annotations: OVERWRITE,
    },
    wrap(async ({ path: p, content, overwrite, expected_hash }) => {
      const rel = normalizeRel(p.toLowerCase().endsWith(".md") ? p : p + ".md");
      const exists = await fs
        .access(await toAbs(cfg, rel))
        .then(() => true)
        .catch(() => false);
      if (exists && !overwrite) throw new UserError(`${rel} already exists; pass overwrite=true or use an edit tool`);
      return writeNote(rel, content, expected_hash, false);
    }),
  );

  server.registerTool(
    "append_to_note",
    {
      title: "Append to note",
      description: "Append text to the end of a note, or to the end of a heading section.",
      inputSchema: z.object({
        note: noteArg,
        content: z.string(),
        heading: z.string().optional().describe('Append at the end of this section ("Parent > Child" allowed)'),
        expected_hash: hashArg,
      }),
      annotations: WRITE,
    },
    wrap(async ({ note, content, heading, expected_hash }) => {
      const n = await getNote(note);
      const text = heading ? editSection(n.text, heading, "append", content) : appendToEnd(n.text, content);
      return writeNote(n.path, text, expected_hash ?? n.hash);
    }),
  );

  server.registerTool(
    "edit_section",
    {
      title: "Edit heading section",
      description:
        "Replace the body of a heading section, or insert text at its start/end. The heading line itself is kept.",
      inputSchema: z.object({
        note: noteArg,
        heading: z.string().describe('Heading text, or "Parent > Child"'),
        operation: z.enum(["replace", "prepend", "append"]),
        content: z.string(),
        expected_hash: hashArg,
      }),
      annotations: OVERWRITE,
    },
    wrap(async ({ note, heading, operation, content, expected_hash }) => {
      const n = await getNote(note);
      return writeNote(n.path, editSection(n.text, heading, operation, content), expected_hash ?? n.hash);
    }),
  );

  server.registerTool(
    "replace_in_note",
    {
      title: "Find and replace in note",
      description:
        "Replace an exact text span. Fails unless old_text occurs exactly expected_count times, so include enough context.",
      inputSchema: z.object({
        note: noteArg,
        old_text: z.string(),
        new_text: z.string(),
        expected_count: z.number().int().min(1).default(1),
        expected_hash: hashArg,
      }),
      annotations: OVERWRITE,
    },
    wrap(async ({ note, old_text, new_text, expected_count, expected_hash }) => {
      const n = await getNote(note);
      return writeNote(n.path, replaceText(n.text, old_text, new_text, expected_count), expected_hash ?? n.hash);
    }),
  );

  server.registerTool(
    "update_frontmatter",
    {
      title: "Update frontmatter",
      description: "Set or remove YAML frontmatter properties, preserving other keys and comments.",
      inputSchema: z.object({
        note: noteArg,
        set: z.record(z.string(), z.unknown()).default({}),
        remove: z.array(z.string()).default([]),
        expected_hash: hashArg,
      }),
      annotations: WRITE,
    },
    wrap(async ({ note, set, remove, expected_hash }) => {
      const n = await getNote(note);
      return writeNote(n.path, updateFrontmatter(n.text, set, remove), expected_hash ?? n.hash);
    }),
  );
}
