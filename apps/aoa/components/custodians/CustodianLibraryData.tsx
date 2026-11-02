import { getCustodianLibrary, CustodianLibraryError } from "@/lib/data/custodian-library";
import { CustodianLibrary } from "./CustodianLibrary";

export async function CustodianLibraryData({ role }: { role: string }) {
  try {
    const library = await getCustodianLibrary(role);
    return <CustodianLibrary library={library} />;
  } catch (error) {
    if (!(error instanceof CustodianLibraryError)) throw error;
    return <p role="status" style={{ marginTop: 24 }}>
      The custodian library is unavailable right now. No fee or playbook data
      could be verified. Try reloading later or open the Transfer Tracker.
    </p>;
  }
}
