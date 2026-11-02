export const TASKS_OPEN_ID = "tasks-open";

/** Keep the outer disclosure pinned within the shared 20-ID memory budget. */
export function rememberTaskDisclosure(current: string[], id: string, open: boolean): string[] {
  const outerOpen = id === TASKS_OPEN_ID ? open : current.includes(TASKS_OPEN_ID);
  const rows = current.filter(value => value !== TASKS_OPEN_ID && value !== id);
  if (id !== TASKS_OPEN_ID && open) rows.push(id);
  return [...rows.slice(-19), ...(outerOpen ? [TASKS_OPEN_ID] : [])];
}
