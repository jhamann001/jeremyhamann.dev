// Writes the demo's invented transfer form to public/form-templates. Run after
// changing src/lib/demo/transfer-form-template.ts; a test fails until the
// committed file matches the generator.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildTransferFormTemplate, TRANSFER_FORM_TEMPLATE_PATH } from "../src/lib/demo/transfer-form-template";

async function main() {
  const target = join(process.cwd(), TRANSFER_FORM_TEMPLATE_PATH);
  const bytes = await buildTransferFormTemplate();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  console.log(`Wrote ${TRANSFER_FORM_TEMPLATE_PATH} (${bytes.byteLength} bytes)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
