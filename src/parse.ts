import { parse as parseYaml } from "yaml";

export interface LinkRef {
  /** Link path as written, without subpath (may be "" for same-note links). */
  target: string;
  /** "#Heading", "#^block" or "" */
  subpath: string;
  display: string | null;
  embed: boolean;
  kind: "wiki" | "markdown" | "frontmatter";
  /** 1-based line in the full file (0 for frontmatter-property links). */
  line: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  /** Line index (0-based) where the body starts. */
  bodyStartLine: number;
  aliases: string[];
  tags: string[];
  headings: Heading[];
  blockIds: string[];
  links: LinkRef[];
}

export interface FrontmatterSplit {
  raw: string | null;
  /** 0-based line index of the first body line. */
  bodyStartLine: number;
}

export function splitFrontmatter(text: string): FrontmatterSplit {
  if (!/^---\r?\n/.test(text)) return { raw: null, bodyStartLine: 0 };
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*\r?$/.test(lines[i]!)) {
      return { raw: lines.slice(1, i).join("\n"), bodyStartLine: i + 1 };
    }
  }
  return { raw: null, bodyStartLine: 0 };
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/**
 * Replace code, math, and comments with spaces (keeping newlines) so that
 * link/tag/heading regexes never match inside them while offsets stay valid.
 */
export function maskNonProse(body: string): string {
  const lines = body.split("\n");
  let fence: { ch: string; len: number } | null = null;
  let math = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
      lines[i] = blank(line);
      continue;
    }
    if (math) {
      if (/^\s*\$\$\s*$/.test(line)) math = false;
      lines[i] = blank(line);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      lines[i] = blank(line);
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      math = true;
      lines[i] = blank(line);
    }
  }
  return lines
    .join("\n")
    .replace(/%%[\s\S]*?%%/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, blank);
}

const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MD_LINK_RE = /(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const TAG_RE = /(^|[\s(（、。,])#([\p{L}\p{N}\p{M}_\-/]+)/gu;

function splitSubpath(s: string): { target: string; subpath: string } {
  const i = s.indexOf("#");
  return i < 0 ? { target: s.trim(), subpath: "" } : { target: s.slice(0, i).trim(), subpath: s.slice(i).trim() };
}

export function parseWikiInner(inner: string): { target: string; subpath: string; display: string | null } {
  // Inside tables the alias pipe is escaped as "\|".
  const m = inner.match(/^((?:[^|\\]|\\(?!\|))*)\\?\|([\s\S]*)$/);
  const linkPart = m ? m[1]! : inner;
  const display = m ? m[2]!.trim() : null;
  return { ...splitSubpath(linkPart), display };
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function collectFrontmatterLinks(value: unknown, out: LinkRef[]): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(WIKI_RE)) {
      out.push({ ...parseWikiInner(m[2]!), embed: m[1] === "!", kind: "frontmatter", line: 0 });
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectFrontmatterLinks(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectFrontmatterLinks(v, out);
  }
}

const toStringList = (v: unknown, sep: RegExp): string[] =>
  (v == null ? [] : Array.isArray(v) ? v : typeof v === "string" ? v.split(sep) : [v])
    .filter((x) => x != null)
    .map((x) => String(x).trim())
    .filter(Boolean);

export function parseNote(text: string): ParsedNote {
  const fm = splitFrontmatter(text);
  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | null = null;
  if (fm.raw !== null) {
    try {
      const v = parseYaml(fm.raw);
      frontmatter = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch (e) {
      frontmatterError = (e as Error).message.split("\n")[0]!;
    }
  }

  const lines = text.split("\n");
  const body = lines.slice(fm.bodyStartLine).join("\n");
  const masked = maskNonProse(body);
  const starts: number[] = [0];
  for (let i = 0; i < masked.length; i++) if (masked[i] === "\n") starts.push(i + 1);
  const lineOf = (off: number) => lineAt(starts, off) + fm.bodyStartLine + 1;

  const links: LinkRef[] = [];
  if (frontmatter) collectFrontmatterLinks(frontmatter, links);
  for (const m of masked.matchAll(WIKI_RE)) {
    const inner = body.slice(m.index! + m[1]!.length + 2, m.index! + m[0].length - 2);
    links.push({ ...parseWikiInner(inner), embed: m[1] === "!", kind: "wiki", line: lineOf(m.index!) });
  }
  for (const m of masked.matchAll(MD_LINK_RE)) {
    const orig = body.slice(m.index!, m.index! + m[0].length);
    const mm = orig.match(new RegExp(MD_LINK_RE.source))!;
    let href = mm[3]!;
    if (href.startsWith("<")) href = href.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
    const { target, subpath } = splitSubpath(safeDecode(href));
    links.push({ target, subpath, display: mm[2]!, embed: mm[1] === "!", kind: "markdown", line: lineOf(m.index!) });
  }

  const headings: Heading[] = [];
  const blockIds: string[] = [];
  const maskedLines = masked.split("\n");
  const bodyLines = body.split("\n");
  maskedLines.forEach((ml, i) => {
    const h = ml.match(/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (h) headings.push({ level: h[1]!.length, text: bodyLines[i]!.replace(/^ {0,3}#{1,6}[ \t]+/, "").replace(/[ \t]+#+[ \t]*$/, "").trim(), line: i + fm.bodyStartLine + 1 });
    const b = ml.match(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/);
    if (b) blockIds.push(b[1]!);
  });

  const tags = new Set<string>();
  for (const t of [...toStringList(frontmatter?.tags, /[,\s]+/), ...toStringList(frontmatter?.tag, /[,\s]+/)])
    tags.add(t.replace(/^#/, ""));
  for (const line of maskedLines) {
    for (const m of line.matchAll(TAG_RE)) if (!/^\d+$/.test(m[2]!)) tags.add(m[2]!);
  }

  const aliases = [
    ...new Set([...toStringList(frontmatter?.aliases, /,/), ...toStringList(frontmatter?.alias, /,/)]),
  ];

  return { frontmatter, frontmatterError, bodyStartLine: fm.bodyStartLine, aliases, tags: [...tags], headings, blockIds, links };
}
