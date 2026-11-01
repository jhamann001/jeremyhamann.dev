export const MCP_SCOPES = [
  "acats:read",
  "custodians:read",
  "fees:read",
  "mcp:audit:read",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export const DEFAULT_MCP_SCOPES: McpScope[] = [
  "acats:read",
  "custodians:read",
  "fees:read",
];

const SCOPE_SET = new Set<string>(MCP_SCOPES);

export function parseScopes(raw: string | null | undefined): McpScope[] {
  if (!raw) return DEFAULT_MCP_SCOPES;
  const scopes = raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(scopes));
  if (unique.some((scope) => !SCOPE_SET.has(scope))) {
    throw new Error("Unsupported MCP scope requested");
  }
  return unique as McpScope[];
}

export function scopeString(scopes: readonly string[]): string {
  return Array.from(new Set(scopes)).join(" ");
}

export function hasScopes(granted: readonly string[], required: readonly McpScope[]): boolean {
  const grantedSet = new Set(granted);
  return required.every((scope) => grantedSet.has(scope));
}
