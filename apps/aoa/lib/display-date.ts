// Explicit defaults keep server-rendered history labels identical on hydration.
// UTC preserves the server's existing calendar dates; paged JSON responses use
// ISO strings while the initial React server-component props retain Date values.
type DisplayDate = Date | string | null | undefined;

const dateOptions: Intl.DateTimeFormatOptions = {
  timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric",
};

/** Numeric US calendar date in UTC. Missing values remain empty. */
export function utcDateLabel(value: DisplayDate): string {
  return value ? new Date(value).toLocaleDateString("en-US", dateOptions) : "";
}

/** Full history timestamp, explicitly labelled UTC to avoid implying local time. */
export function utcDateTimeLabel(value: DisplayDate): string {
  return value ? new Date(value).toLocaleString("en-US", {
    ...dateOptions, hour: "numeric", minute: "2-digit", second: "2-digit",
    hour12: true, timeZoneName: "short",
  }) : "";
}
