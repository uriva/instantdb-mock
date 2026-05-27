// deno-lint-ignore-file no-explicit-any
// In-memory mock of InstantDB's admin client, driven entirely by a schema.
//
// Lets any InstantDB user run their backend tests against an in-memory store
// without spinning up a real app.
//
// Design notes:
// - Stores are dynamically initialized from `schema.entities`.
// - Links are stored in a canonical (forward, reverse) shape so that
//   relationship traversal works in either direction without ambiguity.
// - Relationship resolution (link / unlink / query / dot-notation filters)
//   is driven by `schema.links`, never hardcoded entity names.
// - `has: "one"` vs `has: "many"` is respected in query results.
//
// Known limitations (vs. real InstantDB):
// - No real-time subscriptions / `useQuery`.
// - No server-side permissions enforcement.
// - Single-field `$order`.

import type { InstantAdminDatabase } from "@instantdb/admin";
import type { InstantSchemaDef } from "@instantdb/core";

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
  entities: Record<string, unknown>;
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

export const createMockDb = <
  Schema extends InstantSchemaDef<any, any, any>,
>(
  schema: Schema,
): InstantAdminDatabase<Schema> => {
  const schemaLike = schema as unknown as SchemaLike;
  const store: Record<string, Map<string, any>> = {};
  for (const entityName of Object.keys(schemaLike.entities ?? {})) {
    store[entityName] = new Map();
  }

  let links: CanonicalLink[] = [];

  const createTxNode = (entity: string, id: string) => {
    const opsList = [] as any[];
    const node = {
      update: (data: any) => {
        opsList.push({ type: "update", entity, id, data });
        return node;
      },
      create: (data: any) => {
        opsList.push({ type: "update", entity, id, data });
        return node;
      },
      merge: (data: any) => {
        opsList.push({ type: "merge", entity, id, data });
        return node;
      },
      link: (linksObj: any) => {
        opsList.push({ type: "link", entity, id, linksObj });
        return node;
      },
      unlink: (unlinksObj: any) => {
        opsList.push({ type: "unlink", entity, id, unlinksObj });
        return node;
      },
      delete: () => {
        opsList.push({ type: "delete", entity, id });
        return node;
      },
      _ops: opsList,
    };
    return node;
  };

  const tx = new Proxy({}, {
    get: (_target, entity: string) =>
      new Proxy({}, {
        get: (_etarget, id: string) => createTxNode(entity, id),
      }),
  });

  const sameLink = (a: CanonicalLink, b: CanonicalLink) =>
    a.forwardEntity === b.forwardEntity &&
    a.forwardId === b.forwardId &&
    a.reverseEntity === b.reverseEntity &&
    a.reverseId === b.reverseId;

  const transact = (opsArg: any) => {
    const ops = Array.isArray(opsArg) ? opsArg : [opsArg];
    const flatOps = ops.flatMap((item) =>
      item && typeof item === "object" && "_ops" in item ? item._ops : [item]
    );
    flatOps.forEach((op) => {
      const entityMap = store[op.entity];
      if (!entityMap) return;

      if (op.type === "update") {
        const existing = entityMap.get(op.id) ?? {};
        entityMap.set(op.id, { ...existing, id: op.id, ...op.data });
      } else if (op.type === "merge") {
        const existing = entityMap.get(op.id) ?? {};
        entityMap.set(op.id, deepMerge({ ...existing, id: op.id }, op.data));
      } else if (op.type === "delete") {
        entityMap.delete(op.id);
        links = links.filter(
          (l) =>
            !(l.forwardEntity === op.entity && l.forwardId === op.id) &&
            !(l.reverseEntity === op.entity && l.reverseId === op.id),
        );
      } else if (op.type === "link") {
        Object.entries(op.linksObj).forEach(([label, targetId]) => {
          if (!targetId) return;
          const info = resolveLinkInfo(schemaLike, op.entity, label);
          if (!info) return;
          const canonical = toCanonicalEndpoints(
            info,
            op.entity,
            op.id,
            targetId as string,
          );
          if (!links.some((l) => sameLink(l, canonical))) {
            links.push(canonical);
          }
        });
      } else if (op.type === "unlink") {
        Object.entries(op.unlinksObj).forEach(([label, targetId]) => {
          if (!targetId) return;
          const info = resolveLinkInfo(schemaLike, op.entity, label);
          if (!info) return;
          const canonical = toCanonicalEndpoints(
            info,
            op.entity,
            op.id,
            targetId as string,
          );
          links = links.filter((l) => !sameLink(l, canonical));
        });
      }
    });
    return Promise.resolve();
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
    }
    return val === filterVal;
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

  const matchRecord = (record: any, entity: string, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, filterVal]) => {
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

  const resolveSubQuery = (
    parentEntity: string,
    parentId: string,
    label: string,
    subQuery: any,
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
      .filter((r) => matchRecord(r, info.targetEntity, where));

    const resolved = records.map((r) =>
      resolveRelationships(info.targetEntity, r, subQuery ?? {})
    );

    return info.has === "one" ? (resolved[0] ?? null) : resolved;
  };

  const resolveRelationships = (
    entity: string,
    record: any,
    queryObj: any,
  ) => {
    const result: any = { ...record };
    Object.entries(queryObj).forEach(([key, subQuery]) => {
      if (key === "$") return;
      result[key] = resolveSubQuery(entity, record.id, key, subQuery);
    });
    return result;
  };

  const queryEntity = (entity: string, queryObj: any): any[] => {
    const entityMap = store[entity];
    if (!entityMap) return [];

    const records = Array.from(entityMap.values());
    const where = queryObj.$?.where;
    const filtered = records.filter((r) => matchRecord(r, entity, where));

    const order = queryObj.$?.order;
    const sorted = !order ? filtered : filtered.slice().sort((a, b) => {
      const [[key, dir]] = Object.entries(order) as any;
      const valA = a[key] ?? 0;
      const valB = b[key] ?? 0;
      return dir === "desc" ? valB - valA : valA - valB;
    });

    const limit = queryObj.$?.limit;
    const sliced = limit !== undefined ? sorted.slice(0, limit) : sorted;

    return sliced.map((record) =>
      resolveRelationships(entity, record, queryObj)
    );
  };

  const query = (queryObj: any) => {
    const result: Record<string, any> = {};
    Object.entries(queryObj).forEach(([entity, subQuery]) => {
      result[entity] = queryEntity(entity, subQuery);
    });
    return Promise.resolve(result);
  };

  const notImplemented = (method: string) => () => {
    throw new Error(
      `mockDb: db.auth.${method} is not implemented. Add a stub if your tests need it.`,
    );
  };

  const auth = {
    createToken: ({ id, email }: { id: string; email?: string }) => {
      const usersMap = store.$users;
      if (usersMap) {
        const existing = usersMap.get(id) ?? {};
        usersMap.set(id, { ...existing, id, ...(email ? { email } : {}) });
      }
      return Promise.resolve(crypto.randomUUID());
    },
    getUser: notImplemented("getUser"),
    sendMagicCode: notImplemented("sendMagicCode"),
    verifyMagicCode: notImplemented("verifyMagicCode"),
    verifyToken: notImplemented("verifyToken"),
    signOut: notImplemented("signOut"),
  };

  return {
    tx,
    transact,
    query,
    auth,
  } as unknown as InstantAdminDatabase<Schema>;
};
