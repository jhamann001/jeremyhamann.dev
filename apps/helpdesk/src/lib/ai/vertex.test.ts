/**
 * The Vertex REST shape. Unit: no network, no metadata server, no project.
 *
 * The request body and the response reader are exported precisely so they can be asserted here —
 * "we send the firm voice rules as the system instruction and plain text comes back" is a claim, and
 * a claim about an outbound call to a third party is worth a test that does not require the third party.
 */
import { describe, expect, it } from "vitest";
import { AiProviderError } from "@/lib/ai/errors";
import {
  VERTEX_MAX_OUTPUT_TOKENS,
  VERTEX_TEMPERATURE,
  extractDraftText,
  generateContentBody,
  generateContentUrl,
} from "@/lib/ai/vertex";

const cfg = { project: "helpdesk-demo", location: "us-central1", model: "gemini-2.0-flash" };

describe("generateContentUrl", () => {
  it("targets the regional aiplatform host and the publisher model", () => {
    expect(generateContentUrl(cfg)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/helpdesk-demo" +
        "/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent",
    );
  });

  it("percent-encodes every interpolated segment", () => {
    const url = generateContentUrl({ project: "a/b", location: "eu west", model: "m?x" });
    expect(url).toContain("projects/a%2Fb");
    expect(url).toContain("models/m%3Fx");
    expect(url).not.toContain("a/b/locations");
  });
});

describe("generateContentBody", () => {
  it("sends the system half as systemInstruction and the task as the single user turn", () => {
    const body = generateContentBody({ system: "RULES", user: "TASK" }) as Record<string, unknown>;
    expect(body).toMatchObject({
      systemInstruction: { role: "system", parts: [{ text: "RULES" }] },
      contents: [{ role: "user", parts: [{ text: "TASK" }] }],
    });
  });

  it("asks for plain text at a low temperature with a bounded output", () => {
    const body = generateContentBody({ system: "", user: "" }) as {
      generationConfig: { temperature: number; maxOutputTokens: number; responseMimeType: string };
    };
    expect(body.generationConfig.responseMimeType).toBe("text/plain");
    expect(body.generationConfig.temperature).toBe(VERTEX_TEMPERATURE);
    expect(body.generationConfig.maxOutputTokens).toBe(VERTEX_MAX_OUTPUT_TOKENS);
  });
});

describe("extractDraftText", () => {
  it("concatenates the first candidate's text parts", () => {
    const raw = { candidates: [{ content: { parts: [{ text: "Hello " }, { text: "there." }] } }] };
    expect(extractDraftText(raw)).toBe("Hello there.");
  });

  it("refuses an empty or blocked candidate, naming the finish reason and nothing else", () => {
    const raw = { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] };
    expect(() => extractDraftText(raw)).toThrow(AiProviderError);
    expect(() => extractDraftText(raw)).toThrow(/SAFETY/);
  });

  it("refuses a response with no candidates at all", () => {
    expect(() => extractDraftText({})).toThrow(AiProviderError);
  });

  it("ignores non-string parts rather than stringifying them into the draft", () => {
    const raw = { candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { data: "x" } }] } }] };
    expect(extractDraftText(raw)).toBe("ok");
  });
});
