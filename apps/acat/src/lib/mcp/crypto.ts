import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

function getPepper(): string {
  const pepper = process.env.MCP_TOKEN_PEPPER;
  if (pepper) return pepper;
  if (process.env.NODE_ENV === "production") {
    throw new Error("MCP_TOKEN_PEPPER is required in production");
  }
  return "dev-mcp-token-pepper";
}

export function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function hashSecret(secret: string): string {
  return createHmac("sha256", getPepper()).update(secret).digest("hex");
}

export function createOpaqueToken(prefix: string): {
  token: string;
  hash: string;
  publicPrefix: string;
  lastFour: string;
} {
  const body = base64Url(randomBytes(32));
  const token = `${prefix}_${body}`;
  return {
    token,
    hash: hashSecret(token),
    publicPrefix: token.slice(0, Math.min(token.length, prefix.length + 9)),
    lastFour: token.slice(-4),
  };
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const digest = base64Url(createHash("sha256").update(verifier).digest());
  const left = Buffer.from(digest);
  const right = Buffer.from(challenge);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
