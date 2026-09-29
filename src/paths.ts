import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";

export class UserError extends Error {}

/**
 * Normalize a caller-supplied vault-relative path. Rejects absolute paths,
 * traversal, and hidden segments (.obsidian holds LiveSync credentials).
 */
export function normalizeRel(input: string): string {
  if (typeof input !== "string" || input.includes("\0")) throw new UserError("invalid path");
  const s = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!s || s.startsWith("/") || /^[a-zA-Z]:/.test(s)) throw new UserError(`path must be vault-relative: ${input}`);
  const norm = path.posix.normalize(s).replace(/\/+$/, "");
  const segs = norm.split("/");
  if (segs.some((seg) => seg === ".." || seg === "")) throw new UserError(`path escapes the vault: ${input}`);
  if (segs.some((seg) => seg.startsWith("."))) throw new UserError(`hidden paths are not accessible: ${input}`);
  return norm;
}

export function isUnder(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(prefix + "/");
}

/** Absolute path for a normalized rel path, verifying symlinks do not escape the vault. */
export async function toAbs(cfg: Config, rel: string): Promise<string> {
  const abs = path.join(cfg.vaultRoot, rel);
  const root = await fs.realpath(cfg.vaultRoot);
  // Walk up to the deepest existing ancestor and check its real location.
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== root && !real.startsWith(root + path.sep)) throw new UserError(`path escapes the vault: ${rel}`);
      return abs;
    } catch (e) {
      if (e instanceof UserError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
}

export function assertWritable(cfg: Config, rel: string): void {
  if (cfg.readOnly) throw new UserError("server is read-only");
  if (!rel.toLowerCase().endsWith(".md")) throw new UserError("only .md notes can be written");
  if (cfg.protectedNames.includes(path.posix.basename(rel).toLowerCase()))
    throw new UserError(`${rel} is protected from writes`);
  if (cfg.writePaths.length && !cfg.writePaths.some((p) => isUnder(rel, p)))
    throw new UserError(`writes are limited to: ${cfg.writePaths.join(", ")}`);
  if (cfg.ignorePaths.some((p) => isUnder(rel, p))) throw new UserError(`${rel} is in an ignored folder`);
}
