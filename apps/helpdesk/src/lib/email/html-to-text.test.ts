import { describe, expect, it } from "vitest";
import { HTML_INPUT_MAX_CHARS, htmlToText } from "@/lib/email/html-to-text";
import { fixture } from "@/lib/email/__fixtures__/inbound-corpus";

describe("htmlToText", () => {
  it("returns '' for empty, non-string and over-long input", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText(undefined as unknown as string)).toBe("");
    expect(htmlToText(`<p>${"a".repeat(HTML_INPUT_MAX_CHARS)}</p>`)).toBe("");
  });

  it("drops script, style, head and comments entirely", () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style></head><body>
      <!-- hidden --><script>alert('x')</script><p>Visible</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toBe("Visible");
  });

  it("preserves a link as 'text <url>'", () => {
    expect(htmlToText('<p>See <a href="https://example.com/forms">the form</a>.</p>')).toBe(
      "See the form <https://example.com/forms>.",
    );
  });

  it("does not double a link whose text already is the url", () => {
    expect(htmlToText('<a href="https://example.com/help">https://example.com/help</a>')).toBe(
      "https://example.com/help",
    );
  });

  it("renders a mailto link as the address", () => {
    expect(htmlToText('<a href="mailto:service@example.com">service@example.com</a>')).toBe(
      "service@example.com",
    );
    expect(htmlToText('<a href="mailto:service@example.com">Client Service</a>')).toBe(
      "Client Service <service@example.com>",
    );
  });

  it("drops a javascript: or data: href but keeps the label", () => {
    expect(htmlToText(`<a href="javascript:steal()">Click here</a>`)).toBe("Click here");
    expect(htmlToText(`<a href="data:text/html,x">Click here</a>`)).toBe("Click here");
  });

  it("flattens a table into ' | ' cells and one row per line", () => {
    const html =
      "<table><tr><th>Form</th><th>Use</th></tr><tr><td>ACAT full</td><td>Move everything</td></tr></table>";
    expect(htmlToText(html)).toBe("Form | Use\nACAT full | Move everything");
  });

  it("turns list items into dashes and br into newlines", () => {
    expect(htmlToText("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two");
    expect(htmlToText("Line one<br>Line two<br/>Line three")).toBe("Line one\nLine two\nLine three");
  });

  it("marks blockquote content with '>' so the quoted-history stripper can see it", () => {
    const text = htmlToText("<div>My reply</div><blockquote><div>Old message</div></blockquote>");
    expect(text).toBe("My reply\n\n> Old message");
  });

  it("decodes entities only AFTER tags are stripped, so &lt;script&gt; can never become markup", () => {
    const text = htmlToText("<p>&lt;script&gt;alert(1)&lt;/script&gt; is literal</p>");
    expect(text).toBe("<script>alert(1)</script> is literal");
  });

  it("decodes named, decimal and hex entities including nbsp", () => {
    expect(htmlToText("<p>A&nbsp;&amp;&nbsp;B &#39;quoted&#39; &#x2019;s &mdash; end</p>")).toBe(
      "A & B 'quoted' ’s — end",
    );
  });

  it("drops lone surrogates rather than storing broken text", () => {
    expect(htmlToText("<p>a&#xD800;b</p>")).toBe("ab");
  });

  it("collapses runs of blank lines and trims", () => {
    expect(htmlToText("<div>a</div><div></div><div></div><div></div><div>b</div>")).toBe("a\n\nb");
  });

  it("converts the HTML fixture to readable text with its links and table intact", () => {
    const html = fixture("new-thread-html").htmlBody as string;
    const text = htmlToText(html);
    expect(text).toContain("I am moving an outside IRA over.");
    expect(text).toContain("Form | Use");
    expect(text).toContain("ACAT full | Move everything");
    expect(text).toContain("here <https://example.com/forms/transfers>");
    expect(text).toContain("https://example.com/help");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("margin:0");
  });
});
