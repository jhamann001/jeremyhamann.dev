/**
 * Source guards for the Wave B composer and comment surfaces.
 *
 * This repo has no DOM test environment, so the claims a client component makes to an operator are
 * pinned the way `composer-copy.test.ts`, `requester-email-flow.test.ts` and
 * `src/app/(app)/tickets/[id]/streaming.test.ts` pin theirs: by asserting the SHAPE of the shipped
 * code. Each assertion below stands for a promise that no type can check and that a refactor could
 * quietly break.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Source with comments removed, for the two rules that scan for a banned STRING. A docstring
 * explaining why `localStorage` is not used must not read as a use of it — the same distinction
 * `stripComments` draws in `src/lib/guardrails.test.ts`.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const composerCode = code("src/components/ticket/composer.tsx");
const storeCode = code("src/components/ticket/composer-store.ts");
const aiButtonCode = code("src/components/ticket/ai-draft-button.tsx");

const composer = read("src/components/ticket/composer.tsx");
const commentItem = read("src/components/ticket/comment-item.tsx");
const aiButton = read("src/components/ticket/ai-draft-button.tsx");

describe("durable drafts", () => {
  it("still stores nothing in the browser — the MOBILE_FIRST §7 guardrail (D4)", () => {
    // Durability comes from a ComposerDraft ROW, not from localStorage: a browser store would keep
    // half-written client correspondence on whatever device it was typed on, unaudited and outside
    // every backup and retention policy this system has.
    for (const banned of ["persist(", "localStorage", "sessionStorage", "indexedDB"]) {
      expect(storeCode, `composer-store.ts must not use ${banned}`).not.toContain(banned);
      expect(composerCode, `composer.tsx must not use ${banned}`).not.toContain(banned);
    }
  });

  it("never autosaves before the restore has answered", () => {
    // An empty body written over a stored draft the restore has not yet delivered is the one way
    // this feature could destroy the text it exists to protect.
    expect(composer).toContain('if (!useComposerStore.getState().sync[ticketId]?.hydrated) return;');
  });

  it("writes on blur and on leaving the tab, not only after the idle window", () => {
    expect(composer).toContain('onBlur={() => flush("internal")}');
    expect(composer).toContain('onBlur={() => flush("public")}');
    expect(composer).toContain('flush(channel === "public" ? "public" : "internal");');
  });

  it("cancels the pending autosave when the comment is submitted", () => {
    // The comment's own transaction deletes the row; a save landing after it would resurrect a draft
    // for a reply that has already been written.
    expect(composer).toContain('cancelAutosave("internal");');
    expect(composer).toContain('cancelAutosave("public");');
  });

  it("clears every timer on unmount", () => {
    expect(composer).toContain("clearTimeout(handle)");
    expect(composer).toMatch(/return \(\) => \{[\s\S]{0,300}clearTimeout\(handle\)/);
  });

  it("offers a discard control and states the draft's condition in visible text (R10)", () => {
    // `data-control`, not `data-slot`: a caller-supplied `data-slot` replaces the primitive's own
    // `data-slot="button"` and removes the control from globals.css's 44 px phone rule.
    expect(composer).toContain('data-control="discard-draft"');
    expect(composer).not.toContain('data-slot="discard-draft"');
    expect(composer).toContain('data-slot="draft-status"');
    expect(composer).toContain("draftStatusLabel(");
    // Not a tooltip, and not an icon on its own.
    expect(composer).not.toContain("TooltipContent");
  });
});

describe("the AI draft control", () => {
  it("renders NOTHING when the seam is not configured", () => {
    expect(aiButton).toContain("if (!enabled) return null;");
  });

  it("resolves the flag on the server rather than importing the environment (G1)", () => {
    expect(composer).not.toContain('from "@/lib/env"');
    expect(aiButton).not.toContain('from "@/lib/env"');
    expect(composer).toContain("setAiEnabled(result.data.aiEnabled)");
  });

  it("has no send path of any kind — it fills the textarea and stops", () => {
    for (const banned of ["addPublicReply", "addInternalNote", "enqueueDelivery", "@/server/comments.actions"]) {
      expect(aiButton, `the AI control must not reach ${banned}`).not.toContain(banned);
    }
    expect(composer).toContain("setDraft(ticket.id, { reply: text });");
  });

  it("resets the disclaimer acknowledgement when a draft replaces the reply", () => {
    // The operator confirms the disclaimer against the words they end up with, never the ones the
    // draft replaced.
    const handler = /onDraft=\{\(text\) => \{[\s\S]*?\}\}/.exec(composer)?.[0] ?? "";
    expect(handler, "the AI onDraft handler was restructured").not.toBe("");
    expect(handler).toContain("setAcknowledged(false);");
  });

  it("says a person sends it, and never claims anything was sent", () => {
    expect(aiButton).toContain("save and send it, nothing does that for you");
    for (const forbidden of ["was sent", "has been sent", "Sent to the client"]) {
      expect(aiButtonCode).not.toContain(forbidden);
    }
  });
});

describe("the retraction overlay", () => {
  it("keeps the stored body on screen — a staff surface must read what the desk sent (I8)", () => {
    // `mentions={internal}` was added in integration round 1: an INTERNAL note's @handles are chipped
    // through a second remark plugin, so the body keeps its markdown AND its redaction marks. The
    // assertion that matters is unchanged — the STORED body is what reaches the renderer.
    expect(commentItem).toContain("<MarkdownRenderer source={comment.body} mentions={internal} />");
    expect(commentItem).toContain("line-through");
  });

  it("states who withdrew it, when and why, above the body and not only as a strike-through", () => {
    expect(commentItem).toContain('data-slot="comment-retraction"');
    expect(commentItem).toContain("Withdrawn by {who}");
    expect(commentItem).toContain("<span className=\"font-medium\">Reason:</span>");
    // Above: the banner renders before the body in source order.
    expect(commentItem.indexOf("<RetractionNotice comment={comment} />")).toBeLessThan(
      commentItem.indexOf("<MarkdownRenderer source={comment.body} mentions={internal} />"),
    );
  });

  it("tells the operator a sent email cannot be recalled, BEFORE the irreversible click", () => {
    const dialog = /<AlertDialogDescription>[\s\S]*?<\/AlertDialogDescription>/.exec(commentItem)?.[0] ?? "";
    expect(dialog, "the withdraw confirmation was restructured").not.toBe("");
    expect(dialog).toContain("cannot be recalled");
    expect(dialog).toContain("it does not unsend anything");
    expect(dialog).toContain("cannot be undone");
  });

  it("offers the control only on the desk's own outbound replies", () => {
    expect(commentItem).toContain('const withdrawable = mayRetract && !retracted && channel === "OUTBOUND";');
  });

  it("requires a typed reason at the DB's own floor before the button enables", () => {
    expect(commentItem).toContain("const ready = reason.trim().length >= WAVE_B_LIMITS.reasonMinChars;");
    expect(commentItem).toContain("disabled={pending || !ready}");
  });

  it("takes its capability from the composer's published fact, defaulting to closed", () => {
    expect(commentItem).toContain("const mayRetract = canRetract ?? published.canRetract;");
    expect(commentItem).toContain("NO_CAPABILITIES");
    expect(composer).toContain("const canRetract = canWriteQueue(viewer.groups, ticket.queueKey);");
  });
});
