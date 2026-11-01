/**
 * Writes the seeded attachment files at the filesystem store's paths, for the image build:
 *
 *   npm run demo:attachments -- <dir>
 *
 * The bytes are a pure function of the universe (src/lib/demo/attachments.ts), so the files baked into the
 * image match the size and digest the nightly reset writes on the rows.
 */
import { LOCAL_ATTACHMENTS_DIR } from "../src/lib/storage";
import { writeDemoAttachments } from "../src/lib/demo/attachments";
import { loadUniverse } from "../src/lib/demo/universe";

async function main(): Promise<void> {
  const dir = process.argv[2] ?? LOCAL_ATTACHMENTS_DIR;
  const written = await writeDemoAttachments(dir, loadUniverse());
  console.log(`${written} seeded attachment files written under ${dir}/`);
}

main().catch((err: unknown) => {
  process.stderr.write(`demo attachments failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
  process.exit(1);
});
