/** Keep existing bookmarks to the old inner Portrait pane working as Insights. */
export function normalizePortraitTab(tabId: string | null): string | null {
  return tabId === "insights" ? "portrait" : tabId;
}

/** The hub opens Core Financial unless an existing Portrait pane was requested.
 * Known gated panes retain their Portrait/Communications fallback when absent. */
export function resolvePortraitTab(tabId: string | null): string {
  const normalized = normalizePortraitTab(tabId);
  return normalized && ["financial", "comms", "portrait", "relationships", "documents"].includes(normalized)
    ? normalized
    : "financial";
}

export function portraitTabHref(
  pathname: string,
  search: { toString(): string },
  tabId: string | null = null,
  hash = "",
): string {
  const parameters = new URLSearchParams(search.toString());
  if (tabId === null) parameters.delete("portraitTab");
  else parameters.set("portraitTab", normalizePortraitTab(tabId) ?? tabId);
  const query = parameters.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

/** Select an already rendered pane without refetching the client or losing list-return metadata. */
export function replacePortraitTab(tabId: string): void {
  const url = new URL(window.location.href);
  const href = portraitTabHref(url.pathname, url.searchParams, tabId, url.hash);
  // Next treats __NA/_N as internal writes and skips notifying useSearchParams
  // when either marker is supplied. Preserve custom navigation metadata, but
  // let Next's patched replaceState copy its own markers back onto the entry.
  const nextState = { ...window.history.state };
  delete nextState.__NA;
  delete nextState._N;
  window.history.replaceState(nextState, "", href);
}
