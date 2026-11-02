import { createServer } from "node:http";
import { warehouseRows } from "./trade-requests-new-synthetic";

// Loopback-only stand-in for Warehouse so the local Trade Request service can
// serve synthetic clients and resolve synthetic firm households. POST
// /__control/fail and /__control/ok switch the question responses.
const port = Number(process.env.TRW11_WAREHOUSE_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("TRW11_WAREHOUSE_PORT required");
let failing = false;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return send(200, { ok: true });
  if (req.method === "POST" && url.pathname === "/__control/fail") {
    failing = true;
    return send(200, { failing });
  }
  if (req.method === "POST" && url.pathname === "/__control/ok") {
    failing = false;
    return send(200, { failing });
  }
  const question = /^\/api\/card\/(\d+)\/query\/json$/.exec(url.pathname)?.[1];
  if (req.method === "POST" && question) return failing ? send(500, { error: "synthetic failure" }) : send(200, warehouseRows(question));
  send(404, { error: "not found" });
}).listen(port, "127.0.0.1");
