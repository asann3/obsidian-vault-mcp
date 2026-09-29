import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { editSection, readSection, replaceText, updateFrontmatter } from "../src/edit.ts";
import { parseNote } from "../src/parse.ts";
import { assertWritable, normalizeRel } from "../src/paths.ts";
import { VaultIndex } from "../src/vault-index.ts";

const FIXTURE = path.join(import.meta.dirname, "fixture-vault");

describe("parseNote", () => {
  const text = `---
aliases: [A1]
tags: [x]
up: "[[Parent]]"
---
# Title #inline
[[One]] [[Two#Head|shown]] ![[img.png]] [md](Three.md#sec) [web](https://e.com)
| [[Four\\|alias]] |
\`\`\`
[[NotLink]] #nottag
\`\`\`
\`[[NoInline]]\` %%[[NoComment]]%% #tag/sub #123 ^block-1
`;
  const p = parseNote(text);

  it("extracts links outside code/comments", () => {
    expect(p.links.map((l) => l.target)).toEqual(["Parent", "One", "Two", "img.png", "Four", "Three.md"]);
    const two = p.links.find((l) => l.target === "Two")!;
    expect(two).toMatchObject({ subpath: "#Head", display: "shown", line: 7 });
    expect(p.links.find((l) => l.target === "img.png")!.embed).toBe(true);
    expect(p.links.find((l) => l.target === "Four")!.display).toBe("alias");
    expect(p.links.find((l) => l.target === "Three.md")!.subpath).toBe("#sec");
  });

  it("extracts tags, aliases, headings, blocks", () => {
    expect(p.tags.sort()).toEqual(["inline", "tag/sub", "x"]);
    expect(p.aliases).toEqual(["A1"]);
    expect(p.headings).toEqual([{ level: 1, text: "Title #inline", line: 6 }]);
    expect(p.blockIds).toEqual(["block-1"]);
  });
});

describe("paths", () => {
  it("rejects traversal and hidden paths", () => {
    expect(() => normalizeRel("../x.md")).toThrow();
    expect(() => normalizeRel("/etc/passwd")).toThrow();
    expect(() => normalizeRel(".obsidian/plugins/obsidian-livesync/data.json")).toThrow();
    expect(() => normalizeRel("a/../../b")).toThrow();
    expect(normalizeRel("./a//b.md")).toBe("a/b.md");
  });

  it("enforces write policy", () => {
    const cfg = { ...loadConfig({ OBSIDIAN_VAULT_PATH: FIXTURE, OBSIDIAN_MCP_WRITE_PATHS: "daily,inbox" }) };
    expect(() => assertWritable(cfg, "daily/x.md")).not.toThrow();
    expect(() => assertWritable(cfg, "projects/x.md")).toThrow(/limited/);
    expect(() => assertWritable(cfg, "daily/CLAUDE.md")).toThrow(/protected/);
    expect(() => assertWritable(cfg, "daily/x.png")).toThrow(/\.md/);
  });
});

describe("VaultIndex", async () => {
  const idx = new VaultIndex(loadConfig({ OBSIDIAN_VAULT_PATH: FIXTURE }));
  await idx.ensureFresh();

  it("skips hidden folders", () => {
    expect(idx.allFiles().some((f) => f.path.startsWith(".obsidian"))).toBe(false);
  });

  it("resolves like Obsidian", () => {
    const out = idx.outgoing("Home.md");
    const by = (t: string) => out.find((l) => l.target === t)!;
    // Same-named Alpha: root copy shares Home's folder.
    expect(by("Alpha").resolved).toBe("Alpha.md");
    expect(by("Alpha").ambiguous).toEqual(["projects/Alpha.md"]);
    expect(by("projects/Beta").resolved).toBe("projects/Beta.md");
    expect(by("Missing Note").resolved).toBeNull();
    expect(by("diagram.png").resolved).toBe("attachments/diagram.png");
    expect(by("daily/2026-09-01.md").resolved).toBe("daily/2026-09-01.md");
    expect(by("projects/Alpha").kind).toBe("frontmatter");
    // From projects/, bare "Alpha" prefers the sibling.
    expect(idx.resolveLinkpath("Alpha", "projects/Beta.md").resolved).toBe("projects/Alpha.md");
    expect(idx.resolveLinkpath("NotALink", "Home.md").resolved).toBeNull();
  });

  it("builds backlinks and resolves note refs by alias", () => {
    expect(idx.backlinks("projects/Alpha.md").map((e) => e.from).sort()).toEqual(["Home.md", "projects/Beta.md"]);
    expect(idx.backlinks("Orphan.md")).toEqual([]);
    expect(idx.resolveNoteRef("ホーム").path).toBe("Home.md");
    expect(idx.resolveNoteRef("[[Beta#Goals]]").path).toBe("projects/Beta.md");
    // Obsidian does not resolve [[alias]] links in the graph.
    expect(idx.resolveLinkpath("ホーム", "x.md").resolved).toBeNull();
  });
});

describe("edit", () => {
  const doc = "# T\nintro\n\n## A\na1\n\n### A.1\nx\n\n## B\nb1\n";

  it("reads and edits sections including subsections", () => {
    expect(readSection(doc, "A")).toBe("## A\na1\n\n### A.1\nx\n");
    expect(editSection(doc, "A", "append", "new")).toBe("# T\nintro\n\n## A\na1\n\n### A.1\nx\nnew\n\n## B\nb1\n");
    expect(editSection(doc, "A", "replace", "only")).toBe("# T\nintro\n\n## A\nonly\n\n## B\nb1\n");
    expect(editSection(doc, "B", "append", "b2")).toBe("# T\nintro\n\n## A\na1\n\n### A.1\nx\n\n## B\nb1\nb2\n");
    expect(editSection(doc, "A > A.1", "prepend", "p")).toContain("### A.1\np\nx");
  });

  it("rejects ambiguous and missing headings", () => {
    const dup = "## X\n### Same\n1\n## Y\n### Same\n2\n";
    expect(() => findOrThrow(dup, "Same")).toThrow(/ambiguous/);
    expect(editSection(dup, "Y > Same", "replace", "z")).toBe("## X\n### Same\n1\n## Y\n### Same\nz\n");
    expect(() => findOrThrow(doc, "Nope")).toThrow(/not found/);
  });

  it("replaceText requires exact count", () => {
    expect(() => replaceText("a a", "a", "b")).toThrow(/2 time/);
    expect(replaceText("a a", "a", "b", 2)).toBe("b b");
  });

  it("updates frontmatter preserving comments", () => {
    const t = "---\n# keep\ntitle: x\nold: 1\n---\nbody\n";
    const r = updateFrontmatter(t, { status: "done", tags: ["a"] }, ["old"]);
    expect(r).toBe("---\n# keep\ntitle: x\nstatus: done\ntags:\n  - a\n---\nbody\n");
    expect(updateFrontmatter("body\n", { a: 1 }, [])).toBe("---\na: 1\n---\nbody\n");
  });
});

function findOrThrow(text: string, spec: string) {
  return readSection(text, spec);
}
