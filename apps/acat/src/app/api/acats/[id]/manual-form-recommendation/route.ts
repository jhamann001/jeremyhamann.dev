import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { fillApexTransferForm } from "@/lib/apex-transfer-form";
import { logger } from "@/lib/logger";
import {
  buildManualTransferFormRecommendation,
  getApexTransferSelection,
  getAssetHandlingRule,
  parseRequiredFlag,
} from "@/lib/manual-transfer-forms";
import { prisma } from "@/lib/prisma";
import { buildTransferDocument } from "@/lib/transfer-documents";
import { assertDemoRoom, demoLimitResponse, documentHolds, withDemoQuota } from "@/lib/demo/limits";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const generateFormSchema = z
  .object({
    ruleId: z.string().trim().min(1).max(100).optional(),
    assetInstruction: z.enum(["IN_KIND", "LIQUIDATE"]).optional(),
    apexAccountTitle: z.string().trim().min(1).max(200),
    apexAccountTitleVerified: z.literal(true),
    deliveringAccountTitle: z.string().trim().min(1).max(200).optional(),
    deliveringAccountTitleVerified: z.literal(true).optional(),
    receivingAccountNumber: z.string().trim().min(1).max(100).optional(),
    receivingAccountNumberVerified: z.literal(true).optional(),
  })
  .strict();

const saveApexTitleSchema = z
  .object({
    apexAccountTitle: z.string().trim().min(1).max(200),
    confirmed: z.boolean(),
  })
  .strict();

const APEX_TEMPLATE_PATH = join(
  process.cwd(),
  "public/form-templates/apex-customer-account-transfer-request.pdf"
);

function buildApexAccountTitleSuggestion(
  clientName: string,
  accountType?: string | null
): string {
  return [clientName.trim(), accountType?.trim()].filter(Boolean).join(" - ");
}

function normalizeAccountTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isPartialTransfer(type?: string | null): boolean {
  return type?.trim().toLowerCase().includes("partial") === true;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      select: {
        clientName: true,
        accountType: true,
        type: true,
        transferringContra: true,
        dtccNumber: true,
        verifiedApexAccountTitle: true,
        verifiedApexAccountTitleAt: true,
        verifiedApexAccountTitleBy: true,
        assets: { select: { includeInTransfer: true } },
        custodian: {
          select: {
            id: true,
            name: true,
            receivingAccountNumber: true,
            signature: true,
            letterOfAcceptance: true,
            medallionRequired: true,
            liquidationMethod: true,
            returnMethod: true,
            watchouts: true,
          },
        },
      },
    });

    if (!record) {
      return NextResponse.json(
        { error: "ACAT record not found" },
        { status: 404 }
      );
    }

    const selectionAssets = record.assets ?? [];
    return NextResponse.json({
      ...buildManualTransferFormRecommendation(record, record.custodian),
      // Prefer the last human-confirmed Apex title. Only fall back to the
      // generated client/account-type suggestion when nothing has been saved.
      apexAccountTitleSuggestion:
        record.verifiedApexAccountTitle ??
        buildApexAccountTitleSuggestion(record.clientName, record.accountType),
      apexAccountTitleConfirmation: record.verifiedApexAccountTitle
        ? {
            title: record.verifiedApexAccountTitle,
            confirmedAt: record.verifiedApexAccountTitleAt,
            confirmedBy: record.verifiedApexAccountTitleBy,
          }
        : null,
      // The exact delivering title is not stored on the ACAT record. For
      // inherited accounts, the UI requires the preparer to replace or confirm
      // this suggestion against the current statement before generation.
      deliveringAccountTitleSuggestion: record.clientName.trim(),
      partialAssetSelection: isPartialTransfer(record.type)
        ? {
            required: true,
            total: selectionAssets.length,
            included: selectionAssets.filter(
              (asset) => asset.includeInTransfer === true
            ).length,
            excluded: selectionAssets.filter(
              (asset) => asset.includeInTransfer === false
            ).length,
            undecided: selectionAssets.filter(
              (asset) => asset.includeInTransfer == null
            ).length,
          }
        : { required: false, total: selectionAssets.length, included: selectionAssets.length, excluded: 0, undecided: 0 },
    });
  } catch (err) {
    logger.error(
      { err, acatId: id },
      "GET /api/acats/[id]/manual-form-recommendation failed"
    );
    return NextResponse.json(
      { error: "Failed to build manual form recommendation" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const parsed = saveApexTitleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid Apex account-title confirmation" },
        { status: 400 }
      );
    }
    const existing = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      select: { verifiedApexAccountTitle: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "ACAT record not found" },
        { status: 404 }
      );
    }

    const confirmedAt = parsed.data.confirmed
      ? new Date().toISOString()
      : null;
    const updated = await prisma.acatRecord.update({
      where: { id },
      data: {
        verifiedApexAccountTitle: parsed.data.confirmed
          ? parsed.data.apexAccountTitle
          : null,
        verifiedApexAccountTitleAt: confirmedAt,
        verifiedApexAccountTitleBy: parsed.data.confirmed
          ? session.user.email
          : null,
        lastUpdated: new Date().toISOString(),
        updatedBy: session.user.email,
      },
      select: {
        verifiedApexAccountTitle: true,
        verifiedApexAccountTitleAt: true,
        verifiedApexAccountTitleBy: true,
      },
    });

    try {
      await prisma.auditLog.create({
        data: {
          acatRecordId: id,
          action: parsed.data.confirmed
            ? "apex-account-title-confirm"
            : "apex-account-title-clear",
          field: "verifiedApexAccountTitle",
          oldValue: existing.verifiedApexAccountTitle,
          newValue: updated.verifiedApexAccountTitle,
          performedBy: session.user.email,
        },
      });
    } catch (auditError) {
      logger.warn(
        { err: auditError, acatId: id },
        "failed to write Apex account-title confirmation audit log"
      );
    }

    return NextResponse.json({
      title: updated.verifiedApexAccountTitle,
      confirmedAt: updated.verifiedApexAccountTitleAt,
      confirmedBy: updated.verifiedApexAccountTitleBy,
    });
  } catch (err) {
    logger.error(
      { err, acatId: id },
      "PUT /api/acats/[id]/manual-form-recommendation failed"
    );
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to save the Apex account title" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const parsed = generateFormSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid form-generation request" },
        { status: 400 }
      );
    }

    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      select: {
        clientName: true,
        accountType: true,
        type: true,
        apexAccountId: true,
        statementAccountNumber: true,
        transferringContra: true,
        dtccNumber: true,
        assets: {
          orderBy: { id: "asc" },
          select: {
            symbol: true,
            description: true,
            cusip: true,
            expectedQty: true,
            amount: true,
            assetClass: true,
            includeInTransfer: true,
          },
        },
        custodian: {
          select: {
            id: true,
            name: true,
            receivingAccountNumber: true,
            signature: true,
            letterOfAcceptance: true,
            medallionRequired: true,
            liquidationMethod: true,
            returnMethod: true,
            watchouts: true,
          },
        },
      },
    });

    if (!record) {
      return NextResponse.json(
        { error: "ACAT record not found" },
        { status: 404 }
      );
    }

    let assetsForForm = record.assets;
    if (isPartialTransfer(record.type)) {
      const undecidedCount = record.assets.filter(
        (asset) => asset.includeInTransfer == null
      ).length;
      if (undecidedCount > 0) {
        return NextResponse.json(
          {
            error: `Choose Yes or No for every holding before generating partial-transfer paperwork (${undecidedCount} undecided).`,
          },
          { status: 409 }
        );
      }
      assetsForForm = record.assets.filter(
        (asset) => asset.includeInTransfer === true
      );
      if (assetsForForm.length === 0) {
        return NextResponse.json(
          { error: "Include at least one holding before generating partial-transfer paperwork." },
          { status: 409 }
        );
      }
    }

    const recommendation = buildManualTransferFormRecommendation(
      record,
      record.custodian
    );
    const deliveringAccountTitle =
      parsed.data.deliveringAccountTitle?.trim();
    if (
      recommendation.inheritedAccountTitleReviewRequired &&
      (!deliveringAccountTitle ||
        parsed.data.deliveringAccountTitleVerified !== true)
    ) {
      return NextResponse.json(
        {
          error:
            "Confirm the exact delivering account title from the current statement before generating",
        },
        { status: 400 }
      );
    }
    const inheritedTitleMismatch =
      recommendation.inheritedAccountTitleReviewRequired &&
      normalizeAccountTitle(deliveringAccountTitle ?? "") !==
        normalizeAccountTitle(parsed.data.apexAccountTitle);

    const rule = parsed.data.ruleId
      ? recommendation.candidates.find(
          (candidate) => candidate.id === parsed.data.ruleId
        )
      : recommendation.candidates.length === 1
        ? recommendation.candidates[0]
        : null;
    if (!rule) {
      return NextResponse.json(
        {
          error:
            recommendation.candidates.length > 1
              ? "Select the form workflow supported by the current documentation"
              : "The selected form workflow is not valid for this custodian",
        },
        { status: 400 }
      );
    }
    if (rule.template !== "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST") {
      return NextResponse.json(
        { error: "The selected workflow is not available for automated generation" },
        { status: 400 }
      );
    }

    const receivingAccountNumber = parsed.data.receivingAccountNumber?.trim();
    if (
      rule.requiresVerifiedReceivingAccountNumber &&
      (!receivingAccountNumber ||
        parsed.data.receivingAccountNumberVerified !== true)
    ) {
      return NextResponse.json(
        {
          error:
            "Verify the receiving/house account number with Apex MF Ops before generating",
        },
        { status: 400 }
      );
    }

    const handling = getAssetHandlingRule(rule);
    const assetInstruction =
      handling.mode === "FIXED"
        ? handling.instruction
        : parsed.data.assetInstruction ?? handling.defaultInstruction;
    const apexTransferSelection = isPartialTransfer(record.type)
      ? "PARTIAL_TRANSFER"
      : getApexTransferSelection(rule, assetInstruction);
    if (!apexTransferSelection) {
      return NextResponse.json(
        { error: "The selected workflow has no Apex transfer section" },
        { status: 400 }
      );
    }
    // Building the PDF is the costly part; skip it when the demo has no room to keep the result.
    await assertDemoRoom(["documents", "documentBytes"]);
    const template = await readFile(APEX_TEMPLATE_PATH);
    const output = await fillApexTransferForm(template, {
      generatedOn: new Date(),
      clientName: record.clientName,
      apexAccountNumber: record.apexAccountId,
      apexAccountTitle: parsed.data.apexAccountTitle,
      receivingAccountNumber: rule.requiresVerifiedReceivingAccountNumber
        ? receivingAccountNumber
        : undefined,
      transferringAccountNumber: record.statementAccountNumber,
      transferringAccountTitle: deliveringAccountTitle ?? record.clientName,
      deliveringFirmName:
        record.transferringContra?.trim() || record.custodian?.name || "",
      brokerClearingNumber: record.dtccNumber,
      apexTransferSelection,
      assetInstruction,
      // The Custodian Library remains the source of institutional LOA
      // requirements. An inherited-account registration mismatch is a
      // separate, client-specific form trigger confirmed during preparation.
      letterOfAuthorizationRequired:
        parseRequiredFlag(record.custodian?.letterOfAcceptance) === true ||
        inheritedTitleMismatch,
      assets: assetsForForm,
    });

    const safeClientName =
      record.clientName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "client";
    // Archive exactly the bytes we return, along with all included/excluded
    // inputs from this read. A later regeneration must not overwrite history.
    // Fail closed if storage fails: do not download an untracked output.
    const document = buildTransferDocument({
      kind: "TRANSFER_FORM",
      filename: `${safeClientName}-Apex-CATR.pdf`,
      createdBy: session.user.email,
      accountNumber: record.statementAccountNumber,
      positions: record.assets.map((asset) => ({ ...asset, includeInTransfer: isPartialTransfer(record.type) ? asset.includeInTransfer : true })),
      content: output,
    });
    const savedDocument = await withDemoQuota(documentHolds(document), (db) =>
      db.acatDocument.create({
        data: { ...document, acatRecord: { connect: { id, deletedAt: null } } },
        select: { id: true },
      })
    );

    try {
      await prisma.auditLog.create({
        data: {
          acatRecordId: id,
          action: "manual-form-generate",
          field: "manualFormRule",
          oldValue: null,
          newValue: `${rule.id}:${assetInstruction}`,
          performedBy: session.user.email,
        },
      });
    } catch (auditError) {
      logger.warn(
        { err: auditError, acatId: id },
        "failed to write manual form generation audit log"
      );
    }

    return new Response(Buffer.from(output), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeClientName}-Apex-CATR.pdf"`,
        "Cache-Control": "no-store",
        "X-Transfer-Document-Id": savedDocument.id,
      },
    });
  } catch (err) {
    const limitResponse = demoLimitResponse(err);
    if (limitResponse) return limitResponse;
    logger.error(
      { errorType: err instanceof Error ? err.name : "UnknownError", acatId: id },
      "POST /api/acats/[id]/manual-form-recommendation failed"
    );
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to generate the Apex transfer form" },
      { status: 500 }
    );
  }
}
