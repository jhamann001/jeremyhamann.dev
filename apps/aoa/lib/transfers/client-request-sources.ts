// Client-safe: where a client's transfer request came from.
export const CLIENT_REQUEST_SOURCES = ["Client app", "Client Service", "Signed paperwork"] as const;
export type ClientRequestSource = (typeof CLIENT_REQUEST_SOURCES)[number];
