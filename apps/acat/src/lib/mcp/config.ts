import { prisma } from "@/lib/prisma";

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CLAUDE_MCP_REDIRECT_ORIGIN = "https://claude.ai";
const CLAUDE_MCP_REDIRECT_PATH = "/api/mcp/auth_callback";
const LOCAL_MCP_REDIRECT_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function getAppBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000"
  ).replace(/\/+$/g, "");
}

export function getMcpPublicUrl(): string {
  return (process.env.MCP_PUBLIC_URL || "http://localhost:3001").replace(
    /\/+$/g,
    ""
  );
}

export async function isMcpGloballyEnabled(): Promise<boolean> {
  if (process.env.MCP_ENABLED !== "1") return false;
  const settings = await prisma.mcpSettings.findUnique({
    where: { id: "global" },
    select: { enabled: true },
  });
  return settings?.enabled === true;
}

export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  // OAuth redirect URIs must never contain userinfo or fragments. Rejecting
  // these before the host checks avoids misleading values such as
  // https://attacker.example@claude.ai/... and keeps authorization codes out
  // of browser fragments.
  if (parsed.username || parsed.password || parsed.hash) return false;

  // Production supports only Claude's documented MCP callback. Match the
  // parsed origin and exact path rather than accepting arbitrary HTTPS hosts.
  if (parsed.protocol === "https:") {
    return (
      parsed.origin === CLAUDE_MCP_REDIRECT_ORIGIN &&
      parsed.pathname === CLAUDE_MCP_REDIRECT_PATH &&
      parsed.search === ""
    );
  }

  // Native/local MCP clients may use a dynamic port and callback path, but only
  // over plain HTTP on an exact loopback hostname.
  return (
    parsed.protocol === "http:" &&
    LOCAL_MCP_REDIRECT_HOSTS.has(parsed.hostname)
  );
}

export function safeRelativeCallback(raw: string | null): string {
  if (!raw) return "/";
  try {
    const parsed = new URL(raw, "http://acat.local");
    if (parsed.origin !== "http://acat.local") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}
