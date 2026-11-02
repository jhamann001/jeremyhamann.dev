# TOD supplied template snapshot

This is the unchanged blank `Transfer On Death.pdf` supplied by the user. It is
versioned by inventory date, not represented as a newly verified custodian
revision. It has five pages and 107 AcroForm fields. SHA-256:
`4be00dc6223c35a384c7e2ab7ea79e45cb00cc9b31b4f722993ec50343ce2a2e`.

Page 1 prints `Rev. 05/27/2025 (69448P)`; pages 2–5 print
`Rev. 04/23/2025 (69448P)`. The user accepted that supplied package; no wording,
revision labels or pages have been replaced.

The generated copy makes narrowly scoped AcroForm repairs:

- The address widgets for primary beneficiaries 3 and 6 share one source field.
  The lower widget is reparented to an independent `Beneficiary 6 - Address`
  field. The original rectangles are retained.
- `Group 1` contains original/change radio widgets, but its radio flag is on the
  widgets rather than the parent field. The output parent receives the radio
  flag so the options are mutually exclusive. Neither is selected by default.
- Page annotations point to duplicate, stale widget objects in the source file.
  They are reconnected to the AcroForm field tree's matching widgets using exact
  field identity and rectangle. No widget is moved, added or removed. This is
  necessary for the displayed PDF values to match its extracted form values.

The repaired output has 108 fields. The source file is never modified. Signature
areas, all five pages, instructions and the existing logo remain intact.

`tod-spec.ts` allows account information and six primary/six contingent rows.
Beneficiary data, full tax IDs and elections are optional for draft generation;
missing required client information must be completed through the existing
manual review/signing process. No email field exists in this snapshot.
