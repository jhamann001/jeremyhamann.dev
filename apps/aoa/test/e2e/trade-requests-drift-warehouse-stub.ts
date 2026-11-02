// Synthetic Warehouse for ticket: answers the three saved cards the exclusion-overlap analyzer reads (contacts 6043,
// investments 6040, balances 6042) with the seed's rows; everything else is 404. HTTPS when
// ticket_WAREHOUSE_TLS_DIR holds key.pem and cert.pem (the AOA Trade Request transport refuses plain HTTP),
// plain HTTP otherwise (the standalone capture). Loopback only.
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const seed = JSON.parse(readFileSync("test/fixtures/trade-request-drift-view-seed.json", "utf8")) as { warehouse: Record<string, unknown[]> };
const port = Number(process.env.ticket_WAREHOUSE_PORT ?? "3193");
const tlsDir = process.env.ticket_WAREHOUSE_TLS_DIR;

function handle(req: IncomingMessage, res: ServerResponse) {
  const card = /^\/api\/card\/(\d+)\/query\/json$/.exec(req.url ?? "")?.[1];
  const body = req.method === "GET" && req.url === "/health" ? { ok: true } : req.method === "POST" && card ? seed.warehouse[card] : undefined;
  req.resume();
  res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify(body ?? { error: "not_found" }));
}

const server = tlsDir
  ? createHttpsServer({ key: readFileSync(`${tlsDir}/key.pem`), cert: readFileSync(`${tlsDir}/cert.pem`) }, handle)
  : createHttpServer(handle);
server.listen(port, "127.0.0.1");
