# @uri/instantdb-mock

In-memory mock of [InstantDB](https://instantdb.com)'s admin client, driven
entirely by your schema.

Lets you run backend tests against an in-memory store, without spinning up a
real InstantDB app.

## Install

```ts
import { createMockDb } from "jsr:@uri/instantdb-mock";
```

Or add to `deno.json`:

```json
{
  "imports": {
    "@uri/instantdb-mock": "jsr:@uri/instantdb-mock"
  }
}
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

## What's not (yet)

- Real-time subscriptions / `useQuery`.
- Server-side permissions enforcement.
- Multi-field `$order`.

PRs welcome.

## License

MIT
