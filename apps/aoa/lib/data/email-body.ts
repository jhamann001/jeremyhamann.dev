import { Prisma } from "@prisma/client";

// A recognizable logged header, including CR-only legacy bodies. This constant
// predicate is shared by aggregate coverage and the explicit storage cleanup.
export const EMAIL_BODY_HAS_LOGGED_BCC = Prisma.raw(String.raw`body ~* '(^|[\r\n])[\t ]*bcc[\t ]*:'`);

// Keep logged Bcc and folded recipients out of every body read/search. Normalize
// legacy CR/CRLF separators before stripping; prose containing bcc is preserved.
// The explicit historical cleanup reuses this expression for eligible rows only.
// Constant SQL: no request value is interpolated.
export const EMAIL_BODY_WITHOUT_BCC = Prisma.raw(String.raw`CASE
  WHEN body IS NULL OR strpos(lower(body), 'bcc') = 0 THEN body
  ELSE nullif(btrim(regexp_replace(
    replace(replace(body, chr(13) || chr(10), chr(10)), chr(13), chr(10)),
    '(^|\n)[ \t]*bcc[ \t]*:[^\n]*(\n[ \t]+[^\n]*)*', '\1', 'gi'), chr(9) || chr(10) || chr(13) || ' '), '')
END`);
