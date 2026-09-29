import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TOKEN = "test-token-0123456789";
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL_ = new URL(`http://127.0.0.1:${PORT}/mcp`);
let vault: string;
let proc: ChildProcess;
let client: Client;

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  return { isError: !!r.isError, text, json: () => JSON.parse(text) };
};

beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-"));
  await fs.cp(path.join(import.meta.dirname, "fixture-vault"), vault, { recursive: true });
  proc = spawn(process.execPath, [path.join(import.meta.dirname, "../src/main.ts")], {
    env: {
      ...process.env,
      OBSIDIAN_VAULT_PATH: vault,
      OBSIDIAN_MCP_PORT: String(PORT),
      OBSIDIAN_MCP_TOKEN: TOKEN,
      OBSIDIAN_MCP_WRITE_PATHS: "daily,projects",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    proc.stderr!.on("data", (d: Buffer) => (d.toString().includes("listening") ? resolve() : process.stderr.write(d)));
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
  );
});

afterAll(async () => {
  await client?.close();
  proc?.kill();
  await fs.rm(vault, { recursive: true, force: true });
});

describe("http", () => {
  it("rejects missing or wrong tokens", async () => {
    const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
    const r2 = await fetch(URL_, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(r2.status).toBe(401);
  });
});

describe("tools", () => {
  it("lists tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "append_to_note", "edit_section", "find_orphans", "find_unresolved_links", "get_backlinks",
        "get_note_info", "get_outgoing_links", "graph_neighbors", "list_notes", "list_tags", "read_note",
        "replace_in_note", "resolve_link", "search_notes", "update_frontmatter", "write_note",
      ].sort(),
    );
  });

  it("reads by name and section", async () => {
    const r = await call("read_note", { note: "Home", section: "Section A" });
    expect(r.text).toContain("path: Home.md");
    expect(r.text).toContain("### Deep");
    expect(r.text).not.toContain("Section B");
  });

  it("refuses hidden paths", async () => {
    const r = await call("read_note", { note: ".obsidian/data.json" });
    expect(r.isError).toBe(true);
    const w = await call("write_note", { path: "../escape.md", content: "x" });
    expect(w.isError).toBe(true);
  });

  it("searches Japanese text and filters by tag", async () => {
    const r = (await call("search_notes", { query: "ホーム" })).json();
    expect(r.results[0].path).toBe("Home.md");
    const t = (await call("search_notes", { query: "Alpha", tag: "daily" })).json();
    expect(t.results.map((x: { path: string }) => x.path)).toEqual(["daily/2026-09-01.md"]);
  });

  it("graph tools", async () => {
    const bl = (await call("get_backlinks", { note: "projects/Alpha.md", include_unlinked_mentions: true })).json();
    expect(bl.linked.map((x: { from: string }) => x.from).sort()).toEqual(["Home.md", "projects/Beta.md"]);
    expect(bl.unlinked_mentions.map((x: { from: string }) => x.from)).toContain("daily/2026-09-01.md");

    const g = (await call("graph_neighbors", { note: "projects/Beta.md", depth: 2 })).json();
    expect(g.nodes.find((n: { path: string }) => n.path === "Home.md").depth).toBe(1);
    expect(g.nodes.find((n: { path: string }) => n.path === "Alpha.md").depth).toBe(2);

    const un = (await call("find_unresolved_links", {})).json();
    expect(un.map((x: { target: string }) => x.target)).toEqual(["Missing Note"]);
    const orphans = (await call("find_orphans", {})).json();
    expect(orphans).toContain("Orphan.md");
    expect(orphans).not.toContain("projects/Alpha.md");
  });

  it("writes respect policy and optimistic locking", async () => {
    const denied = await call("write_note", { path: "Elsewhere.md", content: "x" });
    expect(denied.isError).toBe(true);

    const created = (await call("write_note", { path: "daily/2026-09-28", content: "# 今日\n\n## TODO\n- a\n" })).json();
    expect(created).toMatchObject({ path: "daily/2026-09-28.md", created: true });

    const ap = (await call("append_to_note", { note: "2026-09-28", heading: "TODO", content: "- b" })).json();
    expect(await fs.readFile(path.join(vault, "daily/2026-09-28.md"), "utf8")).toBe("# 今日\n\n## TODO\n- a\n- b\n");

    const stale = await call("replace_in_note", {
      note: "2026-09-28",
      old_text: "- a",
      new_text: "- A",
      expected_hash: created.hash,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/changed since/);

    const okr = await call("replace_in_note", { note: "2026-09-28", old_text: "- a", new_text: "- A", expected_hash: ap.hash });
    expect(okr.isError).toBe(false);

    await call("update_frontmatter", { note: "2026-09-28", set: { status: "wip" } });
    const info = (await call("get_note_info", { note: "2026-09-28" })).json();
    expect(info.frontmatter).toEqual({ status: "wip" });

    // New note is immediately visible to the graph.
    await call("write_note", { path: "projects/Gamma.md", content: "links [[Orphan]]" });
    const bl = (await call("get_backlinks", { note: "Orphan" })).json();
    expect(bl.linked.map((x: { from: string }) => x.from)).toEqual(["projects/Gamma.md"]);
  });
});
