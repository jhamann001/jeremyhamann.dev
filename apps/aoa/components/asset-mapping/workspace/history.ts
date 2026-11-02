// Next.js patches pushState/replaceState on the history instance and starts a router
// transition that drops the in-flight household request; the prototype methods do not.
export function pushAddress(url: string): void {
  History.prototype.pushState.call(window.history, null, "", url);
}

export function replaceAddress(url: string): void {
  History.prototype.replaceState.call(window.history, null, "", url);
}
