// Loads the native handler modules on first use, so the delegated path never imports them.
let loading: Promise<void> | null = null;

export function loadNativeHandlers(): Promise<void> {
  loading ??= Promise.all([import("./reads"), import("./writes")]).then(
    () => undefined,
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}
