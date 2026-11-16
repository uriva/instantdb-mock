// Minimal, zero-dependency CEL parser and evaluator matching InstantDB's
// permission rule runtime (`instant/server/src/instant/db/cel.clj`).

export type RefResolver = (
  entityType: string,
  entityId: string | null,
  path: string,
) => unknown[];

export type CelContext = {
  auth?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  linkedData?: Record<string, unknown> | null;
  request?: {
    modifiedFields?: string[];
    time?: number;
    ip?: string | null;
    origin?: string | null;
  };
  ruleParams?: Record<string, unknown>;
  entityType?: string;
  linkedEntityType?: string;
  resolveRef?: RefResolver;
};

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "punc"; value: string };

type Expr =
  | { type: "lit"; value: unknown }
  | { type: "ident"; name: string }
  | { type: "list"; items: Expr[] }
  | { type: "unary"; op: "!" | "-"; arg: Expr }
  | { type: "binary"; op: string; left: Expr; right: Expr }
  | { type: "ternary"; cond: Expr; truthy: Expr; falsy: Expr }
  | { type: "member"; target: Expr; prop: string }
  | { type: "index"; target: Expr; index: Expr }
  | { type: "call"; callee: Expr; args: Expr[] };

const twoCharOps = new Set(["&&", "||", "==", "!=", "<=", ">="]);
const oneCharOps = new Set(["!", "<", ">", "+", "-", "*", "/", "%", "?", ":"]);
const puncChars = new Set(["(", ")", "[", "]", ",", "."]);

const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let val = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const esc = src[i + 1];
          val += esc === "n"
            ? "\n"
            : esc === "t"
            ? "\t"
            : esc === "r"
            ? "\r"
            : esc;
          i += 2;
        } else {
          val += src[i++];
        }
      }
      if (src[i] !== quote) {
        throw new Error(`Unterminated string literal in CEL: ${src}`);
      }
      i++;
      tokens.push({ kind: "str", value: val });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let numStr = "";
      while (i < src.length && /[0-9.]/.test(src[i])) {
        numStr += src[i++];
      }
      tokens.push({ kind: "num", value: Number(numStr) });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (twoCharOps.has(two)) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if (oneCharOps.has(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (puncChars.has(ch)) {
      tokens.push({ kind: "punc", value: ch });
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let id = "";
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) {
        id += src[i++];
      }
      if (id === "in") {
        tokens.push({ kind: "op", value: "in" });
      } else {
        tokens.push({ kind: "ident", value: id });
      }
      continue;
    }
    throw new Error(`Unexpected character '${ch}' in CEL: ${src}`);
  }
  return tokens;
};

const parseCel = (src: string): Expr => {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const consume = (): Token => {
    const t = tokens[pos++];
    if (!t) throw new Error(`Unexpected end of CEL expression: ${src}`);
    return t;
  };
  const matchOp = (...ops: string[]): string | null => {
    const t = peek();
    if (t?.kind === "op" && ops.includes(t.value)) {
      pos++;
      return t.value;
    }
    return null;
  };
  const matchPunc = (p: string): boolean => {
    const t = peek();
    if (t?.kind === "punc" && t.value === p) {
      pos++;
      return true;
    }
    return false;
  };
  const expectPunc = (p: string) => {
    if (!matchPunc(p)) {
      throw new Error(`Expected '${p}' in CEL expression: ${src}`);
    }
  };

  const parseExpr = (): Expr => parseTernary();

  const parseTernary = (): Expr => {
    const cond = parseOr();
    if (matchOp("?")) {
      const truthy = parseExpr();
      if (!matchOp(":")) {
        throw new Error(`Expected ':' in ternary CEL expression: ${src}`);
      }
      const falsy = parseExpr();
      return { type: "ternary", cond, truthy, falsy };
    }
    return cond;
  };

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (matchOp("||")) {
      left = { type: "binary", op: "||", left, right: parseAnd() };
    }
    return left;
  };

  const parseAnd = (): Expr => {
    let left = parseRel();
    while (matchOp("&&")) {
      left = { type: "binary", op: "&&", left, right: parseRel() };
    }
    return left;
  };

  const parseRel = (): Expr => {
    let left = parseAdd();
    let op: string | null;
    while ((op = matchOp("==", "!=", "<", "<=", ">", ">=", "in")) !== null) {
      left = { type: "binary", op, left, right: parseAdd() };
    }
    return left;
  };

  const parseAdd = (): Expr => {
    let left = parseMul();
    let op: string | null;
    while ((op = matchOp("+", "-")) !== null) {
      left = { type: "binary", op, left, right: parseMul() };
    }
    return left;
  };

  const parseMul = (): Expr => {
    let left = parseUnary();
    let op: string | null;
    while ((op = matchOp("*", "/", "%")) !== null) {
      left = { type: "binary", op, left, right: parseUnary() };
    }
    return left;
  };

  const parseUnary = (): Expr => {
    const op = matchOp("!", "-");
    if (op === "!" || op === "-") {
      return { type: "unary", op, arg: parseUnary() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): Expr => {
    let expr = parseAtom();
    while (true) {
      if (matchPunc(".")) {
        const next = consume();
        if (next.kind !== "ident") {
          throw new Error(`Expected identifier after '.' in CEL: ${src}`);
        }
        expr = { type: "member", target: expr, prop: next.value };
      } else if (matchPunc("[")) {
        const idx = parseExpr();
        expectPunc("]");
        expr = { type: "index", target: expr, index: idx };
      } else if (matchPunc("(")) {
        const args: Expr[] = [];
        if (!matchPunc(")")) {
          do {
            args.push(parseExpr());
          } while (matchPunc(","));
          expectPunc(")");
        }
        expr = { type: "call", callee: expr, args };
      } else {
        break;
      }
    }
    return expr;
  };

  const parseAtom = (): Expr => {
    if (matchPunc("(")) {
      const inner = parseExpr();
      expectPunc(")");
      return inner;
    }
    if (matchPunc("[")) {
      const items: Expr[] = [];
      if (!matchPunc("]")) {
        do {
          items.push(parseExpr());
        } while (matchPunc(","));
        expectPunc("]");
      }
      return { type: "list", items };
    }
    const t = consume();
    if (t.kind === "num" || t.kind === "str") {
      return { type: "lit", value: t.value };
    }
    if (t.kind === "ident") {
      if (t.value === "true") return { type: "lit", value: true };
      if (t.value === "false") return { type: "lit", value: false };
      if (t.value === "null") return { type: "lit", value: null };
      return { type: "ident", name: t.value };
    }
    throw new Error(`Unexpected token '${t.value}' in CEL: ${src}`);
  };

  const ast = parseExpr();
  if (pos < tokens.length) {
    throw new Error(
      `Unexpected trailing token '${tokens[pos].value}' in CEL: ${src}`,
    );
  }
  return ast;
};

const validateAst = (node: Expr): void => {
  switch (node.type) {
    case "lit":
    case "ident":
      return;
    case "list":
      node.items.forEach(validateAst);
      return;
    case "unary":
      validateAst(node.arg);
      return;
    case "binary":
      validateAst(node.left);
      validateAst(node.right);
      return;
    case "ternary":
      validateAst(node.cond);
      validateAst(node.truthy);
      validateAst(node.falsy);
      return;
    case "member":
      validateAst(node.target);
      return;
    case "index":
      validateAst(node.target);
      validateAst(node.index);
      return;
    case "call":
      validateAst(node.callee);
      node.args.forEach(validateAst);
      if (
        node.callee.type === "member" &&
        node.callee.prop === "ref" &&
        node.callee.target.type === "ident" &&
        node.callee.target.name === "auth" &&
        node.args.length === 1 &&
        node.args[0].type === "lit" &&
        typeof node.args[0].value === "string" &&
        !node.args[0].value.startsWith("$user.")
      ) {
        throw new Error(
          "Validation failed for rule: auth.ref arg must start with `$user.`",
        );
      }
      return;
  }
};

const astCache = new Map<string, Expr>();
export const validateCelExpr = (src: string): Expr => {
  const cached = astCache.get(src);
  if (cached) return cached;
  const parsed = parseCel(src);
  validateAst(parsed);
  astCache.set(src, parsed);
  return parsed;
};
const getAst = validateCelExpr;

const REF_TAG = Symbol("celRefTarget");

type TaggedMap = Record<string, unknown> & {
  [REF_TAG]?: { entityType: string; isAuth?: boolean };
};

const wrapEntityMap = (
  raw: Record<string, unknown> | null | undefined,
  entityType: string,
  isAuth = false,
): TaggedMap => {
  const base: TaggedMap = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      base[k] = v === undefined ? null : v;
    }
  }
  Object.defineProperty(base, REF_TAG, {
    value: { entityType, isAuth },
    enumerable: false,
  });
  return base;
};

const normalizeVal = (v: unknown): unknown => v === undefined ? null : v;

const celEquals = (a: unknown, b: unknown): boolean => {
  const na = normalizeVal(a);
  const nb = normalizeVal(b);
  if (Array.isArray(na) && Array.isArray(nb)) {
    return na.length === nb.length && na.every((x, i) => celEquals(x, nb[i]));
  }
  return na === nb;
};

const computeSize = (v: unknown): number => {
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  return 0;
};

export type BindInput =
  | Record<string, string>
  | readonly string[]
  | undefined;

export const normalizeBindPairs = (
  bind: BindInput,
): Array<[string, string]> => {
  if (!bind) return [];
  if (Array.isArray(bind)) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < bind.length; i += 2) {
      pairs.push([String(bind[i]), String(bind[i + 1])]);
    }
    return pairs;
  }
  return Object.entries(bind as Record<string, string>);
};

export const evaluateCelRule = (
  exprStr: string,
  ctx: CelContext,
  binds: Array<[string, string]> = [],
): boolean => {
  const etype = ctx.entityType ?? "";
  const scope: Record<string, unknown> = {
    auth: ctx.auth && ctx.auth.id != null
      ? wrapEntityMap(ctx.auth, "$users", true)
      : wrapEntityMap(null, "$users", true),
    data: wrapEntityMap(ctx.data ?? null, etype),
    newData: wrapEntityMap(ctx.newData ?? ctx.data ?? null, etype),
    linkedData: wrapEntityMap(
      ctx.linkedData ?? null,
      ctx.linkedEntityType ?? "",
    ),
    ruleParams: wrapEntityMap(ctx.ruleParams ?? {}, ""),
    request: {
      modifiedFields: ctx.request?.modifiedFields ?? [],
      time: ctx.request?.time ?? Date.now(),
      ip: ctx.request?.ip ?? null,
      origin: ctx.request?.origin ?? null,
    },
  };

  const evalNode = (node: Expr, env: Record<string, unknown>): unknown => {
    switch (node.type) {
      case "lit":
        return node.value;
      case "ident":
        return node.name in env ? normalizeVal(env[node.name]) : null;
      case "list":
        return node.items.map((item) => evalNode(item, env));
      case "unary": {
        const val = evalNode(node.arg, env);
        return node.op === "!" ? !val : -(Number(val));
      }
      case "ternary":
        return evalNode(node.cond, env)
          ? evalNode(node.truthy, env)
          : evalNode(node.falsy, env);
      case "binary": {
        if (node.op === "&&") {
          return Boolean(evalNode(node.left, env)) &&
            Boolean(evalNode(node.right, env));
        }
        if (node.op === "||") {
          return Boolean(evalNode(node.left, env)) ||
            Boolean(evalNode(node.right, env));
        }
        const l = evalNode(node.left, env);
        const r = evalNode(node.right, env);
        switch (node.op) {
          case "==":
            return celEquals(l, r);
          case "!=":
            return !celEquals(l, r);
          case "<":
            return (l as number) < (r as number);
          case "<=":
            return (l as number) <= (r as number);
          case ">":
            return (l as number) > (r as number);
          case ">=":
            return (l as number) >= (r as number);
          case "+":
            return typeof l === "string" || typeof r === "string"
              ? String(l ?? "") + String(r ?? "")
              : Number(l) + Number(r);
          case "-":
            return Number(l) - Number(r);
          case "*":
            return Number(l) * Number(r);
          case "/":
            return Number(l) / Number(r);
          case "%":
            return Number(l) % Number(r);
          case "in": {
            if (Array.isArray(r)) return r.some((item) => celEquals(l, item));
            if (r && typeof r === "object") {
              return String(l) in (r as Record<string, unknown>);
            }
            return false;
          }
          default:
            throw new Error(`Unsupported binary op: ${node.op}`);
        }
      }
      case "member": {
        const target = evalNode(node.target, env);
        if (target === null || target === undefined) return null;
        if (typeof target === "object") {
          const val = (target as Record<string, unknown>)[node.prop];
          return normalizeVal(val);
        }
        return null;
      }
      case "index": {
        const target = evalNode(node.target, env);
        const idx = evalNode(node.index, env);
        if (Array.isArray(target)) {
          return normalizeVal(target[Number(idx)]);
        }
        if (target && typeof target === "object") {
          return normalizeVal((target as Record<string, unknown>)[String(idx)]);
        }
        return null;
      }
      case "call": {
        if (node.callee.type === "ident") {
          const fnName = node.callee.name;
          if (fnName === "size" && node.args.length === 1) {
            return computeSize(evalNode(node.args[0], env));
          }
          throw new Error(`Unsupported global CEL function: ${fnName}`);
        }
        if (node.callee.type === "member") {
          const method = node.callee.prop;
          const receiver = evalNode(node.callee.target, env);

          // Comprehension macros: .all(x, p), .exists(x, p), .exists_one(x, p), .filter(x, p), .map(x, e)
          if (
            (method === "all" ||
              method === "exists" ||
              method === "exists_one" ||
              method === "filter" ||
              method === "map") &&
            node.args.length === 2 &&
            node.args[0].type === "ident"
          ) {
            const varName = node.args[0].name;
            const bodyExpr = node.args[1];
            const list = Array.isArray(receiver) ? receiver : [];
            if (method === "all") {
              return list.every((item) =>
                Boolean(evalNode(bodyExpr, { ...env, [varName]: item }))
              );
            }
            if (method === "exists") {
              return list.some((item) =>
                Boolean(evalNode(bodyExpr, { ...env, [varName]: item }))
              );
            }
            if (method === "exists_one") {
              return list.filter((item) =>
                Boolean(evalNode(bodyExpr, { ...env, [varName]: item }))
              ).length === 1;
            }
            if (method === "filter") {
              return list.filter((item) =>
                Boolean(evalNode(bodyExpr, { ...env, [varName]: item }))
              );
            }
            return list.map((item) =>
              evalNode(bodyExpr, { ...env, [varName]: item })
            );
          }

          const evalArgs = node.args.map((a) => evalNode(a, env));
          if (method === "ref" && evalArgs.length === 1) {
            const tag = receiver && typeof receiver === "object"
              ? (receiver as TaggedMap)[REF_TAG]
              : undefined;
            if (!tag || !ctx.resolveRef) return [];
            const rawId = (receiver as Record<string, unknown>).id;
            const id = rawId == null ? null : String(rawId);
            const rawPath = String(evalArgs[0]);
            if (tag.isAuth && !rawPath.startsWith("$user.")) {
              throw new Error(
                "Validation failed for rule: auth.ref arg must start with `$user.`",
              );
            }
            const path = tag.isAuth ? rawPath.slice("$user.".length) : rawPath;
            return ctx.resolveRef(tag.entityType, id, path);
          }
          if (method === "size" && evalArgs.length === 0) {
            return computeSize(receiver);
          }
          if (method === "startsWith" && evalArgs.length === 1) {
            return typeof receiver === "string" &&
              receiver.startsWith(String(evalArgs[0]));
          }
          if (method === "endsWith" && evalArgs.length === 1) {
            return typeof receiver === "string" &&
              receiver.endsWith(String(evalArgs[0]));
          }
          if (method === "contains" && evalArgs.length === 1) {
            if (typeof receiver === "string") {
              return receiver.includes(String(evalArgs[0]));
            }
            if (Array.isArray(receiver)) {
              return receiver.some((x) => celEquals(x, evalArgs[0]));
            }
            return false;
          }
          if (method === "matches" && evalArgs.length === 1) {
            return typeof receiver === "string" &&
              new RegExp(String(evalArgs[0])).test(receiver);
          }
          throw new Error(`Unsupported CEL method: .${method}()`);
        }
        throw new Error("Unsupported CEL call expression");
      }
    }
  };

  for (const [bindName, bindExpr] of binds) {
    scope[bindName] = evalNode(getAst(bindExpr), scope);
  }

  return Boolean(evalNode(getAst(exprStr), scope));
};
