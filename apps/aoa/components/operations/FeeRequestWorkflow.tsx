import { updateOperationsFeeRequest } from "@/app/(authenticated)/operations/fee-requests/actions";
import type { OperationsFeeRequestListRow } from "@/lib/data/operations-fee-requests";
import styles from "./FeeRequestWorkflow.module.css";

type Props = {
  request: OperationsFeeRequestListRow;
  defaultCreditedDate: string;
};

function HiddenFields({ requestId, action }: { requestId: string; action: string }) {
  return (
    <>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="workflowAction" value={action} />
    </>
  );
}

function CancellationForm({ requestId }: { requestId: string }) {
  return (
    <details className={styles.cancelDetails}>
      <summary>Cancel request</summary>
      <form className={styles.form} action={updateOperationsFeeRequest}>
        <HiddenFields requestId={requestId} action="CANCEL" />
        <label>
          Cancellation reason
          <textarea name="workflowNote" maxLength={1000} rows={2} required placeholder="Explain why this request is being cancelled" />
        </label>
        <button className={styles.secondaryButton} type="submit">Cancel request</button>
      </form>
    </details>
  );
}

export function FeeRequestWorkflow({ request, defaultCreditedDate }: Props) {
  if (request.status === "PENDING") {
    return (
      <div className={styles.workflow}>
        <h4>Review request</h4>
        <div className={styles.reviewGrid}>
          <form className={styles.form} action={updateOperationsFeeRequest}>
            <HiddenFields requestId={request.id} action="APPROVE" />
            <label>
              Approval note (optional)
              <textarea name="workflowNote" maxLength={1000} rows={2} placeholder="Add context for the approval history" />
            </label>
            <button className={styles.primaryButton} type="submit">Approve request</button>
          </form>
          <form className={styles.form} action={updateOperationsFeeRequest}>
            <HiddenFields requestId={request.id} action="REJECT" />
            <label>
              Rejection reason
              <textarea name="workflowNote" maxLength={1000} rows={2} required placeholder="Explain why the request is being rejected" />
            </label>
            <button className={styles.dangerButton} type="submit">Reject request</button>
          </form>
        </div>
        <CancellationForm requestId={request.id} />
      </div>
    );
  }

  if (request.status === "APPROVED" && request.kind === "FEE_CREDIT") {
    return (
      <div className={styles.workflow}>
        <h4>Record completed credit</h4>
        <p className={styles.help}>Use this only after the fee credit has been completed outside AOA.</p>
        <form className={styles.completionForm} action={updateOperationsFeeRequest}>
          <HiddenFields requestId={request.id} action="CREDIT" />
          <label>
            Credited date
            <input type="date" name="creditedDate" required defaultValue={defaultCreditedDate} />
          </label>
          <label>
            Apex request ID
            <input name="apexRequestId" required maxLength={80} placeholder="Enter the completed Apex request ID" />
          </label>
          <label className={styles.full}>
            Completion note (optional)
            <textarea name="workflowNote" maxLength={1000} rows={2} placeholder="Add any useful completion context" />
          </label>
          <button className={styles.primaryButton} type="submit">Mark credited</button>
        </form>
        <CancellationForm requestId={request.id} />
      </div>
    );
  }

  if (request.status === "APPROVED") {
    return (
      <div className={styles.workflow}>
        <p className={styles.help}>This waiver is approved. AOA records the decision but does not alter billing.</p>
        <CancellationForm requestId={request.id} />
      </div>
    );
  }

  return <p className={styles.help}>This request is closed. Its history remains available below.</p>;
}
