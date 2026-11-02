# Domestic wire template inventory

- Source: user-supplied blank `Domestic Wire.pdf`; no client information.
- Stored unchanged. Snapshot date is not a custodian effective date or current-version assertion.
- Printed identifier: `PF10101R-DWRE 08/17/2018`.
- SHA-256: `334f031d0c4d99e811e8d400063f0598698acffbfc1ab78a57758eb8915d0055`.
- One page and 30 fields in pdf-lib and the PDF skill extraction.
- `field-inventory.json` is the original PDF skill extraction; signature fields appear as unknown `/Sig` and the decorative logo pushbutton has no on/off values.

## Mapping scope

Only the sending Apex account number comes from the authorized server context. Amount, receiving-bank details, ultimate-recipient details, intermediary details and reason are independent optional manual inputs. No recipient or bank details are copied from the selected client or another section.

The printed receiving-bank section labels its address `Beneficiary Address`, while the intermediary section labels its address `Beneficiary Bank Address`. UI labels and hints retain these distinctions and ask CS to verify the intended address against the wire instructions, rather than silently treating both as bank street addresses.

The request date and every customer, joint-holder, investment-advisor, registered-principal and compliance approval/signature/name/title/date field remain blank. No signature or approval can be passed through the request allowlist.

Before use, CS must confirm that this supplied revision is still accepted, verify all instructions using the existing wire process, complete missing information, and obtain required approvals. A generated draft neither authorizes nor initiates a wire.
