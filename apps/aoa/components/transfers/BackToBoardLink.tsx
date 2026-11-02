"use client";
import { ListBackLink } from "@/components/navigation/ListBackLink";

/** Exact same-app origin only; arbitrary browser history is not evidence of a board visit. */
export function BackToBoardLink({ className, scope = "" }: { className?: string; scope?: string }) {
  return <ListBackLink scope={scope} fallback="/asset-transfer" className={className}>‹ All transfers</ListBackLink>;
}
