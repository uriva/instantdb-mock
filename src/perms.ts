// deno-lint-ignore-file no-explicit-any
import {
  type BindInput,
  type CelContext,
  evaluateCelRule,
  normalizeBindPairs,
  type RefResolver,
} from "./cel.ts";

export class InstantPermissionError extends Error {
  readonly entity: string;
  readonly action: string;
  constructor(entity: string, action: string, detail?: string) {
    super(
      detail
        ? `Permission denied on ${entity}.${action}: ${detail}`
        : `Permission denied on ${entity}.${action}`,
    );
    this.name = "InstantPermissionError";
    this.entity = entity;
    this.action = action;
  }
}

export type RulesLike = Record<
  string,
  {
    bind?: BindInput;
    allow?: Record<string, any>;
    fields?: Record<string, string | boolean>;
  }
>;

const SYSTEM_ENTITIES = new Set(["$users", "$files", "$streams"]);
const SYSTEM_USER_FIELDS = new Set(["id", "email", "type", "imageURL"]);

const coerceRuleExpr = (val: unknown): string | null => {
  if (typeof val === "boolean") return String(val);
  if (typeof val === "string") return val;
  return null;
};

export const collectBinds = (
  rules: RulesLike,
  entity: string,
): Array<[string, string]> => [
  ...normalizeBindPairs(rules.$default?.bind),
  ...(entity === "$default" ? [] : normalizeBindPairs(rules[entity]?.bind)),
];

const systemFallbackExpr = (entity: string, action: string): string | null => {
  if (!SYSTEM_ENTITIES.has(entity)) return null;
  if (entity === "$users" && action === "create") return "true";
  if (entity === "$users" && (action === "view" || action === "update")) {
    return "auth.id == data.id || (data.linkedPrimaryUser != null && auth.id == data.linkedPrimaryUser)";
  }
  return "false";
};

export const resolveActionRuleExpr = (
  rules: RulesLike,
  entity: string,
  action: "view" | "create" | "update" | "delete",
): string => {
  const candidates = [
    coerceRuleExpr(rules[entity]?.allow?.[action]),
    coerceRuleExpr(rules[entity]?.allow?.$default),
    coerceRuleExpr(rules.$default?.allow?.[action]),
    coerceRuleExpr(rules.$default?.allow?.$default),
    systemFallbackExpr(entity, action),
  ];
  for (const c of candidates) {
    if (c !== null) return c;
  }
  return "true";
};

export const resolveLinkRuleExpr = (
  rules: RulesLike,
  entity: string,
  kind: "link" | "unlink",
  label: string,
): string => {
  const linkMap = rules[entity]?.allow?.[kind];
  const candidates = [
    typeof linkMap === "object" && linkMap !== null
      ? coerceRuleExpr(linkMap[label]) ?? coerceRuleExpr(linkMap.$default)
      : coerceRuleExpr(linkMap),
    resolveActionRuleExpr(rules, entity, "update"),
  ];
  for (const c of candidates) {
    if (c !== null) return c;
  }
  return "true";
};

export type SignUpCheckInput = {
  email?: string | null;
  id?: string;
  extraFields?: Record<string, unknown>;
  schema?: { entities?: Record<string, any> };
  resolveRef?: RefResolver;
};

const validateSignupExtraFields = (
  extraFields: Record<string, unknown> | undefined,
  schema?: { entities?: Record<string, any> },
) => {
  if (!extraFields) return;
  const userAttrs = schema?.entities?.$users?.attrs as
    | Record<string, unknown>
    | undefined;
  for (const key of Object.keys(extraFields)) {
    if (SYSTEM_USER_FIELDS.has(key)) {
      throw new InstantPermissionError(
        "$users",
        "create",
        `Cannot set system field: ${key}`,
      );
    }
    if (userAttrs && !(key in userAttrs)) {
      throw new InstantPermissionError(
        "$users",
        "create",
        `Unknown field: ${key}. It must be defined in your $users schema.`,
      );
    }
  }
};

// Mirrors `instant/server/src/instant/model/app_user.clj` (`assert-signup!`).
export const evaluateSignupPermission = (
  rules: RulesLike,
  input: SignUpCheckInput,
): boolean => {
  validateSignupExtraFields(input.extraFields, input.schema);
  const id = input.id ?? crypto.randomUUID();
  const userData: Record<string, unknown> = {
    id,
    ...(input.email ? { email: input.email } : {}),
    ...(input.extraFields ?? {}),
  };
  const hasExtraFields = Boolean(
    input.extraFields && Object.keys(input.extraFields).length > 0,
  );
  const explicitCreateRule = coerceRuleExpr(rules.$users?.allow?.create);
  if (explicitCreateRule === null) {
    return !hasExtraFields;
  }
  const ctx: CelContext = {
    auth: userData,
    data: userData,
    newData: userData,
    request: { modifiedFields: [] },
    entityType: "$users",
    resolveRef: input.resolveRef,
  };
  return evaluateCelRule(
    explicitCreateRule,
    ctx,
    collectBinds(rules, "$users"),
  );
};

export const canSignUpWithEmail = (
  rules: RulesLike,
  opts: {
    email: string;
    id?: string;
    extraFields?: Record<string, unknown>;
    schema?: { entities?: Record<string, any> };
  },
): boolean => {
  try {
    return evaluateSignupPermission(rules, opts);
  } catch (err) {
    if (err instanceof InstantPermissionError) return false;
    throw err;
  }
};

export const canSignUpAsGuest = (
  rules: RulesLike,
  opts: {
    id?: string;
    extraFields?: Record<string, unknown>;
    schema?: { entities?: Record<string, any> };
  } = {},
): boolean => {
  try {
    return evaluateSignupPermission(rules, { ...opts, email: null });
  } catch (err) {
    if (err instanceof InstantPermissionError) return false;
    throw err;
  }
};

export const validateNonSystemUserUpdate = (
  entity: string,
  patch: Record<string, unknown>,
) => {
  if (entity !== "$users") return;
  for (const key of Object.keys(patch)) {
    if (SYSTEM_USER_FIELDS.has(key)) {
      throw new InstantPermissionError(
        "$users",
        "update",
        `Cannot modify system attribute '${key}' on $users via transact`,
      );
    }
  }
};

export const validateAttrsPermission = (
  rules: RulesLike,
  schema: { entities?: Record<string, any> },
  entity: string,
  patch: Record<string, unknown>,
  auth: Record<string, unknown> | null,
) => {
  const entityDef = schema.entities?.[entity];
  const declaredAttrs = entityDef?.attrs as Record<string, unknown> | undefined;
  const attrsCreateExpr = coerceRuleExpr(rules.attrs?.allow?.create) ??
    coerceRuleExpr(rules.attrs?.allow?.$default) ??
    coerceRuleExpr(rules.$default?.allow?.create) ??
    coerceRuleExpr(rules.$default?.allow?.$default);
  if (!attrsCreateExpr) return;

  const hasNewAttr = !entityDef ||
    (declaredAttrs
      ? Object.keys(patch).some((k) => k !== "id" && !(k in declaredAttrs))
      : false);
  if (!hasNewAttr) return;

  const allowed = evaluateCelRule(
    attrsCreateExpr,
    { auth, entityType: "attrs" },
    collectBinds(rules, "attrs"),
  );
  if (!allowed) {
    throw new InstantPermissionError(
      "attrs",
      "create",
      `Disallowed undeclared attribute on ${entity}`,
    );
  }
};

export const filterRecordFields = (
  rules: RulesLike,
  entity: string,
  record: Record<string, unknown>,
  ctxBase: Omit<CelContext, "data" | "newData" | "entityType">,
): Record<string, unknown> => {
  const fieldRules = rules[entity]?.fields;
  if (!fieldRules) return { ...record };
  const binds = collectBinds(rules, entity);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === "id" || !(k in fieldRules)) {
      out[k] = v;
      continue;
    }
    const expr = coerceRuleExpr(fieldRules[k]);
    if (expr === null) {
      out[k] = v;
      continue;
    }
    const ok = evaluateCelRule(
      expr,
      { ...ctxBase, data: record, newData: record, entityType: entity },
      binds,
    );
    if (ok) out[k] = v;
  }
  return out;
};
