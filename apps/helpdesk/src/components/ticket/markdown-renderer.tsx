import { createElement } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { remarkRedactionMarks } from "@/components/ticket/remark-redaction-marks";
import { MENTION_CHIP_CLASS, remarkMentionMarks } from "@/components/ticket/remark-mention-marks";

/**
 * Renders ticket / comment markdown.
 *
 * - `skipHtml`: raw HTML in a body is dropped, never rendered.
 * - Links open in a new tab with `rel="noopener noreferrer"`; URL protocols are limited by
 *   react-markdown's default `urlTransform` (http, https, mailto, tel, relative).
 * - `[REDACTED:…]` tokens become `<mark>` through the mdast plugin — the binding mechanism, because
 *   HTML pre-inserted into the source would be removed by `skipHtml`.
 * - Images render as their alt text: a remote `<img>` would make every viewer's browser call a
 *   third-party host from a books-and-records screen. (Conservative choice; not a cross-slice contract.)
 *
 * Usable from both RSC (timeline, description) and client components (composer preview).
 *
 * Written with `createElement` rather than JSX syntax on purpose: the frozen `vitest.config.ts` does
 * not override tsconfig's `jsx: "preserve"`, so vitest cannot import a file containing JSX — and the
 * contract's render test (`remark-redaction-marks.test.ts`) must import this component.
 */

type AnchorProps = React.ComponentPropsWithoutRef<"a"> & ExtraProps;

function SafeLink(props: AnchorProps): React.JSX.Element {
  const anchorProps: AnchorProps = { ...props };
  delete anchorProps.node;
  return createElement("a", { ...anchorProps, target: "_blank", rel: "noopener noreferrer" });
}

type ImageProps = React.ComponentPropsWithoutRef<"img"> & ExtraProps;

/** Images are never fetched; the alt text is shown in their place. */
function ImageAltText(props: ImageProps): React.JSX.Element {
  const alt = typeof props.alt === "string" && props.alt.trim().length > 0 ? props.alt.trim() : "image";
  return createElement("span", { className: "italic text-muted-foreground", "data-slot": "markdown-image" }, `[${alt}]`);
}

const MARKDOWN_CLASSES =
  "wm-markdown min-w-0 break-words text-sm leading-relaxed " +
  "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold " +
  "[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold " +
  "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 " +
  "[&_a]:underline [&_a]:underline-offset-2 [&_a]:text-primary " +
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] " +
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground " +
  "[&_hr]:my-3 [&_hr]:border-border " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 " +
  // Phone: a wide GFM table scrolls inside its card as an element-level scroller
  // (`[data-slot=markdown] table` is on the QA allowlist); real table layout returns at md.
  "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto md:[&_table]:table " +
  "[&_mark]:rounded [&_mark]:bg-amber-200 [&_mark]:px-1 [&_mark]:font-mono [&_mark]:text-[0.8em] [&_mark]:text-amber-950 dark:[&_mark]:bg-amber-700 dark:[&_mark]:text-amber-50 " +
  // Mention chips (integration round 1). The same tint `MentionText` uses, so an @handle reads the
  // same in the timeline, the composer preview and the inbox.
  `[&_.${MENTION_CHIP_CLASS}]:rounded-sm [&_.${MENTION_CHIP_CLASS}]:bg-primary/10 [&_.${MENTION_CHIP_CLASS}]:px-1 [&_.${MENTION_CHIP_CLASS}]:font-medium [&_.${MENTION_CHIP_CLASS}]:text-primary`;

/**
 * `mentions` (integration round 1) chips `@handle` tokens through a second mdast plugin. It is OPT-IN
 * and it is passed for INTERNAL notes only: an `@` in a client-facing reply is a typo or an address
 * the client wrote, never a desk instruction, and chipping it would tell a reader that a colleague had
 * been notified when nobody had. `src/components/ticket/remark-mention-marks.ts` has the argument for
 * why this is a plugin rather than swapping in `MentionText`.
 */
export function MarkdownRenderer({
  source,
  className,
  mentions = false,
}: {
  source: string;
  className?: string;
  mentions?: boolean;
}): React.JSX.Element {
  // Redaction runs FIRST, so a `[REDACTED:…]` token is already a marked node by the time the mention
  // pass walks the tree and is skipped by it. The reverse order could chip inside a redaction token.
  const remarkPlugins = mentions
    ? [remarkGfm, remarkRedactionMarks, remarkMentionMarks]
    : [remarkGfm, remarkRedactionMarks];
  return createElement(
    "div",
    { className: cn(MARKDOWN_CLASSES, className), "data-slot": "markdown" },
    createElement(
      Markdown,
      {
        skipHtml: true,
        remarkPlugins,
        components: { a: SafeLink, img: ImageAltText },
      },
      source,
    ),
  );
}
