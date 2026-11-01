/**
 * Fix round 2 — source guards for two claims the ticket UI makes to an operator, both of which were
 * wrong in a way no type can catch.
 *
 * The repo has no DOM test environment, so these assert the SHAPE of the client code the way
 * `requester-email-flow.test.ts` and `src/app/(app)/tickets/[id]/streaming.test.ts` do.
 *
 *  1. **The composer never promises delivery it cannot make.** `writePublicReply` enqueues a
 *     `MessageDelivery` only when the ticket carries a non-empty `requesterEmail`, and the client API
 *     authorizes on that same column — so on a phone-only ticket (Decision #62 / CROSSWALK P2) a public
 *     reply reaches the client through no channel at all. The confirm dialog used to promise delivery
 *     unconditionally and a toast retracted it after the comment was written, which is immutable (I2/I8).
 *  2. **A disabled channel explains itself in visible text**, not in a tooltip a disabled control can
 *     never fire and a phone can never summon.
 *
 * Plus the upload sheet's two honesty fixes: no close button that does nothing, and a Cancel that
 * actually aborts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const composer = read("src/components/ticket/composer.tsx");
const upload = read("src/components/ticket/attachments/attachment-upload.tsx");
const macroReads = read("src/server/macros.ts");

describe("the public-reply composer claims delivery only when there is an address", () => {
  it("derives deliverability from the ticket the way the server does", () => {
    expect(composer).toContain('const canDeliverToClient = (ticket.requesterEmail ?? "").trim().length > 0;');
  });

  it("the confirm dialog branches on it instead of promising a queue unconditionally", () => {
    const dialog = /<AlertDialogDescription>[\s\S]*?<\/AlertDialogDescription>/.exec(composer)?.[0] ?? "";
    expect(dialog, "AlertDialogDescription not found — the confirm step was restructured").not.toBe("");
    expect(dialog).toContain("{canDeliverToClient ? (");
    // The delivery sentence must sit on the true branch only.
    const [withAddress, withoutAddress] = dialog.split(") : (");
    expect(withAddress).toContain("queued for delivery");
    expect(withoutAddress).not.toContain("queued for delivery");
    expect(withoutAddress).toContain("not");
    expect(withoutAddress).toContain("emailed");
  });

  it("warns in the Public pane before a word is typed, not only after the save", () => {
    expect(composer).toContain('data-slot="no-delivery-address"');
    expect(composer).toContain("{!canDeliverToClient ? (");
    // The notice must render above the editor, i.e. before the write/preview switch.
    expect(composer.indexOf('data-slot="no-delivery-address"')).toBeLessThan(
      composer.indexOf('{mode === "write" ? ('),
    );
  });

  it("still never says a reply was sent (CONTRACT §10 S3 copy rule)", () => {
    for (const forbidden of ["was sent", "has been sent", "Sent to the client", "Send reply"]) {
      expect(composer).not.toContain(forbidden);
    }
  });
});

describe("a disabled composer channel states its reason in visible text", () => {
  it("renders the reason as a <p>, not a Tooltip", () => {
    expect(composer).not.toContain("TooltipContent");
    expect(composer).not.toContain('from "@/components/ui/tooltip"');
    expect(composer).toContain('data-slot="channel-disabled-reason"');
    expect(composer).toContain("{channelDisabledReason !== null ? (");
  });

  it("picks the single disabled channel's reason (both disabled renders the read-only card)", () => {
    expect(composer).toContain("const channelDisabledReason = !permissions.canInternalNote");
    expect(composer).toContain("const nothingAllowed = !permissions.canInternalNote && !permissions.canPublicReply;");
  });

  it("wires the disabled trigger to that visible line for a screen reader", () => {
    expect(composer).toContain("aria-describedby={disabled ? reasonId : undefined}");
    expect(composer).toContain("reasonId={ids.channelReason}");
  });
});

/**
 * Fix round 1. A macro may carry structured side effects that apply ATOMICALLY in the same
 * transaction as the comment — a macro with `{"status":"PENDING_CLIENT"}` moved a
 * ticket OPEN → PENDING_CLIENT on confirm while the composer said nothing and the confirmation dialog
 * listed the disclaimer, the delivery and the immutability and omitted the ticket mutation it was
 * about to commit. `/admin/macros` already renders the sentence ("Set the status to Pending client,
 * when the state machine allows it") under a "What this will change" heading, so the copy existed and
 * was simply not carried to the point of use.
 */
describe("the composer discloses what an inserted macro will do to the ticket", () => {
  it("the runtime macro read carries the actions column at all", () => {
    // Without this the composer has nothing to describe: `MacroDTO` has no `actions` field and the
    // column was previously read only by the ADMIN list.
    expect(macroReads).toContain("export type MacroRuntimeRow = MacroDTO & { actions: MacroActions | null };");
    const fn = /export async function listMacros\([\s\S]*?\n}/.exec(macroReads)?.[0] ?? "";
    expect(fn, "listMacros not found — the runtime read was restructured").not.toBe("");
    expect(fn).toContain("actions: true,");
    expect(fn).toContain("parseMacroActions(m.actions, m.key)");
    // A blob the schema refuses must not throw out of the ticket page's Promise.all.
    expect(fn).toContain("} catch {");
  });

  it("describes the macro with the admin screen's own helper, never a second copy", () => {
    expect(composer).toContain('import { describeMacroActions } from "@/components/admin/macros/macro-form-support";');
    // No hand-rolled sentence about a status/priority/queue change anywhere in this file.
    expect(composer).not.toMatch(/Set the (status|priority) to/);
  });

  it("resolves the effects per channel from the macro actually inserted there", () => {
    expect(composer).toContain(
      "const replyMacroActions = macros.find((m) => m.id === draft.replyMacroId)?.actions ?? null;",
    );
    expect(composer).toContain(
      "const noteMacroActions = macros.find((m) => m.id === draft.noteMacroId)?.actions ?? null;",
    );
  });

  it("renders nothing when the macro only pastes text", () => {
    const fn = /function MacroEffects\([\s\S]*?\n}/.exec(composer)?.[0] ?? "";
    expect(fn, "MacroEffects not found").not.toBe("");
    expect(fn).toContain("if (lines.length === 0) return null;");
  });

  it("shows the effects in BOTH panes, beside the picker that caused them", () => {
    expect(composer).toContain("<MacroEffects actions={noteMacroActions} />");
    expect(composer).toContain("<MacroEffects actions={replyMacroActions} />");
    // Each disclosure follows its own MacroPicker rather than hiding at the bottom of the pane.
    for (const [picker, effects] of [
      ['channel="INTERNAL"', "<MacroEffects actions={noteMacroActions} />"],
      ['channel="PUBLIC"', "<MacroEffects actions={replyMacroActions} />"],
    ]) {
      expect(composer.indexOf(picker)).toBeGreaterThan(-1);
      expect(composer.indexOf(effects)).toBeGreaterThan(composer.indexOf(picker));
    }
  });

  it("the reply confirmation enumerates the ticket mutation alongside its other consequences", () => {
    const dialog = /<AlertDialogDescription>[\s\S]*?<\/AlertDialogDescription>/.exec(composer)?.[0] ?? "";
    expect(dialog, "AlertDialogDescription not found — the confirm step was restructured").not.toBe("");
    expect(dialog).toContain("replyMacroEffects.length > 0");
    expect(dialog).toContain("The macro you inserted also applies:");
    // It sits with the other consequences, above the immutability sentence that closes the paragraph.
    expect(dialog.indexOf("The macro you inserted also applies:")).toBeLessThan(
      dialog.indexOf("Comments are records"),
    );
  });

  it("the dialog sentence is built from the same helper as the panes", () => {
    expect(composer).toContain("const replyMacroEffects = describeMacroActions(replyMacroActions);");
  });
});

describe("the attachment upload sheet offers no control that does nothing", () => {
  it("withdraws the close X while an upload is in flight", () => {
    expect(upload).toContain("showCloseButton={!busy}");
  });

  it("keeps the xhr so Cancel can abort it, instead of disabling Cancel", () => {
    expect(upload).toContain("const uploadXhr = useRef<XMLHttpRequest | null>(null);");
    expect(upload).toContain("uploadXhr.current?.abort();");
    expect(upload).not.toContain('<Button type="button" variant="ghost" className="min-h-11" disabled={busy}');
    expect(upload).toContain("disabled={(busy && !cancellable) || cancelling}");
    expect(upload).toContain('{busy ? "Cancel upload" : "Cancel"}');
  });

  it("refuses to pretend the committing step can be cancelled", () => {
    expect(upload).toContain('const cancellable = busy && phase !== "finalizing";');
    expect(upload).toContain("The file is being recorded and can no longer be cancelled.");
  });

  it("honours a cancel pressed during a step that has no abort of its own", () => {
    const fn = /const upload = useCallback\(async \(\)[\s\S]*?\n  }, \[busy/.exec(upload)?.[0] ?? "";
    expect(fn, "upload() not found — the flow was restructured").not.toBe("");
    // One checkpoint after the intent, one after the checksum; none after finalize, which has committed.
    expect(fn.match(/if \(abandon\(\)\) return;/g)?.length).toBe(2);
    expect(fn.lastIndexOf("if (abandon()) return;")).toBeLessThan(fn.indexOf('setPhase("finalizing")'));
  });
});
