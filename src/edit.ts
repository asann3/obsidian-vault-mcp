import { Document, parseDocument } from "yaml";
import { parseNote, splitFrontmatter } from "./parse.ts";
import { UserError } from "./paths.ts";

export interface Section {
  heading: string;
  level: number;
  /** 0-based index of the heading line. */
  headingIdx: number;
  /** 0-based exclusive end index (next heading of same/higher level, or EOF). */
  endIdx: number;
}

const norm = (s: string) => s.replace(/^#+\s*/, "").trim().normalize("NFC").toLowerCase();

/**
 * Locate a heading section. `spec` is "Heading" or a path like
 * "Parent > Child" to disambiguate repeated headings.
 */
export function findSection(text: string, spec: string): Section {
  const { headings } = parseNote(text);
  const want = spec.split(">").map(norm).filter(Boolean);
  if (!want.length) throw new UserError("heading must not be empty");
  const lineCount = text.split("\n").length;
  const stack: { level: number; text: string }[] = [];
  const matches: Section[] = [];
  headings.forEach((h, i) => {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    if (norm(h.text) !== want.at(-1)) return;
    // Remaining segments must appear, in order, among the ancestors.
    let j = want.length - 2;
    for (let k = stack.length - 2; k >= 0 && j >= 0; k--) if (norm(stack[k]!.text) === want[j]) j--;
    if (j >= 0) return;
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    matches.push({ heading: h.text, level: h.level, headingIdx: h.line - 1, endIdx: next ? next.line - 1 : lineCount });
  });
  if (!matches.length) {
    const avail = headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n");
    throw new UserError(`heading not found: ${spec}\nAvailable headings:\n${avail || "(none)"}`);
  }
  if (matches.length > 1)
    throw new UserError(
      `heading "${spec}" is ambiguous (lines ${matches.map((m) => m.headingIdx + 1).join(", ")}); use "Parent > ${spec}"`,
    );
  return matches[0]!;
}

export function readSection(text: string, spec: string): string {
  const s = findSection(text, spec);
  return text.split("\n").slice(s.headingIdx, s.endIdx).join("\n").replace(/\s+$/, "") + "\n";
}

const asLines = (content: string) => content.replace(/\s+$/, "").split("\n");

export type SectionOp = "append" | "prepend" | "replace";

export function editSection(text: string, spec: string, op: SectionOp, content: string): string {
  const s = findSection(text, spec);
  const lines = text.split("\n");
  const add = asLines(content);
  if (op === "prepend") {
    lines.splice(s.headingIdx + 1, 0, ...add);
    return lines.join("\n");
  }
  // Normalize the gap before the next heading (or the final newline) to one blank line.
  let end = s.endIdx;
  while (end > s.headingIdx + 1 && lines[end - 1]!.trim() === "") end--;
  const trailing = [""];
  if (op === "append") {
    lines.splice(end, s.endIdx - end, ...add, ...trailing);
  } else {
    lines.splice(s.headingIdx + 1, s.endIdx - s.headingIdx - 1, ...add, ...trailing);
  }
  return lines.join("\n");
}

export function appendToEnd(text: string, content: string): string {
  if (!text.trim()) return content.replace(/\s+$/, "") + "\n";
  return text.replace(/\s+$/, "") + "\n" + content.replace(/\s+$/, "") + "\n";
}

export function replaceText(text: string, oldStr: string, newStr: string, expected = 1): string {
  if (!oldStr) throw new UserError("old_text must not be empty");
  const count = text.split(oldStr).length - 1;
  if (count !== expected)
    throw new UserError(`old_text occurs ${count} time(s), expected ${expected}. Include more surrounding text to make it unique.`);
  return text.split(oldStr).join(newStr);
}

export function updateFrontmatter(text: string, set: Record<string, unknown>, remove: string[]): string {
  const fm = splitFrontmatter(text);
  const lines = text.split("\n");
  const body = lines.slice(fm.bodyStartLine).join("\n");
  let doc: Document = fm.raw !== null ? parseDocument(fm.raw) : new Document({});
  if (doc.errors.length) throw new UserError(`frontmatter is not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  if (doc.contents === null) doc = new Document({});
  for (const [k, v] of Object.entries(set)) doc.set(k, v);
  for (const k of remove) doc.delete(k);
  const yaml = Object.keys(doc.toJSON() ?? {}).length ? doc.toString() : "";
  if (!yaml) return body.replace(/^\n+/, "");
  return `---\n${yaml}---\n${body}`;
}
