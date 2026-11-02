# IRA Distribution Request source

Byte-for-byte copy of the user-supplied blank `IRA Distribution Request.pdf`, copied from Desktop into this inventory on September 18, 2026. Source snapshot label only; no effective date was established. SHA-256: `6a396500c0919ffa09ccdd795f2696b7240f548f0df4d507f8ce87e1c9bc22ce`. Fourteen pages and 112 pdf-lib fields. All instructions, client/notary signatures, and advisor/internal approvals are retained.

Selected AoA account is the distributing non-Roth IRA. Destination accounts are manual inputs. Account type and distribution method are explicit optional choices; no reason, withholding, delivery, schedule frequency, or securities instruction is inferred. Beneficiary/former-spouse information is separate from the owner and is not a beneficiary designation.

Tax IDs remain optional for drafting and require nine digits if supplied. `Logo Placement_af_image` is a PDFButton holding source artwork and must be preserved. Actual signature widgets and all text-based approval/date fields remain blank.

The alternate-payee `STATE` widget is only 12 PDF points wide, too narrow to reliably display a two-letter state at the renderer's minimum legible size. That input is left for manual PDF completion and called out in the checklist. The separate wire-bank `STATE_2` remains mapped.

Validation evidence: fillable-field check, field extraction, all pages rendered, field-bearing pages visually reviewed, pdf-lib count/hash check, and synthetic-only mapping tests.
