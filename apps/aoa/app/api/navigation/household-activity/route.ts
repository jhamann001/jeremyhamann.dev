import { householdHistoryResponse } from "@/lib/navigation/household-history-api";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => householdHistoryResponse(request, "activity");
