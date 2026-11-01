"use client";

import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * The plaintext credential, shown ONCE.
 *
 * There is no "show it again": the row stores a SHA-256 digest and a display prefix, so the desk
 * genuinely cannot produce this string a second time. That is the property being protected, and the
 * panel says so in words rather than leaving an administrator to discover it by closing the page.
 *
 * It renders as a block of selectable text, not inside an `<input>`. A value in a form control is
 * offered to a password manager, is restored by the browser on a back-navigation, and can be
 * serialized by a form; plain text is none of those things. The copy button uses the clipboard API
 * when it is available and otherwise gets out of the way — the text is selectable either way, which
 * matters on a phone where `navigator.clipboard` needs a secure context.
 */
export type TokenSecretProps = {
  /** The prefix, so the administrator can match this secret to the row in the list below. */
  prefix: string;
  name: string;
  plaintext: string;
  onDismiss: () => void;
};

export function TokenSecret({ prefix, name, plaintext, onDismiss }: TokenSecretProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // No clipboard permission, or an insecure context. The text is selectable; nothing to report.
      setCopied(false);
    }
  }

  return (
    <Alert data-testid="api-token-secret" className="border-primary/40">
      <KeyRound aria-hidden />
      <AlertTitle>Copy this now — it is not shown again</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>
          The token for <strong>{name}</strong> ({prefix}). The desk stores only a fingerprint of it, so
          nobody — including an administrator — can read it back. If it is lost, rotate the credential.
        </span>
        <code
          className="block w-full overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs break-all select-all"
          aria-label="New API token"
        >
          {plaintext}
        </code>
        <span className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" onClick={() => void copy()} className="w-full sm:w-auto">
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy token"}
          </Button>
          <Button type="button" variant="outline" onClick={onDismiss} className="w-full sm:w-auto">
            I have saved it
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
