import { handlers } from "@/auth";

export const dynamic = "force-dynamic"; // convention 6 / G9

// Auth.js owns authentication here: the ONLY route.ts exempt from G3 (requireViewerOrThrow / isClientApiAuthorized).
export const { GET, POST } = handlers;
