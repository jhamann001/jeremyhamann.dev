import { registerNativeHandler } from "../registry";
import { clientListHandler } from "./clients";
import {
  accountExclusionsLookupHandler, clientExclusionsHandler, clientsExclusionsLookupHandler, exportExclusionsHandler,
} from "./exclusions";
import { householdResolveHandler } from "./households";
import { notificationsListHandler } from "./notifications";
import {
  checklistReadHandler, lastAllocationHandler, listRequestsHandler, requestCountsHandler, requestDetailHandler,
} from "./requests";

// The 12 workspace reads (ticket).
registerNativeHandler("listRequests", listRequestsHandler);
registerNativeHandler("requestCounts", requestCountsHandler);
registerNativeHandler("requestDetail", requestDetailHandler);
registerNativeHandler("checklistRead", checklistReadHandler);
registerNativeHandler("clientList", clientListHandler);
registerNativeHandler("lastAllocation", lastAllocationHandler);
registerNativeHandler("clientExclusions", clientExclusionsHandler);
registerNativeHandler("householdResolve", householdResolveHandler);
registerNativeHandler("notificationsList", notificationsListHandler);
registerNativeHandler("exportExclusions", exportExclusionsHandler);
registerNativeHandler("clientsExclusionsLookup", clientsExclusionsLookupHandler);
registerNativeHandler("accountExclusionsLookup", accountExclusionsLookupHandler);
