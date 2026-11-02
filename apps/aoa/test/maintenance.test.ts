import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appWritesPaused } from "@/lib/maintenance";

describe("appWritesPaused", () => {
  const original = process.env.AOA_WRITES_PAUSED;

  beforeEach(() => {
    delete process.env.AOA_WRITES_PAUSED;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AOA_WRITES_PAUSED;
    else process.env.AOA_WRITES_PAUSED = original;
  });

  it.each([undefined, "", "false", "FALSE", "0", " false "])(
    "allows writes for %s",
    (value) => {
      if (value === undefined) delete process.env.AOA_WRITES_PAUSED;
      else process.env.AOA_WRITES_PAUSED = value;
      expect(appWritesPaused()).toBe(false);
    },
  );

  it.each(["true", "1", "yes", "unexpected"])(
    "fails closed for %s",
    (value) => {
      process.env.AOA_WRITES_PAUSED = value;
      expect(appWritesPaused()).toBe(true);
    },
  );
});
