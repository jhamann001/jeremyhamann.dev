# ACH agreement template inventory

- Source: user-supplied blank `ACH Agreement.pdf`; no client information.
- Stored unchanged. Snapshot date is not a custodian effective date or current-version assertion.
- Printed identifier: `69196P-UACH 08/17/2018`.
- SHA-256: `114aca135ba88e7bf0a64059910af0849f67ad8a39ce430884e0c75ed8dd9db0`.
- One page, 59 fields reported by both pdf-lib and the PDF skill extraction. This verified inventory supersedes the earlier planning count of 60.
- `field-inventory.json` is the PDF skill's original field extraction; signatures are reported as unknown `/Sig`, and the decorative logo pushbutton has no on/off values.

## Mapping scope

Account owner information and manually supplied bank details are fillable. The bank account title is independently supplied, not copied from the selected Apex account. Checking/savings is an explicit mutually exclusive choice with no default.

The header has three separate branch boxes, five separate account boxes, and separate `T` and `C` boxes. Only an exact three-character branch, hyphen, five-digit authorized Apex identifier may be split across the first eight boxes. `T`/`C` are not encoded by that identifier and remain blank. Unsupported formats must produce a validation issue, never truncation.

The nine ABA text widgets receive one digit each, in numeric order; bank account number remains a string to preserve leading zeros. Format validation is not bank verification.

This pilot deliberately leaves the entire electronic-transfer profile (on-demand, income-distribution and recurring choices, directions, frequencies, amount and schedule) blank for the existing client/CS completion workflow. It also leaves all signatures, dates and correspondent approvals blank. Printed bank-evidence requirements are preserved.

Before operational use, CS must confirm that this supplied revision is still accepted and complete the review checklist. Draft generation does not enroll ACH or move money.
