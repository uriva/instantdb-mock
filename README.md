# @uri/instantdb-mock

A **partial**, in-memory mock of [InstantDB](https://instantdb.com)'s admin
client, driven entirely by your schema.

Lets you run backend tests against an in-memory store without spinning up a real
InstantDB app — fast, deterministic, no network.

> ⚠️ This is a **partial mock**, not a full reimplementation of InstantDB. It
> covers the most common admin-client read/write surface. It does **not**
> enforce permissions, does **not** support real-time subscriptions, and skips a
> handful of less common query features. See
> [Limitations](#limitations--not-covered) below before using it.

## Install

### Deno / JSR

```ts
import { createMockDb } from "jsr:@uri/instantdb-mock";
```

Or add it to your `deno.json` and import by bare specifier:

```json
{
  "imports": {
    "@uri/instantdb-mock": "jsr:@uri/instantdb-mock"
  }
}
```

### Node / npm

JSR packages publish to npm too, via the `jsr` CLI:

```bash
npx jsr add @uri/instantdb-mock
# or
pnpm dlx jsr add @uri/instantdb-mock
# or
yarn dlx jsr add @uri/instantdb-mock
# or
bunx jsr add @uri/instantdb-mock
```

Then:

```ts
import { createMockDb } from "@uri/instantdb-mock";
```

## Usage

```ts
import { createMockDb } from "@uri/instantdb-mock";
import { schema } from "./instant.schema.ts";

const db = createMockDb(schema);

await db.transact([
  db.tx.users[userId].update({ name: "Alice" }),
]);

const { users } = await db.query({ users: {} });
```

The returned object has the same shape as `InstantAdminDatabase`, so the same
code that talks to a real InstantDB in production can talk to the mock in tests
— typically by injecting the db via your DI helper of choice.

## What's supported

- Stores are initialized dynamically from `schema.entities`.
- Links are stored canonically (forward + reverse) so relationship traversal
  works in either direction.
- `link` / `unlink` / `update` / `delete` / nested query traversal.
- `has: "one"` vs `has: "many"` is respected in query results.
- Single-field `$order`.
- `$: { where: { ... } }` filtering, including dot-notation across links.

## Limitations / not covered

This mock is intentionally partial. The following are **not** implemented:

- **Permissions (`instant.perms.ts`) are not enforced.** All operations run as
  if the caller had full admin rights. If your tests need to verify permission
  rules, this mock will not catch violations.
- **No real-time subscriptions / `useQuery` / `subscribeQuery`.** Only one-shot
  `query` / `transact` are supported.
- **No auth (`auth.*`) surface.** `$users` and related auth flows are not
  simulated.
- **No storage (`storage.*`) surface.** File upload/download endpoints are not
  simulated.
- **No presence / rooms / topics** (real-time collaboration primitives).
- **Multi-field `$order`** — only a single field is supported.
- **No server-side `lookup` / unique-attribute lookups** beyond simple `where`.
- **No validation against schema types at runtime** — writes that the real
  backend would reject (wrong types, missing required fields) will silently
  succeed in memory.
- **No transaction atomicity guarantees across failures** — operations apply
  in-place.

In short: think of this as a high-fidelity in-memory store for the
read/write/link semantics you exercise in unit tests, **not** as a faithful
simulation of the production backend.

PRs welcome for any of the above.

## License

MIT
