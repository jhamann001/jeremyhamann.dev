/**
 * AI seam errors — pure, layer L1.
 *
 * Its own module so `provider.ts` (which constructs the Vertex provider) and `vertex.ts` (which
 * throws) do not import each other's VALUES. A type-only cycle is erased at compile time; a value
 * cycle is a module-initialisation order that works until somebody adds a top-level constant to one
 * of the two files.
 */

/**
 * An upstream failure. The message is written for an operator and is safe to log.
 *
 * What it must NEVER carry: a response body, a prompt, a draft, an access token or a URL. An upstream
 * error body from a generative API routinely echoes the request back, and the request contains the
 * client's own words — so the rule here is the same one `runAction`'s `internalError` applies, for
 * the same reason.
 */
export class AiProviderError extends Error {
  readonly provider: string;
  constructor(provider: string, message: string) {
    super(message);
    this.name = "AiProviderError";
    this.provider = provider;
  }
}
