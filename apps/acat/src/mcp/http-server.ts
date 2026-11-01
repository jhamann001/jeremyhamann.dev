import "dotenv/config";
import http from "http";
import { handleMcpRequest } from "@/mcp/handler";
import { logger } from "@/lib/logger";

const PORT = Number(process.env.PORT || process.env.MCP_PORT || 3001);

// Request handling lives in ./handler so it can be unit tested without
// binding a port; this file is only the process entry point.
const server = http.createServer(handleMcpRequest);

server.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "transfer-tracker MCP server listening");
});
