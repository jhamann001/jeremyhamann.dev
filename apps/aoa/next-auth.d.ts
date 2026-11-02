import "next-auth";

declare module "next-auth" {
  interface Session {
    /** Opaque per-login navigation partition only; never an auth credential. */
    navigationScope?: string | null;
  }
}
