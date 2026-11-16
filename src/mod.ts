// deno-lint-ignore-file no-explicit-any
// In-memory mock of InstantDB's admin and permissioned client surfaces,
// driven by `instant.schema.ts` and `instant.perms.ts`.

import type { InstantAdminDatabase } from "@instantdb/admin";
import type { InstantSchemaDef } from "@instantdb/core";
import { evaluateCelRule, type RefResolver } from "./cel.ts";
import {
  canSignUpAsGuest,
  canSignUpWithEmail,
  collectBinds,
  evaluateSignupPermission,
  filterRecordFields,
  InstantPermissionError,
  resolveActionRuleExpr,
  resolveLinkRuleExpr,
  type RulesLike,
  validateAttrsPermission,
  validateNonSystemUserUpdate,
  validateRules,
} from "./perms.ts";

export {
  canSignUpAsGuest,
  canSignUpWithEmail,
  evaluateSignupPermission,
  InstantPermissionError,
  type RulesLike,
};

const LOOKUP_PREFIX = "__instant_lookup__:";

export const lookup = (attribute: string, value: unknown): string =>
  `${LOOKUP_PREFIX}${JSON.stringify([attribute, value])}`;

const parseLookupRef = (
  idOrLookup: string,
): { attr: string; value: unknown } | null => {
  if (!idOrLookup.startsWith(LOOKUP_PREFIX)) return null;
  const [attr, value] = JSON.parse(idOrLookup.slice(LOOKUP_PREFIX.length));
  return { attr: String(attr), value };
};

const deepMerge = (target: any, source: any): any => {
  if (
    target && source && typeof target === "object" && typeof source === "object"
  ) {
    const out: any = Array.isArray(target) ? [...target] : { ...target };
    for (const [k, v] of Object.entries(source)) {
      out[k] = (k in target) ? deepMerge(target[k], v) : v;
    }
    return out;
  }
  return source;
};

type LinkDef = {
  forward: { on: string; has: "one" | "many"; label: string };
  reverse: { on: string; has: "one" | "many"; label: string };
};

type SchemaLike = {
  entities: Record<string, any>;
  links: Record<string, LinkDef>;
};

type LinkInfo = {
  targetEntity: string;
  reverseLabel: string;
  direction: "forward" | "reverse";
  has: "one" | "many";
};

const resolveLinkInfo = (
  schema: SchemaLike,
  sourceEntity: string,
  label: string,
): LinkInfo | null => {
  for (const link of Object.values(schema.links ?? {})) {
    if (link.forward.on === sourceEntity && link.forward.label === label) {
      return {
        targetEntity: link.reverse.on,
        reverseLabel: link.reverse.label,
        direction: "forward",
        has: link.forward.has,
      };
    }
    if (link.reverse.on === sourceEntity && link.reverse.label === label) {
      return {
        targetEntity: link.forward.on,
        reverseLabel: link.forward.label,
        direction: "reverse",
        has: link.reverse.has,
      };
    }
  }
  return null;
};

type CanonicalLink = {
  forwardEntity: string;
  forwardId: string;
  reverseEntity: string;
  reverseId: string;
};

const toCanonicalEndpoints = (
  linkInfo: LinkInfo,
  sourceEntity: string,
  sourceId: string,
  targetId: string,
): CanonicalLink => {
  const forwardEntity = linkInfo.direction === "forward"
    ? sourceEntity
    : linkInfo.targetEntity;
  const forwardId = linkInfo.direction === "forward" ? sourceId : targetId;
  const reverseEntity = linkInfo.direction === "reverse"
    ? sourceEntity
    : linkInfo.targetEntity;
  const reverseId = linkInfo.direction === "reverse" ? sourceId : targetId;
  return { forwardEntity, forwardId, reverseEntity, reverseId };
};

const sameLink = (a: CanonicalLink, b: CanonicalLink) =>
  a.forwardEntity === b.forwardEntity &&
  a.forwardId === b.forwardId &&
  a.reverseEntity === b.reverseEntity &&
  a.reverseId === b.reverseId;

const createTxNode = (entity: string, id: string, ruleParamsObj?: any) => {
  const opsList = [] as any[];
  let activeRuleParams = ruleParamsObj;
  const node = {
    ruleParams: (params: Record<string, unknown>) => {
      activeRuleParams = { ...(activeRuleParams ?? {}), ...params };
      opsList.forEach((op) => {
        op.ruleParams = activeRuleParams;
      });
      return node;
    },
    update: (data: any) => {
      opsList.push({
        type: "update",
        entity,
        id,
        data,
        ruleParams: activeRuleParams,
      });
      return node;
    },
    create: (data: any) => {
      opsList.push({
        type: "update",
        entity,
        id,
        data,
        explicitCreate: true,
        ruleParams: activeRuleParams,
      });
      return node;
    },
    merge: (data: any) => {
      opsList.push({
        type: "merge",
        entity,
        id,
        data,
        ruleParams: activeRuleParams,
      });
      return node;
    },
    link: (linksObj: any) => {
      opsList.push({
        type: "link",
        entity,
        id,
        linksObj,
        ruleParams: activeRuleParams,
      });
      return node;
    },
    unlink: (unlinksObj: any) => {
      opsList.push({
        type: "unlink",
        entity,
        id,
        unlinksObj,
        ruleParams: activeRuleParams,
      });
      return node;
    },
    delete: () => {
      opsList.push({
        type: "delete",
        entity,
        id,
        ruleParams: activeRuleParams,
      });
      return node;
    },
    _ops: opsList,
  };
  return node;
};

const buildTxProxy = () =>
  new Proxy({}, {
    get: (_target, entity: string) =>
      new Proxy({}, {
        get: (_etarget, id: string) => createTxNode(entity, id),
      }),
  });

export type MockAuthUser = {
  id: string;
  email?: string | null;
  type?: string;
  [extra: string]: unknown;
};

export type PermissionedClient<Schema extends InstantSchemaDef<any, any, any>> =
  {
    tx: InstantAdminDatabase<Schema>["tx"];
    lookup: typeof lookup;
    transact: (opsArg: any) => Promise<void>;
    query: InstantAdminDatabase<Schema>["query"];
  };

export type PermissionedMockDb<Schema extends InstantSchemaDef<any, any, any>> =
  {
    admin: InstantAdminDatabase<Schema>;
    lookup: typeof lookup;
    signUpWithEmail: (opts: {
      email: string;
      id?: string;
      extraFields?: Record<string, unknown>;
    }) => Promise<{ user: MockAuthUser; created: boolean }>;
    signUpAsGuest: (opts?: {
      id?: string;
      extraFields?: Record<string, unknown>;
    }) => Promise<{ user: MockAuthUser; created: boolean }>;
    asUser: (authUser: MockAuthUser | null) => PermissionedClient<Schema>;
  };

const createInternalStore = <Schema extends InstantSchemaDef<any, any, any>>(
  schema: Schema,
) => {
  const schemaLike = schema as unknown as SchemaLike;
  const store: Record<string, Map<string, any>> = {};
  for (const entityName of Object.keys(schemaLike.entities ?? {})) {
    store[entityName] = new Map();
  }
  if (!store.$users) store.$users = new Map();

  let links: CanonicalLink[] = [];

  const ensureEntityMap = (entity: string): Map<string, any> => {
    if (!store[entity]) store[entity] = new Map();
    return store[entity];
  };

  const snapshotState = () => ({
    storeSnap: Object.fromEntries(
      Object.entries(store).map(([k, m]) => [
        k,
        new Map(
          Array.from(m.entries()).map(([id, rec]) => [
            id,
            structuredClone(rec),
          ]),
        ),
      ]),
    ),
    linksSnap: links.map((l) => ({ ...l })),
  });

  const restoreState = (
    snap: ReturnType<typeof snapshotState>,
  ) => {
    for (const k of Object.keys(store)) {
      if (!(k in snap.storeSnap)) delete store[k];
    }
    for (const [k, m] of Object.entries(snap.storeSnap)) {
      store[k] = m;
    }
    links = snap.linksSnap;
  };

  const resolveEntityTargetId = (
    entity: string,
    rawId: string,
    lookupMemo: Map<string, { id: string; seedData?: Record<string, unknown> }>,
    allowCreateOnMiss: boolean,
  ): { id: string; seedData?: Record<string, unknown> } => {
    const parsed = parseLookupRef(rawId);
    if (!parsed) return { id: rawId };
    const memoKey = `${entity}:${rawId}`;
    const memo = lookupMemo.get(memoKey);
    if (memo) return memo;
    const entityMap = store[entity];
    if (entityMap) {
      for (const existing of entityMap.values()) {
        if (existing[parsed.attr] === parsed.value) {
          const found = { id: String(existing.id) };
          lookupMemo.set(memoKey, found);
          return found;
        }
      }
    }
    if (!allowCreateOnMiss) {
      throw new InstantPermissionError(
        entity,
        "lookup",
        `Could not find entity for lookup(${parsed.attr})`,
      );
    }
    const created = {
      id: crypto.randomUUID(),
      seedData: { [parsed.attr]: parsed.value },
    };
    lookupMemo.set(memoKey, created);
    return created;
  };

  const getLinkedIds = (
    sourceEntity: string,
    sourceId: string,
    label: string,
  ): string[] => {
    const info = resolveLinkInfo(schemaLike, sourceEntity, label);
    if (!info) return [];
    if (info.direction === "forward") {
      return links
        .filter(
          (l) =>
            l.forwardEntity === sourceEntity &&
            l.forwardId === sourceId &&
            l.reverseEntity === info.targetEntity,
        )
        .map((l) => l.reverseId);
    }
    return links
      .filter(
        (l) =>
          l.reverseEntity === sourceEntity &&
          l.reverseId === sourceId &&
          l.forwardEntity === info.targetEntity,
      )
      .map((l) => l.forwardId);
  };

  const resolveRef: RefResolver = (
    entityType: string,
    entityId: string | null,
    path: string,
  ): unknown[] => {
    if (!entityType || !entityId || !path) return [];
    const parts = path.split(".");
    if (parts.length < 2 && entityType !== "$users") return [];
    const attr = parts[parts.length - 1];
    const linkLabels = parts.slice(0, -1);

    let currentEntity = entityType;
    let currentIds = [entityId];
    for (const label of linkLabels) {
      const info = resolveLinkInfo(schemaLike, currentEntity, label);
      if (!info) return [];
      const nextIds = new Set<string>();
      for (const cid of currentIds) {
        for (const tid of getLinkedIds(currentEntity, cid, label)) {
          nextIds.add(tid);
        }
      }
      currentEntity = info.targetEntity;
      currentIds = Array.from(nextIds);
      if (currentIds.length === 0) return [];
    }

    const targetMap = store[currentEntity];
    if (!targetMap) return [];
    const out: unknown[] = [];
    for (const tid of currentIds) {
      const rec = targetMap.get(tid);
      if (rec && rec[attr] !== undefined && rec[attr] !== null) {
        out.push(rec[attr]);
      }
    }
    return out;
  };

  const applyOpsUnchecked = (opsArg: any) => {
    const ops = Array.isArray(opsArg) ? opsArg : [opsArg];
    const flatOps = ops.flatMap((item) =>
      item && typeof item === "object" && "_ops" in item ? item._ops : [item]
    );
    const lookupMemo = new Map<
      string,
      { id: string; seedData?: Record<string, unknown> }
    >();

    flatOps.forEach((op) => {
      const { id, seedData } = resolveEntityTargetId(
        op.entity,
        op.id,
        lookupMemo,
        true,
      );
      const entityMap = store[op.entity];
      if (!entityMap) return;

      if (op.type === "update") {
        const existing = entityMap.get(id) ?? {};
        entityMap.set(id, {
          ...existing,
          ...(seedData ?? {}),
          id,
          ...op.data,
        });
      } else if (op.type === "merge") {
        const existing = entityMap.get(id) ?? {};
        entityMap.set(
          id,
          deepMerge({ ...existing, ...(seedData ?? {}), id }, op.data),
        );
      } else if (op.type === "delete") {
        entityMap.delete(id);
        links = links.filter(
          (l) =>
            !(l.forwardEntity === op.entity && l.forwardId === id) &&
            !(l.reverseEntity === op.entity && l.reverseId === id),
        );
      } else if (op.type === "link") {
        Object.entries(op.linksObj).forEach(([label, targetRaw]) => {
          if (!targetRaw) return;
          const info = resolveLinkInfo(schemaLike, op.entity, label);
          if (!info) return;
          const rawList = Array.isArray(targetRaw) ? targetRaw : [targetRaw];
          for (const rawTid of rawList) {
            const { id: tid } = resolveEntityTargetId(
              info.targetEntity,
              String(rawTid),
              lookupMemo,
              false,
            );
            const canonical = toCanonicalEndpoints(
              info,
              op.entity,
              id,
              tid,
            );
            if (!links.some((l) => sameLink(l, canonical))) {
              links.push(canonical);
            }
          }
        });
      } else if (op.type === "unlink") {
        Object.entries(op.unlinksObj).forEach(([label, targetRaw]) => {
          if (!targetRaw) return;
          const info = resolveLinkInfo(schemaLike, op.entity, label);
          if (!info) return;
          const rawList = Array.isArray(targetRaw) ? targetRaw : [targetRaw];
          for (const rawTid of rawList) {
            const { id: tid } = resolveEntityTargetId(
              info.targetEntity,
              String(rawTid),
              lookupMemo,
              false,
            );
            const canonical = toCanonicalEndpoints(
              info,
              op.entity,
              id,
              tid,
            );
            links = links.filter((l) => !sameLink(l, canonical));
          }
        });
      }
    });
  };

  const applyOpsChecked = (
    opsArg: any,
    rules: RulesLike,
    authUser: MockAuthUser | null,
  ) => {
    const snap = snapshotState();
    try {
      const ops = Array.isArray(opsArg) ? opsArg : [opsArg];
      const flatOps = ops.flatMap((item) =>
        item && typeof item === "object" && "_ops" in item ? item._ops : [item]
      );
      const lookupMemo = new Map<
        string,
        { id: string; seedData?: Record<string, unknown> }
      >();

      type EntityChange = {
        entity: string;
        id: string;
        isCreate: boolean;
        before: Record<string, unknown> | null;
        modifiedFields: Set<string>;
        ruleParams?: Record<string, unknown>;
      };
      type LinkCheck = {
        kind: "link" | "unlink";
        sourceEntity: string;
        sourceId: string;
        label: string;
        targetEntity: string;
        targetId: string;
        sourceBefore: Record<string, unknown> | null;
        targetBefore: Record<string, unknown> | null;
        ruleParams?: Record<string, unknown>;
      };

      const entityChanges = new Map<string, EntityChange>();
      const deleteChecks: Array<{
        entity: string;
        before: Record<string, unknown>;
        ruleParams?: Record<string, unknown>;
      }> = [];
      const linkChecks: LinkCheck[] = [];

      for (const op of flatOps) {
        const isWrite = op.type === "update" || op.type === "merge";
        const { id, seedData } = resolveEntityTargetId(
          op.entity,
          op.id,
          lookupMemo,
          isWrite,
        );
        const entityMap = ensureEntityMap(op.entity);

        if (isWrite) {
          const patch: Record<string, unknown> = {
            ...(seedData ?? {}),
            ...(op.data ?? {}),
          };
          validateAttrsPermission(
            rules,
            schemaLike,
            op.entity,
            patch,
            authUser,
          );
          const existing = entityMap.get(id);
          const isCreate = !existing;
          if (isCreate && op.entity === "$users") {
            throw new InstantPermissionError(
              "$users",
              "create",
              "$users is a system entity. You aren't allowed to create this directly.",
            );
          }
          if (!isCreate) {
            validateNonSystemUserUpdate(op.entity, patch);
          }

          const changeKey = `${op.entity}:${id}`;
          let entry = entityChanges.get(changeKey);
          if (!entry) {
            entry = {
              entity: op.entity,
              id,
              isCreate,
              before: existing ? structuredClone(existing) : null,
              modifiedFields: new Set<string>(),
              ruleParams: op.ruleParams,
            };
            entityChanges.set(changeKey, entry);
          }
          for (const k of Object.keys(patch)) {
            if (k !== "id") entry.modifiedFields.add(k);
          }

          if (op.type === "update") {
            entityMap.set(id, { ...(existing ?? {}), id, ...patch });
          } else {
            entityMap.set(id, deepMerge({ ...(existing ?? {}), id }, patch));
          }
        } else if (op.type === "delete") {
          const existing = entityMap.get(id);
          if (existing) {
            if (op.entity === "$users") {
              throw new InstantPermissionError(
                "$users",
                "delete",
                "$users cannot be deleted via client transact.",
              );
            }
            deleteChecks.push({
              entity: op.entity,
              before: structuredClone(existing),
              ruleParams: op.ruleParams,
            });
            entityMap.delete(id);
            links = links.filter(
              (l) =>
                !(l.forwardEntity === op.entity && l.forwardId === id) &&
                !(l.reverseEntity === op.entity && l.reverseId === id),
            );
          }
        } else if (op.type === "link" || op.type === "unlink") {
          const mapObj = op.type === "link" ? op.linksObj : op.unlinksObj;
          for (const [label, targetRaw] of Object.entries(mapObj ?? {})) {
            if (!targetRaw) continue;
            const info = resolveLinkInfo(schemaLike, op.entity, label);
            if (!info) continue;
            const rawList = Array.isArray(targetRaw) ? targetRaw : [targetRaw];
            for (const rawTid of rawList) {
              const { id: tid } = resolveEntityTargetId(
                info.targetEntity,
                String(rawTid),
                lookupMemo,
                false,
              );
              const sourceBefore = entityMap.get(id)
                ? structuredClone(entityMap.get(id))
                : null;
              const targetMap = ensureEntityMap(info.targetEntity);
              const targetBefore = targetMap.get(tid)
                ? structuredClone(targetMap.get(tid))
                : null;
              linkChecks.push({
                kind: op.type,
                sourceEntity: op.entity,
                sourceId: id,
                label,
                targetEntity: info.targetEntity,
                targetId: tid,
                sourceBefore,
                targetBefore,
                ruleParams: op.ruleParams,
              });
              const canonical = toCanonicalEndpoints(
                info,
                op.entity,
                id,
                tid,
              );
              if (op.type === "link") {
                if (!links.some((l) => sameLink(l, canonical))) {
                  links.push(canonical);
                }
              } else {
                links = links.filter((l) => !sameLink(l, canonical));
              }
            }
          }
        }
      }

      // Evaluate delete checks
      for (const del of deleteChecks) {
        const expr = resolveActionRuleExpr(rules, del.entity, "delete");
        const ok = evaluateCelRule(
          expr,
          {
            auth: authUser,
            data: del.before,
            newData: del.before,
            ruleParams: del.ruleParams,
            entityType: del.entity,
            resolveRef,
          },
          collectBinds(rules, del.entity),
        );
        if (!ok) throw new InstantPermissionError(del.entity, "delete");
      }

      // Evaluate create / update checks against staged state + links
      for (const change of entityChanges.values()) {
        const after = store[change.entity]?.get(change.id);
        if (!after) continue;
        const action = change.isCreate ? "create" : "update";
        const expr = resolveActionRuleExpr(rules, change.entity, action);
        const dataObj = change.isCreate ? after : (change.before ?? after);
        const ok = evaluateCelRule(
          expr,
          {
            auth: authUser,
            data: dataObj,
            newData: after,
            request: { modifiedFields: Array.from(change.modifiedFields) },
            ruleParams: change.ruleParams,
            entityType: change.entity,
            resolveRef,
          },
          collectBinds(rules, change.entity),
        );
        if (!ok) throw new InstantPermissionError(change.entity, action);
      }

      // Evaluate link / unlink checks
      for (const lc of linkChecks) {
        const sourceAfter = store[lc.sourceEntity]?.get(lc.sourceId) ??
          lc.sourceBefore;
        const targetAfter = store[lc.targetEntity]?.get(lc.targetId) ??
          lc.targetBefore;
        const expr = resolveLinkRuleExpr(
          rules,
          lc.sourceEntity,
          lc.kind,
          lc.label,
        );
        const ok = evaluateCelRule(
          expr,
          {
            auth: authUser,
            data: lc.sourceBefore ?? sourceAfter,
            newData: sourceAfter,
            linkedData: targetAfter,
            linkedEntityType: lc.targetEntity,
            ruleParams: lc.ruleParams,
            entityType: lc.sourceEntity,
            resolveRef,
          },
          collectBinds(rules, lc.sourceEntity),
        );
        if (!ok) {
          throw new InstantPermissionError(
            lc.sourceEntity,
            `${lc.kind}.${lc.label}`,
          );
        }
      }
    } catch (err) {
      restoreState(snap);
      throw err;
    }
  };

  const matchValue = (val: any, filterVal: any): boolean => {
    if (
      filterVal && typeof filterVal === "object" && !Array.isArray(filterVal)
    ) {
      if ("$lt" in filterVal) return val < filterVal.$lt;
      if ("$lte" in filterVal) return val <= filterVal.$lte;
      if ("$gt" in filterVal) return val > filterVal.$gt;
      if ("$gte" in filterVal) return val >= filterVal.$gte;
      if ("$ne" in filterVal) return val !== filterVal.$ne;
      if ("$in" in filterVal) {
        return Array.isArray(filterVal.$in) && filterVal.$in.includes(val);
      }
      if ("$isNull" in filterVal) {
        return filterVal.$isNull
          ? (val === null || val === undefined)
          : (val !== null && val !== undefined);
      }
      if ("$like" in filterVal && typeof val === "string") {
        const re = new RegExp(
          "^" +
            String(filterVal.$like)
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              .replace(/%/g, ".*")
              .replace(/_/g, ".") +
            "$",
        );
        return re.test(val);
      }
      if ("$ilike" in filterVal && typeof val === "string") {
        const re = new RegExp(
          "^" +
            String(filterVal.$ilike)
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              .replace(/%/g, ".*")
              .replace(/_/g, ".") +
            "$",
          "i",
        );
        return re.test(val);
      }
    }
    return val === filterVal;
  };

  const matchRecord = (record: any, entity: string, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, filterVal]) => {
      if (key === "and" && Array.isArray(filterVal)) {
        return filterVal.every((sub) => matchRecord(record, entity, sub));
      }
      if (key === "or" && Array.isArray(filterVal)) {
        return filterVal.some((sub) => matchRecord(record, entity, sub));
      }
      if (key.includes(".")) {
        const parts = key.split(".");
        const label = parts[0];
        const remainder = parts.slice(1).join(".");
        const info = resolveLinkInfo(schemaLike, entity, label);
        if (!info) return false;
        const linkedIds = getLinkedIds(entity, record.id, label);
        if (linkedIds.length === 0) return false;
        const targetMap = store[info.targetEntity];
        if (!targetMap) return false;
        return linkedIds.some((tid) => {
          const target = targetMap.get(tid);
          if (!target) return false;
          if (remainder.includes(".")) {
            return matchRecord(target, info.targetEntity, {
              [remainder]: filterVal,
            });
          }
          return matchValue(target[remainder], filterVal);
        });
      }
      const linkInfo = resolveLinkInfo(schemaLike, entity, key);
      if (linkInfo) {
        const linkedIds = getLinkedIds(entity, record.id, key);
        return linkedIds.some((tid) => matchValue(tid, filterVal));
      }
      return matchValue(record[key], filterVal);
    });
  };

  const canViewRecord = (
    rules: RulesLike | null,
    authUser: MockAuthUser | null,
    entity: string,
    record: Record<string, unknown>,
    ruleParams?: Record<string, unknown>,
  ): boolean => {
    if (!rules) return true;
    const expr = resolveActionRuleExpr(rules, entity, "view");
    return evaluateCelRule(
      expr,
      {
        auth: authUser,
        data: record,
        newData: record,
        ruleParams,
        entityType: entity,
        resolveRef,
      },
      collectBinds(rules, entity),
    );
  };

  const resolveSubQuery = (
    parentEntity: string,
    parentId: string,
    label: string,
    subQuery: any,
    rules: RulesLike | null,
    authUser: MockAuthUser | null,
    ruleParams?: Record<string, unknown>,
  ): any => {
    const info = resolveLinkInfo(schemaLike, parentEntity, label);
    if (!info) return [];
    const linkedIds = getLinkedIds(parentEntity, parentId, label);
    const targetMap = store[info.targetEntity];
    if (!targetMap) return info.has === "one" ? null : [];

    const where = subQuery?.$?.where;
    const records = linkedIds
      .map((id) => targetMap.get(id))
      .filter(Boolean)
      .filter((r) => matchRecord(r, info.targetEntity, where))
      .filter((r) =>
        canViewRecord(rules, authUser, info.targetEntity, r, ruleParams)
      );

    const resolved = records.map((r) =>
      resolveRelationships(
        info.targetEntity,
        r,
        subQuery ?? {},
        rules,
        authUser,
        ruleParams,
      )
    );

    return info.has === "one" ? (resolved[0] ?? null) : resolved;
  };

  const resolveRelationships = (
    entity: string,
    record: any,
    queryObj: any,
    rules: RulesLike | null,
    authUser: MockAuthUser | null,
    ruleParams?: Record<string, unknown>,
  ) => {
    const baseRecord = rules
      ? filterRecordFields(rules, entity, record, {
        auth: authUser,
        ruleParams,
        resolveRef,
      })
      : { ...record };
    Object.entries(queryObj ?? {}).forEach(([key, subQuery]) => {
      if (key === "$") return;
      baseRecord[key] = resolveSubQuery(
        entity,
        record.id,
        key,
        subQuery,
        rules,
        authUser,
        ruleParams,
      );
    });
    return baseRecord;
  };

  const queryEntity = (
    entity: string,
    queryObj: any,
    rules: RulesLike | null,
    authUser: MockAuthUser | null,
    ruleParams?: Record<string, unknown>,
  ): any[] => {
    const entityMap = store[entity];
    if (!entityMap) return [];

    const records = Array.from(entityMap.values());
    const where = queryObj?.$?.where;
    const filtered = records
      .filter((r) => matchRecord(r, entity, where))
      .filter((r) => canViewRecord(rules, authUser, entity, r, ruleParams));

    const order = queryObj?.$?.order;
    const sorted = !order ? filtered : filtered.slice().sort((a, b) => {
      const [[key, dir]] = Object.entries(order) as any;
      const valA = a[key] ?? 0;
      const valB = b[key] ?? 0;
      return dir === "desc" ? valB - valA : valA - valB;
    });

    const limit = queryObj?.$?.limit;
    const sliced = limit !== undefined ? sorted.slice(0, limit) : sorted;

    return sliced.map((record) =>
      resolveRelationships(
        entity,
        record,
        queryObj,
        rules,
        authUser,
        ruleParams,
      )
    );
  };

  const runQuery = (
    queryObj: any,
    rules: RulesLike | null,
    authUser: MockAuthUser | null,
    opts?: { ruleParams?: Record<string, unknown> },
  ) => {
    const result: Record<string, any> = {};
    Object.entries(queryObj).forEach(([entity, subQuery]) => {
      result[entity] = queryEntity(
        entity,
        subQuery,
        rules,
        authUser,
        opts?.ruleParams,
      );
    });
    return Promise.resolve(result);
  };

  const notImplemented = (method: string) => () => {
    throw new Error(
      `mockDb: db.auth.${method} is not implemented. Add a stub if your tests need it.`,
    );
  };

  const auth = {
    createToken: (
      input: string | { id?: string; email?: string },
    ) => {
      const opts = typeof input === "string" ? { email: input } : input;
      const usersMap = ensureEntityMap("$users");
      if (opts.email) {
        for (const existing of usersMap.values()) {
          if (existing.email === opts.email) {
            return Promise.resolve(crypto.randomUUID());
          }
        }
      }
      const id = opts.id ?? crypto.randomUUID();
      const existing = usersMap.get(id) ?? {};
      usersMap.set(id, {
        ...existing,
        id,
        ...(opts.email ? { email: opts.email } : {}),
      });
      return Promise.resolve(crypto.randomUUID());
    },
    getUser: notImplemented("getUser"),
    sendMagicCode: notImplemented("sendMagicCode"),
    verifyMagicCode: notImplemented("verifyMagicCode"),
    verifyToken: notImplemented("verifyToken"),
    signOut: notImplemented("signOut"),
  };

  const adminDb = {
    tx: buildTxProxy(),
    transact: (opsArg: any) => {
      applyOpsUnchecked(opsArg);
      return Promise.resolve();
    },
    query: (queryObj: any) => runQuery(queryObj, null, null),
    auth,
  } as unknown as InstantAdminDatabase<Schema>;

  return {
    schemaLike,
    store,
    ensureEntityMap,
    resolveRef,
    applyOpsChecked,
    runQuery,
    adminDb,
  };
};

export const createMockDb = <
  Schema extends InstantSchemaDef<any, any, any>,
>(
  schema: Schema,
): InstantAdminDatabase<Schema> => createInternalStore(schema).adminDb;

export const createPermissionedMockDb = <
  Schema extends InstantSchemaDef<any, any, any>,
>(
  schema: Schema,
  rules: RulesLike,
): PermissionedMockDb<Schema> => {
  validateRules(rules);
  const internal = createInternalStore(schema);

  const signUpWithEmail: PermissionedMockDb<Schema>["signUpWithEmail"] = async (
    {
      email,
      id,
      extraFields,
    },
  ) => {
    const usersMap = internal.ensureEntityMap("$users");
    for (const existing of usersMap.values()) {
      if (existing.email === email) {
        return {
          user: { ...existing } as MockAuthUser,
          created: false,
        };
      }
    }
    const resolvedId = id ?? crypto.randomUUID();
    const allowed = await Promise.resolve(
      evaluateSignupPermission(rules, {
        email,
        id: resolvedId,
        extraFields,
        schema: internal.schemaLike,
        resolveRef: internal.resolveRef,
      }),
    );
    if (!allowed) {
      throw new InstantPermissionError(
        "$users",
        "create",
        "Signup blocked by $users.allow.create rule",
      );
    }
    const user: MockAuthUser = {
      id: resolvedId,
      email,
      ...(extraFields ?? {}),
    };
    usersMap.set(resolvedId, { ...user });
    return { user, created: true };
  };

  const signUpAsGuest: PermissionedMockDb<Schema>["signUpAsGuest"] = async (
    opts = {},
  ) => {
    const resolvedId = opts.id ?? crypto.randomUUID();
    const allowed = await Promise.resolve(
      evaluateSignupPermission(rules, {
        email: null,
        id: resolvedId,
        extraFields: opts.extraFields,
        schema: internal.schemaLike,
        resolveRef: internal.resolveRef,
      }),
    );
    if (!allowed) {
      throw new InstantPermissionError(
        "$users",
        "create",
        "Guest signup blocked by $users.allow.create rule",
      );
    }
    const user: MockAuthUser = {
      id: resolvedId,
      type: "guest",
      ...(opts.extraFields ?? {}),
    };
    internal.ensureEntityMap("$users").set(resolvedId, { ...user });
    return { user, created: true };
  };

  const asUser = (
    authUser: MockAuthUser | null,
  ): PermissionedClient<Schema> => ({
    tx: buildTxProxy() as InstantAdminDatabase<Schema>["tx"],
    lookup,
    transact: (opsArg: any) => {
      try {
        internal.applyOpsChecked(opsArg, rules, authUser);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },
    query:
      ((queryObj: any, opts?: { ruleParams?: Record<string, unknown> }) =>
        internal.runQuery(queryObj, rules, authUser, opts)) as any,
  });

  return {
    admin: internal.adminDb,
    lookup,
    signUpWithEmail,
    signUpAsGuest,
    asUser,
  };
};
