import { registerNativeHandler } from "../registry";
import { checklistSave } from "./checklist";
import { exclusionSave } from "./exclusions";
import { markAllNotificationsRead, markNotificationRead } from "./notifications";
import { createRequest, resubmitRequest, statusChange } from "./requests";

// The 7 workspace write operations (ticket). Loaded only through loadNativeHandlers(), on the native path.

registerNativeHandler("createRequest", createRequest);
registerNativeHandler("resubmitRequest", resubmitRequest);
registerNativeHandler("statusChange", statusChange);
registerNativeHandler("checklistSave", checklistSave);
registerNativeHandler("exclusionSave", exclusionSave);
registerNativeHandler("markNotificationRead", markNotificationRead);
registerNativeHandler("markAllNotificationsRead", markAllNotificationsRead);
