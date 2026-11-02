# Roth IRA Distribution Request source

Byte-for-byte copy of the user-supplied blank `Roth IRA Distribution Request.pdf`, copied from Desktop into this inventory on September 18, 2026. Source snapshot label only; no effective date was established. SHA-256: `38574dedec3918a05f42cb141bbb95465e4508ba762f3da24e1d9e76eb01d91b`. Seven pages and **105 pdf-lib fields**. All instructions, signatures and approval pages are retained.

Both printed tax-ID labels request **last four digits only**, despite the generic internal names `SSNITINTax ID Required by the IRS` and its `_2` counterpart. Full tax IDs must not be placed in these fields. The pypdf extraction reports 104 fields, omitting `Date of Birth Optional`; pdf-lib exposes the owner's DOB widget and the original page confirms its location. Tests therefore check the native pdf-lib structure and exact mappings.

The selected AoA account is the distributing Roth IRA. Beneficiary/former-spouse and destination accounts are separate manual inputs. No distribution qualification, tax treatment, reason, withholding, or delivery route is inferred. Signature and approval fields remain blank. `Image27_af_image` is a static PDFButton artwork placeholder that is preserved.

Validation evidence: fillable-field check, pypdf extraction, all pages rendered, field-bearing pages visually reviewed, pdf-lib field/page count and SHA-256 checks, and synthetic-only mapping tests.
