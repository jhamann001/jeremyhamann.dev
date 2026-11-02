import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FormDefinition } from "./form-definition";

export class FormTemplateIntegrityError extends Error {
  constructor(readonly formId: string) {
    super(`The template for ${formId} did not match its registered version`);
    this.name = "FormTemplateIntegrityError";
  }
}

export async function loadFormTemplate(
  definition: FormDefinition,
  root = process.cwd(),
): Promise<Uint8Array> {
  const templatePath = path.join(root, definition.template.relativePath);
  const bytes = await readFile(templatePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== definition.template.sha256) {
    throw new FormTemplateIntegrityError(definition.id);
  }
  return bytes;
}
