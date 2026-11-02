"use client";

import { useRouter } from "next/navigation";
import type { FormEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { viewHref, viewPath } from "./view-helpers";

/**
 * A GET filter form for the workspace lists. Without script it submits
 * natively; with it, blank fields are dropped and the router navigates.
 * Controls outside the form join it through their `form` attribute.
 */
export function FilterForm({ id, className, params, children }: {
  id?: string; className?: string; params: Record<string, string | null | undefined>; children?: ReactNode;
}) {
  const router = useRouter();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter ?? null;
    const values: Record<string, string> = {};
    for (const [key, value] of new FormData(event.currentTarget, submitter)) if (typeof value === "string") values[key] = value.trim();
    router.push(viewHref({ view: params.view, ...values }), { scroll: false });
  };
  return (
    <form id={id} className={className} action={viewPath(params.view)} method="get" onSubmit={submit}>
      {Object.entries(params).map(([key, value]) => value && key !== "view" ? <input key={key} type="hidden" name={key} value={value} /> : null)}
      <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
      {children}
    </form>
  );
}

export function SubmitOnChangeSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} onChange={event => event.currentTarget.form?.requestSubmit()} />;
}

export function SubmitOnChangeInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} onChange={event => { if (event.currentTarget.validity.valid) event.currentTarget.form?.requestSubmit(); }} />;
}
