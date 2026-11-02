// Connection strings for the Trade Request cutover job (ticket). AOA's Cloud SQL budget is 83 of ~100
// connections (infra/terraform/variables.tf), so every client the job opens is capped at one connection.
// max_idle_connection_lifetime=0 stops Prisma from recycling that connection (its default closes connections
// after 300 s, which would silently release the controller's session lock).

/** Sets connection_limit=1 and max_idle_connection_lifetime=0, replacing existing values; other parameters are kept verbatim. */
export function singleConnectionUrl(url: string): string {
  const [base, query = ""] = url.split("?", 2);
  const params = query
    .split("&")
    .filter((p) => p !== "" && !p.startsWith("connection_limit=") && !p.startsWith("max_idle_connection_lifetime="));
  params.push("connection_limit=1", "max_idle_connection_lifetime=0");
  return `${base}?${params.join("&")}`;
}

/** The standalone database through the Cloud SQL connector socket as the ticket copy login, one connection. */
export function sourceDatabaseUrl(password: string, socketDir: string): string {
  return singleConnectionUrl(`postgresql://trade_request_aoa_copy:${encodeURIComponent(password)}@localhost/trade_request?host=${socketDir}`);
}
