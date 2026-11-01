import { confirmReceivingTitleSchema, generateTransferFormSchema, updateTransferScopeSchema } from "@/lib/transfer-form-contract";
import { getPreparation, confirmReceivingTitle, generateTransferForm, updateTransferScope } from "@/lib/transfer-preparation-service";
import { preparationBody, preparationJson, requirePreparationId, withPreparationActor, TRANSFER_GENERATION_MAX_BODY_BYTES } from "@/lib/transfer-preparation-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return withPreparationActor(request, async () => {
    const id = requirePreparationId((await context.params).id);
    return preparationJson(await getPreparation(id));
  });
}
export async function PUT(request: Request, context: Context) {
  return withPreparationActor(request, async (actor) => {
    const id = requirePreparationId((await context.params).id);
    const body = await preparationBody(request, confirmReceivingTitleSchema);
    return preparationJson(await confirmReceivingTitle(id, body, actor));
  });
}
export async function PATCH(request: Request, context: Context) {
  return withPreparationActor(request, async (actor) => {
    const id = requirePreparationId((await context.params).id);
    const body = await preparationBody(request, updateTransferScopeSchema);
    return preparationJson(await updateTransferScope(id, body, actor));
  });
}
export async function POST(request: Request, context: Context) {
  return withPreparationActor(request, async (actor) => {
    const id = requirePreparationId((await context.params).id);
    const body = await preparationBody(request, generateTransferFormSchema, TRANSFER_GENERATION_MAX_BODY_BYTES);
    return preparationJson(await generateTransferForm(id, body, actor));
  });
}
