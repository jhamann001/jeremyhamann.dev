// Prints the demo's settings (demo-config.json) as KEY=value lines for $GITHUB_ENV: the same settings the
// Worker hands the container, so the reset and the deploy run with what the app runs with. None is a secret.
// Refuses anything that is not a plain upper-case key with a one-line value.
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../demo-config.json", import.meta.url), "utf8"));
for (const [key, value] of Object.entries(config)) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) {
    console.error(`demo-config.json: refusing an unexpected key or value: ${key}`);
    process.exit(1);
  }
  console.log(`${key}=${value}`);
}
