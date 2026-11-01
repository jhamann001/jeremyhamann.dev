import "@testing-library/jest-dom/vitest";

// Node 25 exposes an experimental global localStorage object without the
// browser Storage methods unless a persistence file is configured. That
// object can take precedence over jsdom's implementation and make unrelated
// component tests fail while reading the effective-role preference.
if (
  typeof window !== "undefined" &&
  typeof window.localStorage?.getItem !== "function"
) {
  const values = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorage,
  });
}

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
