import { z } from "zod";

// The standalone drift route's date parameter (server/src/routes/drift.ts:108-117).
export const runDateLocalSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "runDateLocal must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === s;
  }, "runDateLocal must be a valid calendar date");
