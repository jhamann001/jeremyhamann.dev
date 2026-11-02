import { usd } from "@/lib/format";
import {
  FULL_ACAT_REFUSED_MESSAGE,
  fullAcatRefused,
  includedInInstructions,
  type EligibilityHolding,
} from "@/lib/transfers/holding-eligibility";

/** ATW-03 transfer instructions: only the holdings that move (AC-27, AC-28). */
export function InstructionList({
  holdings,
  enabled,
}: {
  holdings: EligibilityHolding[];
  enabled: boolean;
}) {
  const included = holdings.filter(includedInInstructions);
  const leftBehind = holdings.length - included.length;
  const refused = fullAcatRefused(enabled, holdings);
  return (
    <section aria-label="Transfer instructions">
      <div className="row between">
        <strong>Transfer instructions</strong>
        <span className="small">
          {included.length} included{leftBehind > 0 ? ` · ${leftBehind} left at the delivering firm` : ""}
        </span>
      </div>
      {refused && (
        <div className="notice" role="status" data-refused="ACAT_FULL">
          <strong>Full ACAT is unavailable</strong>
          <p>{FULL_ACAT_REFUSED_MESSAGE}</p>
        </div>
      )}
      {included.length === 0 ? (
        <p className="small">No holdings are included in the instructions.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>Asset</th><th>Movement</th><th className="money">Value</th></tr>
            </thead>
            <tbody>
              {included.map((holding) => {
                const inKindBlocked = holding.ineligible || holding.cannotTransferInKind;
                return (
                  <tr key={holding.symbol} data-symbol={holding.symbol}>
                    <td><strong>{holding.symbol}</strong><small>{holding.description ?? ""}</small></td>
                    <td>
                      <span className={inKindBlocked ? "badge blocked" : "badge progress"}>
                        {inKindBlocked ? "Cannot transfer in kind" : "Included to move"}
                      </span>
                    </td>
                    <td className="money">{holding.marketValue == null ? "—" : usd(holding.marketValue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
