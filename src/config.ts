import path from "node:path";

export interface Config {
  vaultRoot: string;
  host: string;
  port: number;
  /** Static bearer token for remote use. Empty disables auth (only allowed on loopback). */
  token: string;
  readOnly: boolean;
  /** Vault-relative folder prefixes that may be written. Empty = whole vault. */
  writePaths: string[];
  /** File basenames that are never writable (case-insensitive). */
  protectedNames: string[];
  /** Vault-relative folder prefixes skipped by indexing/listing. */
  ignorePaths: string[];
  /** Hostnames accepted in the Host header (DNS rebinding guard). Empty = any. */
  allowedHosts: string[];
}

const list = (v: string | undefined, fallback: string[] = []): string[] =>
  v === undefined
    ? fallback
    : v
        .split(",")
        .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
        .filter(Boolean);

/** Hosts that pass through unresolved "${user_config.x}" placeholders for unset options. */
const unset = (v: string | undefined) => (v !== undefined && /^\$\{.*\}$/.test(v.trim()) ? undefined : v);

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): Config {
  const env = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, unset(v)])) as NodeJS.ProcessEnv;
  const vault = env.OBSIDIAN_VAULT_PATH;
  if (!vault) throw new Error("OBSIDIAN_VAULT_PATH is required");
  return {
    vaultRoot: path.resolve(vault),
    host: env.OBSIDIAN_MCP_HOST ?? "127.0.0.1",
    port: Number(env.OBSIDIAN_MCP_PORT ?? 8787),
    token: env.OBSIDIAN_MCP_TOKEN ?? "",
    readOnly: env.OBSIDIAN_MCP_READONLY === "1" || env.OBSIDIAN_MCP_READONLY === "true",
    writePaths: list(env.OBSIDIAN_MCP_WRITE_PATHS),
    protectedNames: list(env.OBSIDIAN_MCP_PROTECTED_NAMES, ["CLAUDE.md", "AGENTS.md"]).map((s) =>
      s.toLowerCase(),
    ),
    ignorePaths: list(env.OBSIDIAN_MCP_IGNORE_PATHS),
    allowedHosts: list(env.OBSIDIAN_MCP_ALLOWED_HOSTS),
  };
}
