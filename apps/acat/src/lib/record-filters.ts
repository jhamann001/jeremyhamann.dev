import { AcatRecord } from "./types";
import {
  FieldType,
  RECORD_FIELDS_BY_KEY,
  RecordFieldKey,
} from "./record-fields";

/** Multiselect values are stored on the record as a comma-delimited list. */
function parseMultiselectValue(s: string): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

export type FilterOperator =
  // text
  | "contains"
  | "not_contains"
  | "is"
  | "is_not"
  | "is_empty"
  | "is_not_empty"
  // enum
  | "is_one_of"
  | "is_none_of"
  // date
  | "on"
  | "before"
  | "after"
  | "between"
  // number
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "between_num"
  // boolean
  | "is_true"
  | "is_false"
  // multiselect
  | "contains_any"
  | "contains_all";

export interface FilterRule {
  /** Stable id used by React keys / localStorage. */
  id: string;
  field: RecordFieldKey;
  operator: FilterOperator;
  /** Operand for single-valued operators. */
  value?: string;
  /** Second operand (e.g. between's upper bound). */
  value2?: string;
  /** Operand list for "is_one_of" / "contains_any" etc. */
  values?: string[];
}

export interface OperatorDef {
  op: FilterOperator;
  label: string;
  /** How many input fields the operator surface needs. 0 = no operand. */
  arity: 0 | 1 | 2 | "many";
}

const TEXT_OPS: OperatorDef[] = [
  { op: "contains", label: "contains", arity: 1 },
  { op: "not_contains", label: "does not contain", arity: 1 },
  { op: "is", label: "is", arity: 1 },
  { op: "is_not", label: "is not", arity: 1 },
  { op: "is_empty", label: "is empty", arity: 0 },
  { op: "is_not_empty", label: "is not empty", arity: 0 },
];

const ENUM_OPS: OperatorDef[] = [
  { op: "is_one_of", label: "is one of", arity: "many" },
  { op: "is_none_of", label: "is none of", arity: "many" },
  { op: "is_empty", label: "is empty", arity: 0 },
  { op: "is_not_empty", label: "is not empty", arity: 0 },
];

const DATE_OPS: OperatorDef[] = [
  { op: "on", label: "on", arity: 1 },
  { op: "before", label: "before", arity: 1 },
  { op: "after", label: "after", arity: 1 },
  { op: "between", label: "between", arity: 2 },
  { op: "is_empty", label: "is empty", arity: 0 },
  { op: "is_not_empty", label: "is not empty", arity: 0 },
];

const NUMBER_OPS: OperatorDef[] = [
  { op: "eq", label: "=", arity: 1 },
  { op: "neq", label: "≠", arity: 1 },
  { op: "gt", label: ">", arity: 1 },
  { op: "lt", label: "<", arity: 1 },
  { op: "between_num", label: "between", arity: 2 },
  { op: "is_empty", label: "is empty", arity: 0 },
  { op: "is_not_empty", label: "is not empty", arity: 0 },
];

const BOOLEAN_OPS: OperatorDef[] = [
  { op: "is_true", label: "is true", arity: 0 },
  { op: "is_false", label: "is false", arity: 0 },
];

const MULTISELECT_OPS: OperatorDef[] = [
  { op: "contains_any", label: "contains any of", arity: "many" },
  { op: "contains_all", label: "contains all of", arity: "many" },
  { op: "is_empty", label: "is empty", arity: 0 },
  { op: "is_not_empty", label: "is not empty", arity: 0 },
];

const OPS_BY_TYPE: Record<FieldType, OperatorDef[]> = {
  text: TEXT_OPS,
  enum: ENUM_OPS,
  date: DATE_OPS,
  number: NUMBER_OPS,
  boolean: BOOLEAN_OPS,
  multiselect: MULTISELECT_OPS,
};

export function operatorsForType(type: FieldType): OperatorDef[] {
  return OPS_BY_TYPE[type];
}

export function defaultOperatorForType(type: FieldType): FilterOperator {
  return OPS_BY_TYPE[type][0].op;
}

/**
 * Test whether a record matches a single filter rule. Returns true when the
 * rule cannot be evaluated (unknown field, malformed operator) so a broken
 * rule never silently hides records — the UI should validate rules at edit
 * time instead.
 */
export function evaluateRule(record: AcatRecord, rule: FilterRule): boolean {
  const field = RECORD_FIELDS_BY_KEY.get(rule.field);
  if (!field) return true;
  if (field.filterable === false) return true;

  const raw = field.value(record);

  // Empty / non-empty short-circuit (works for every type).
  if (rule.operator === "is_empty") return isEmpty(raw);
  if (rule.operator === "is_not_empty") return !isEmpty(raw);

  switch (field.type) {
    case "text":
      return evalText(String(raw ?? ""), rule);
    case "enum":
      return evalEnum(String(raw ?? ""), rule);
    case "multiselect":
      return evalMultiselect(parseMultiselectValue(String(raw ?? "")), rule);
    case "date":
      return evalDate(String(raw ?? ""), rule);
    case "number":
      return evalNumber(typeof raw === "number" ? raw : null, rule);
    case "boolean":
      return evalBoolean(Boolean(raw), rule);
    default:
      return true;
  }
}

export function applyFilters(
  records: AcatRecord[],
  rules: FilterRule[]
): AcatRecord[] {
  if (rules.length === 0) return records;
  return records.filter((r) => rules.every((rule) => evaluateRule(r, rule)));
}

function isEmpty(v: string | number | boolean | null): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return Number.isNaN(v);
  return false;
}

function evalText(value: string, rule: FilterRule): boolean {
  const v = value.toLowerCase();
  const target = (rule.value ?? "").toLowerCase();
  switch (rule.operator) {
    case "contains":
      return v.includes(target);
    case "not_contains":
      return !v.includes(target);
    case "is":
      return v === target;
    case "is_not":
      return v !== target;
    default:
      return true;
  }
}

function evalEnum(value: string, rule: FilterRule): boolean {
  const set = new Set((rule.values ?? []).map((s) => s.toLowerCase()));
  const v = value.toLowerCase();
  switch (rule.operator) {
    case "is_one_of":
      return set.size === 0 ? true : set.has(v);
    case "is_none_of":
      return set.size === 0 ? true : !set.has(v);
    default:
      return true;
  }
}

function evalMultiselect(values: string[], rule: FilterRule): boolean {
  const haystack = new Set(values.map((v) => v.toLowerCase()));
  const needles = (rule.values ?? []).map((v) => v.toLowerCase());
  switch (rule.operator) {
    case "contains_any":
      if (needles.length === 0) return true;
      return needles.some((n) => haystack.has(n));
    case "contains_all":
      if (needles.length === 0) return true;
      return needles.every((n) => haystack.has(n));
    default:
      return true;
  }
}

function evalDate(value: string, rule: FilterRule): boolean {
  if (!value) return false;
  const v = parseDate(value);
  if (v == null) return false;
  switch (rule.operator) {
    case "on": {
      const target = parseDate(rule.value ?? "");
      return target != null && v === target;
    }
    case "before": {
      const target = parseDate(rule.value ?? "");
      return target != null && v < target;
    }
    case "after": {
      const target = parseDate(rule.value ?? "");
      return target != null && v > target;
    }
    case "between": {
      const a = parseDate(rule.value ?? "");
      const b = parseDate(rule.value2 ?? "");
      if (a == null || b == null) return false;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return v >= lo && v <= hi;
    }
    default:
      return true;
  }
}

function evalNumber(value: number | null, rule: FilterRule): boolean {
  if (value == null) return false;
  const n1 = parseNumber(rule.value);
  const n2 = parseNumber(rule.value2);
  switch (rule.operator) {
    case "eq":
      return n1 != null && value === n1;
    case "neq":
      return n1 != null && value !== n1;
    case "gt":
      return n1 != null && value > n1;
    case "lt":
      return n1 != null && value < n1;
    case "between_num": {
      if (n1 == null || n2 == null) return false;
      const [lo, hi] = n1 <= n2 ? [n1, n2] : [n2, n1];
      return value >= lo && value <= hi;
    }
    default:
      return true;
  }
}

function evalBoolean(value: boolean, rule: FilterRule): boolean {
  switch (rule.operator) {
    case "is_true":
      return value === true;
    case "is_false":
      return value === false;
    default:
      return true;
  }
}

/** Parse a date-string into a comparable epoch (UTC midnight). */
function parseDate(s: string): number | null {
  if (!s) return null;
  // Handle YYYY-MM-DD by anchoring to UTC; full ISO strings parse natively.
  const m = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? Date.UTC(
        Number(s.slice(0, 4)),
        Number(s.slice(5, 7)) - 1,
        Number(s.slice(8, 10))
      )
    : Date.parse(s);
  return Number.isFinite(m) ? m : null;
}

function parseNumber(s: string | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function generateRuleId(): string {
  return `rule_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}
