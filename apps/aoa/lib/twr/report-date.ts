// Cover-page "Report Date" for the TWR Portfolio Performance Report.
//
// The firm operates in America/New_York, but Cloud Run clocks are UTC — so a
// naive `new Date().toISOString().slice(0, 10)` rolls to TOMORROW every
// evening ET (a report pulled at ~8:46pm ET on 2026-07-09 printed
// "2026-07-10"). Format the current instant IN the firm timezone instead.
// This is presentation-only ("the date the report was pulled"); the report's
// as-of / YTD math correctly derives from custodial balance dates, not the
// server clock, and is untouched by this.

/** The current calendar date in America/New_York, as YYYY-MM-DD (en-CA
 *  locale formats exactly that shape). `now` is injectable for tests. */
export function reportDateEt(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(now);
}
