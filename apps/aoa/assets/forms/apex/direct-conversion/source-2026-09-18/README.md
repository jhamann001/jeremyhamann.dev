# Direct Conversion Request source

Byte-for-byte copy of the user-supplied blank `Direct Conversion Request.pdf`, copied from Desktop into this inventory on September 18, 2026. Source snapshot label only; no effective date was established. SHA-256: `ce2ca19beec697fdf9e5a8dd7b2b998771c7336155c3af678dc73566645b5893`. Five pages and 41 pdf-lib fields. All instructions and signature pages are retained.

The selected authorized AoA account is the **receiving Roth IRA**. The delivering Traditional/SIMPLE account and both custodian details are separate manual entries. Conversion scope and delivering account type are optional explicit choices. Tax withholding, shares-in-kind, signatures, dates and accepting-custodian authorization remain for human completion.

The actual cash amount entry is `undefined_10` on page 2, to the right of the dollar sign. The misleading `CASH AMOUNT` widget lies in the label column and must remain blank. `Image28_af_image` is a static PDFButton artwork placeholder, preserved rather than treated as an input.

Validation evidence: fillable-field check, pypdf field extraction, all pages rendered, field-bearing pages visually reviewed, pdf-lib field/page count and SHA-256 checked. Synthetic-only mapping tests verify account roles, blank elections/signatures, and exact widget values.
