import { i } from "@instantdb/core";
import {
  canSignUpAsGuest,
  canSignUpWithEmail,
  createPermissionedMockDb,
  InstantPermissionError,
  lookup,
  type RulesLike,
} from "./mod.ts";

const testSchema = i.schema({
  entities: {
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
      phone: i.string().optional(),
      phoneVerified: i.boolean().optional(),
    }),
    users: i.entity({
      userId: i.string().unique().indexed(),
      lastVisit: i.number().optional(),
      aliceAndBotPublicSignKey: i.string().optional(),
      messageCount: i.number().optional(),
      secretNote: i.string().optional(),
    }),
    apiTokens: i.entity({
      seed: i.string().unique().indexed(),
      active: i.boolean(),
    }),
  },
  links: {
    apiTokenOwner: {
      forward: { on: "apiTokens", has: "one", label: "owner" },
      reverse: { on: "users", has: "many", label: "apiTokens" },
    },
  },
});

const assertThrowsAsync = async (fn: () => Promise<unknown>) => {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = err instanceof InstantPermissionError;
    if (!threw) throw err;
  }
  if (!threw) throw new Error("Expected InstantPermissionError to be thrown");
};

Deno.test("signup evaluation: $users.allow.create 'false' blocks new signups while allowing existing users", async () => {
  const brokenRules: RulesLike = {
    $default: { allow: { $default: "false" } },
    $users: {
      allow: {
        view: "auth.id != null && auth.id == data.id",
        create: "false",
        update: "false",
      },
    },
  };
  if (canSignUpWithEmail(brokenRules, { email: "new@example.com" })) {
    throw new Error("Expected signup to be blocked");
  }
  if (canSignUpAsGuest(brokenRules)) {
    throw new Error("Expected guest signup to be blocked");
  }

  const db = createPermissionedMockDb(testSchema, brokenRules);
  await assertThrowsAsync(() =>
    db.signUpWithEmail({ email: "new@example.com" })
  );

  await db.admin.auth.createToken({
    id: "u-existing",
    email: "old@example.com",
  });
  const existingLogin = await db.signUpWithEmail({ email: "old@example.com" });
  if (existingLogin.created || existingLogin.user.id !== "u-existing") {
    throw new Error("Expected existing user login to succeed without creation");
  }
});

Deno.test("signup evaluation: $default false does not block signup, and data.email != null blocks guests and extraFields spoofing", () => {
  const defaultOnlyRules: RulesLike = {
    $default: { allow: { $default: "false" } },
  };
  if (!canSignUpWithEmail(defaultOnlyRules, { email: "a@example.com" })) {
    throw new Error("Expected default email signup to pass");
  }
  if (!canSignUpAsGuest(defaultOnlyRules)) {
    throw new Error("Expected default guest signup to pass");
  }
  if (
    canSignUpWithEmail(defaultOnlyRules, {
      email: "a@example.com",
      extraFields: { phoneVerified: true },
      schema: testSchema,
    })
  ) {
    throw new Error(
      "Expected extraFields without explicit create rule to fail",
    );
  }

  const verifiedEmailRules: RulesLike = {
    $users: {
      allow: {
        create:
          "data.email != null && data.phone == null && data.phoneVerified == null",
      },
    },
  };
  if (!canSignUpWithEmail(verifiedEmailRules, { email: "a@example.com" })) {
    throw new Error("Expected verified-email signup to pass");
  }
  if (canSignUpAsGuest(verifiedEmailRules)) {
    throw new Error(
      "Expected guest signup to be blocked by data.email != null",
    );
  }
  if (
    canSignUpWithEmail(verifiedEmailRules, {
      email: "a@example.com",
      extraFields: { phoneVerified: true },
      schema: testSchema,
    })
  ) {
    throw new Error("Expected phoneVerified spoofing to be blocked");
  }
});

Deno.test("permissioned transact & query: lookup onboarding, modifiedFields, data.ref, field masking, and $users creation guard", async () => {
  const rules: RulesLike = {
    $default: { allow: { $default: "false" } },
    attrs: { allow: { $default: "false", create: "false" } },
    $users: {
      bind: ["isSelf", "auth.id != null && auth.id == data.id"],
      allow: {
        view: "isSelf",
        create: "data.email != null",
        update: "false",
      },
    },
    users: {
      bind: {
        isOwner:
          "auth.id != null && auth.email != null && auth.email == data.userId",
        isStillOwner:
          "!('userId' in request.modifiedFields) || newData.userId == data.userId",
        onlyAllowed:
          "request.modifiedFields.all(field, field in ['userId', 'aliceAndBotPublicSignKey', 'lastVisit'])",
        noKeyOverwrite:
          "!('aliceAndBotPublicSignKey' in request.modifiedFields) || data.aliceAndBotPublicSignKey == null || newData.aliceAndBotPublicSignKey == data.aliceAndBotPublicSignKey",
      },
      allow: {
        view: "isOwner",
        create: "isOwner && onlyAllowed",
        update: "isOwner && isStillOwner && onlyAllowed && noKeyOverwrite",
        delete: "false",
      },
      fields: {
        secretNote: "false",
      },
    },
    apiTokens: {
      bind: {
        isOwner:
          "auth.id != null && auth.email != null && auth.email in data.ref('owner.userId')",
        onlyDeactivate:
          "request.modifiedFields.all(field, field in ['active']) && newData.active == false",
      },
      allow: {
        view: "isOwner",
        create: "false",
        update: "isOwner && onlyDeactivate",
        delete: "false",
      },
    },
  };

  const db = createPermissionedMockDb(testSchema, rules);
  const { user: alice } = await db.signUpWithEmail({
    email: "alice@example.com",
  });
  const { user: bob } = await db.signUpWithEmail({ email: "bob@example.com" });

  const aliceClient = db.asUser(alice);
  const bobClient = db.asUser(bob);

  // Direct $users creation via transact is always blocked
  await assertThrowsAsync(() =>
    aliceClient.transact([
      aliceClient.tx.$users[crypto.randomUUID()].update({
        email: "forged@example.com",
      }),
    ])
  );

  // Alice creates her own `users` row via lookup("userId", email)
  await aliceClient.transact([
    aliceClient.tx.users[lookup("userId", "alice@example.com")].update({
      lastVisit: 1000,
    }),
  ]);

  const { users: aliceRows } = await aliceClient.query({ users: {} });
  if (aliceRows.length !== 1 || aliceRows[0].userId !== "alice@example.com") {
    throw new Error("Expected Alice's users row to be created and visible");
  }
  const aliceRowId = aliceRows[0].id;

  // Admin sets a secretNote and links an apiToken
  await db.admin.transact([
    db.admin.tx.users[aliceRowId].update({ secretNote: "internal-only" }),
    db.admin.tx.apiTokens["tok-1"].update({ seed: "s1", active: true }),
    db.admin.tx.apiTokens["tok-1"].link({ owner: aliceRowId }),
  ]);

  // Field masking hides secretNote; Bob cannot see Alice's row or token
  const { users: maskedRows, apiTokens: aliceTokens } = await aliceClient.query(
    {
      users: {},
      apiTokens: {},
    },
  );
  if ("secretNote" in maskedRows[0]) {
    throw new Error("Expected secretNote field to be masked");
  }
  if (aliceTokens.length !== 1) {
    throw new Error("Expected Alice to see her linked apiToken via data.ref");
  }
  const bobView = await bobClient.query({ users: {}, apiTokens: {} });
  if (bobView.users.length !== 0 || bobView.apiTokens.length !== 0) {
    throw new Error("Expected Bob to see zero of Alice's records");
  }

  // Alice sets her sign key once, then cannot overwrite it or spoof messageCount
  await aliceClient.transact([
    aliceClient.tx.users[aliceRowId].update({
      aliceAndBotPublicSignKey: "pub-key-1",
    }),
  ]);
  await assertThrowsAsync(() =>
    aliceClient.transact([
      aliceClient.tx.users[aliceRowId].update({
        aliceAndBotPublicSignKey: "pub-key-attacker",
      }),
    ])
  );
  await assertThrowsAsync(() =>
    aliceClient.transact([
      aliceClient.tx.users[aliceRowId].update({ messageCount: 0 }),
    ])
  );

  // Alice can deactivate her token, but cannot reactivate it
  await aliceClient.transact([
    aliceClient.tx.apiTokens["tok-1"].update({ active: false }),
  ]);
  await assertThrowsAsync(() =>
    aliceClient.transact([
      aliceClient.tx.apiTokens["tok-1"].update({ active: true }),
    ])
  );
});

Deno.test("auth.ref enforces $user. prefix and resolves both direct $users attributes and linked paths", async () => {
  const schemaWithTier = i.schema({
    entities: {
      $users: i.entity({
        email: i.string().unique().indexed().optional(),
        tier: i.string().optional(),
      }),
      items: i.entity({
        label: i.string(),
        reserved: i.boolean().optional(),
      }),
    },
    links: {
      userItems: {
        forward: { on: "items", has: "one", label: "owner" },
        reverse: { on: "$users", has: "many", label: "items" },
      },
    },
  });

  const validRules: RulesLike = {
    $default: { allow: { $default: "false" } },
    items: {
      allow: {
        view:
          "data.reserved != true || auth.ref('$user.tier').exists(t, t != 'Free') || auth.ref('$user.items.label').exists(l, l == 'vip-pass')",
      },
    },
  };

  const db = createPermissionedMockDb(schemaWithTier, validRules);
  const { user: freeUser } = await db.signUpWithEmail({
    email: "free@example.com",
  });
  const { user: proUser } = await db.signUpWithEmail({
    email: "pro@example.com",
  });
  await db.admin.transact([
    db.admin.tx.$users[freeUser.id].update({ tier: "Free" }),
    db.admin.tx.$users[proUser.id].update({ tier: "Pro" }),
    db.admin.tx.items["pub"].update({ label: "public", reserved: false }),
    db.admin.tx.items["res"].update({ label: "secret", reserved: true }),
  ]);

  const freeRes = await db.asUser(freeUser).query({ items: {} });
  if (freeRes.items.length !== 1) {
    throw new Error(
      `Expected 1 item for free user, got ${freeRes.items.length}`,
    );
  }
  const proRes = await db.asUser(proUser).query({ items: {} });
  if (proRes.items.length !== 2) {
    throw new Error(
      `Expected 2 items for pro user, got ${proRes.items.length}`,
    );
  }

  const invalidRules: RulesLike = {
    items: {
      allow: {
        view: "auth.ref('items.label').exists(l, l == 'x')",
      },
    },
  };
  let rejectedMissingPrefix = false;
  try {
    createPermissionedMockDb(schemaWithTier, invalidRules);
  } catch (err) {
    rejectedMissingPrefix = String(err).includes("must start with `$user.`");
  }
  if (!rejectedMissingPrefix) {
    throw new Error(
      "Expected auth.ref without $user. prefix to throw validation error",
    );
  }
});
