import "server-only";

import { apexAccountByCustodianId } from "@/lib/data/account-aum";
import { getClientWithHousehold } from "@/lib/data/clients";
import type { Identity } from "@/lib/rls";
import type { FormDefinition, FormFieldProvenance } from "./form-definition";
import { isDefinitionEligibleForAccountType } from "./form-definition";
import { fillIraBeneficiaryPdf, parseIraBeneficiaryDraft, iraBeneficiaryClientCompletionRequired, IraBeneficiaryRenderError } from "./ira-beneficiary";
import { IRA_BENEFICIARY_DEFINITION } from "./ira-beneficiary-definition";
import { ACAT_DEFINITION } from "./acat-definition";
import { AcatRenderError, AcatTemplateError, fillAcatPdf, parseAcatDraft } from "./acat";
import { getFormDefinition } from "./registry";
import { FormTemplateIntegrityError, loadFormTemplate } from "./template.server";
import { getMappedFormSpec, MAPPED_FORM_SPECS } from "./mapped-forms";
import { mappedInputs } from "./mapped-form-spec";
import { parseMappedDraft } from "./mapped-form-validation";
import { fillMappedPdf, MappedFormRenderError, MappedFormTemplateError } from "./mapped-form-pdf";

export type GenerateFormRequest = {
  formId: string;
  clientId: string;
  accountIds: readonly string[];
  values: unknown;
};

export type GenerateFormIssue = { path: string; message: string };

export type GenerateFormResult =
  | {
      ok: true;
      bytes: Uint8Array;
      filename: string;
      definition: FormDefinition;
      reviewState: "ready_for_human_review";
      clientCompletionRequired: boolean;
      provenance: FormFieldProvenance[];
      audit: {
        generatedAt: string;
        generatedBy: string | null;
        formId: string;
        formVersion: string;
        templateSha256: string;
      };
    }
  | { ok: false; status: number; code: string; issues?: GenerateFormIssue[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedText = (value: string) => value.trim().replace(/\s+/g, " ");

function buildProvenance(
  definition: FormDefinition,
  overriddenCanonicalKeys: ReadonlySet<string>,
): FormFieldProvenance[] {
  return definition.fields.map((field) => ({
    canonicalKey: field.canonicalKey,
    pdfFieldIds: field.pdfFieldIds,
    source: field.source,
    sourcePath: field.sourcePath,
    sensitivity: field.sensitivity,
    transformation: field.transformation,
    overridden: overriddenCanonicalKeys.has(field.canonicalKey),
    // No form values are persisted by this pilot. The provenance contract is
    // deliberately metadata-only until retention and encryption are approved.
    valueRetention: "transient_only",
  }));
}

type AdapterContext = {
  definition: FormDefinition;
  clientName: string;
  accountNumber: string;
  values: unknown;
};

type AdapterResult =
  | { ok: true; bytes: Uint8Array; overriddenCanonicalKeys: ReadonlySet<string>; clientCompletionRequired: boolean }
  | { ok: false; status: 400 | 422; code: string; issues?: GenerateFormIssue[] };

type FormGenerationAdapter = (context: AdapterContext) => Promise<AdapterResult>;

const iraBeneficiaryAdapter: FormGenerationAdapter = async ({
  definition,
  clientName,
  accountNumber,
  values,
}) => {
  if (!isRecord(values)) return { ok: false, status: 400, code: "invalid_payload" };

  const requestedName =
    typeof values.accountHolderName === "string" ? values.accountHolderName : clientName;
  const parsed = parseIraBeneficiaryDraft({
    ...values,
    accountHolderName: requestedName,
    // The authorized server-side account record always controls the PDF value.
    accountNumber,
  });
  if (!parsed.ok) {
    return { ok: false, status: 422, code: "validation_failed", issues: parsed.issues };
  }

  const template = await loadFormTemplate(definition);
  const bytes = await fillIraBeneficiaryPdf(template, parsed.value);
  const overriddenCanonicalKeys = new Set<string>();
  if (normalizedText(parsed.value.accountHolderName) !== normalizedText(clientName)) {
    overriddenCanonicalKeys.add("account.owner.full_legal_name");
  }
  return {
    ok: true,
    bytes,
    overriddenCanonicalKeys,
    clientCompletionRequired: iraBeneficiaryClientCompletionRequired(parsed.value),
  };
};

const acatAdapter: FormGenerationAdapter = async ({ definition, clientName, accountNumber, values }) => {
  const parsed = parseAcatDraft(values, accountNumber);
  if (!parsed.ok) return { ok: false, status: 422, code: "validation_failed", issues: parsed.issues };
  const template = await loadFormTemplate(definition);
  const bytes = await fillAcatPdf(template, parsed.value);
  const overriddenCanonicalKeys = new Set<string>();
  if (normalizedText(parsed.value.accountHolderName) !== normalizedText(clientName)) {
    overriddenCanonicalKeys.add("account.registration_title");
  }
  return { ok: true, bytes, overriddenCanonicalKeys, clientCompletionRequired: false };
};

const mappedAdapter: FormGenerationAdapter = async ({ definition, clientName, accountNumber, values }) => {
  const spec = getMappedFormSpec(definition.id);
  if (!spec) throw new MappedFormTemplateError();
  const parsed = parseMappedDraft(spec, values, accountNumber, clientName);
  if (!parsed.ok) return { ok: false, status: 422, code: "validation_failed", issues: parsed.issues };
  const template = await loadFormTemplate(definition);
  const bytes = await fillMappedPdf(spec, template, parsed.value);
  const overriddenCanonicalKeys = new Set(mappedInputs(spec)
    .filter(input => input.source === "clientName" && normalizedText(parsed.value.fields[input.key]) !== normalizedText(clientName))
    .map(input => input.key));
  // Optional preparation never establishes completion of conditional choices,
  // verification, or authorization. All new packets need client/CS completion.
  return { ok: true, bytes, overriddenCanonicalKeys, clientCompletionRequired: true };
};

const GENERATION_ADAPTERS = new Map<string, FormGenerationAdapter>([
  [IRA_BENEFICIARY_DEFINITION.id, iraBeneficiaryAdapter],
  [ACAT_DEFINITION.id, acatAdapter],
  ...MAPPED_FORM_SPECS.map(spec => [spec.definition.id, mappedAdapter] as const),
]);

function outputFilename(definition: FormDefinition, accountNumber: string) {
  const suffix = accountNumber.replace(/[^a-zA-Z0-9]/g, "").slice(-4) || "account";
  return definition.outputFilenamePattern.replace("{accountLast4}", suffix);
}

export async function generateForm(
  identity: Identity,
  request: GenerateFormRequest,
): Promise<GenerateFormResult> {
  const definition = getFormDefinition(request.formId);
  if (!definition || definition.status === "retired") {
    return { ok: false, status: 404, code: "form_not_found" };
  }
  const adapter = GENERATION_ADAPTERS.get(definition.id);
  if (!adapter) return { ok: false, status: 503, code: "form_adapter_unavailable" };
  if (!request.clientId || request.accountIds.length !== 1 || !request.accountIds[0]) {
    return {
      ok: false,
      status: 400,
      code: "missing_context",
      issues: [
        { path: "clientId", message: "Select a client" },
        { path: "accountIds", message: "Select one eligible account" },
      ],
    };
  }

  const [client, account] = await Promise.all([
    getClientWithHousehold(identity, request.clientId),
    apexAccountByCustodianId(identity, request.accountIds[0]),
  ]);
  if (!client || !account || account.clientSfId !== client.sf_id || !account.apexAccountNumber) {
    return { ok: false, status: 404, code: "client_account_not_found" };
  }
  if (!isDefinitionEligibleForAccountType(definition, account.accountType)) {
    return {
      ok: false,
      status: 422,
      code: "account_not_eligible",
      issues: [{ path: "accountIds", message: definition.eligibility.description }],
    };
  }

  try {
    const generated = await adapter({
      definition,
      clientName: client.name,
      accountNumber: account.apexAccountNumber,
      values: request.values,
    });
    if (!generated.ok) return generated;
    return {
      ok: true,
      bytes: generated.bytes,
      filename: outputFilename(definition, account.apexAccountNumber),
      definition,
      reviewState: definition.reviewState,
      clientCompletionRequired: generated.clientCompletionRequired,
      provenance: buildProvenance(definition, generated.overriddenCanonicalKeys),
      audit: {
        generatedAt: new Date().toISOString(),
        generatedBy: identity.email ?? null,
        formId: definition.id,
        formVersion: definition.version,
        templateSha256: definition.template.sha256,
      },
    };
  } catch (cause) {
    if (cause instanceof IraBeneficiaryRenderError || cause instanceof AcatRenderError || cause instanceof MappedFormRenderError) {
      return { ok: false, status: 422, code: "validation_failed", issues: cause.issues };
    }
    if (cause instanceof FormTemplateIntegrityError || cause instanceof AcatTemplateError || cause instanceof MappedFormTemplateError) {
      return { ok: false, status: 503, code: "template_version_mismatch" };
    }
    return { ok: false, status: 500, code: "generation_failed" };
  }
}
