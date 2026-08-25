import { createDb, dropTenant, seedTenant } from "@deepcrm/db";
import { ErrorCode, type ActorContext } from "@deepcrm/schemas";
import { afterAll, describe, expect, it } from "vitest";

import {
  applyTemplate,
  createRecord,
  defineRelationType,
  linkRecords,
  loadSchema,
  unlinkRecords,
  type LinkWriter,
  type LinkWriteResult,
} from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error("DATABASE_URL is required for direct link tests");
const db = createDb(databaseUrl);
const organizations: string[] = [];

const noLinks: LinkWriter = {
  apply: async (): Promise<LinkWriteResult> => {
    throw new Error("Unexpected projection link write");
  },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
};

function actor(tenant: {
  organizationId: string;
  teamId: string;
}): ActorContext {
  return {
    tenant,
    app: "test",
    actor: { type: "system", id: "test" },
    onBehalfOf: { uoaUserId: "uoa_test", role: "owner" },
    provenance: null,
    actChain: [],
    requestId: crypto.randomUUID(),
    now: new Date(),
  };
}

async function setup() {
  const tenant = await seedTenant(db);
  organizations.push(tenant.organizationId);
  const ctx = actor(tenant);
  await db.$transaction((tx) =>
    applyTemplate(
      tx,
      tenant,
      {
        type: "system",
        id: "test",
        onBehalfOf: null,
        requestId: crypto.randomUUID(),
      },
      "standard_crm",
    ),
  );
  await db.$transaction((tx) =>
    Promise.all([
      defineRelationType(
        tx,
        tenant,
        {
          type: ctx.actor.type,
          id: ctx.actor.id,
          onBehalfOf: null,
          requestId: ctx.requestId,
        },
        {
          slug: "direct_employer",
          fromObjectType: "person",
          toObjectType: "company",
          forwardName: "works at",
          inverseName: "employs",
          cardinality: "many_to_one",
        },
      ),
      defineRelationType(
        tx,
        tenant,
        {
          type: ctx.actor.type,
          id: ctx.actor.id,
          onBehalfOf: null,
          requestId: ctx.requestId,
        },
        {
          slug: "direct_edge",
          fromObjectType: "person",
          toObjectType: "company",
          forwardName: "notes",
          inverseName: "noted by",
          cardinality: "many_to_many",
          edgeAttributes: [
            {
              slug: "note",
              name: "Note",
              description: "Short note",
              type: "text",
              config: { type: "text", maxLength: 4 },
              is_multi: false,
              is_required: true,
              is_unique: false,
              is_indexed: false,
              sensitivity: "internal",
            },
          ],
        },
      ),
      defineRelationType(
        tx,
        tenant,
        {
          type: ctx.actor.type,
          id: ctx.actor.id,
          onBehalfOf: null,
          requestId: ctx.requestId,
        },
        {
          slug: "direct_limited",
          fromObjectType: "person",
          toObjectType: "company",
          forwardName: "limited",
          inverseName: "limited by",
          cardinality: "many_to_many",
          maxActiveEdgesFrom: 2,
          edgeLimitConfig: { ceo: { max_active_edges_from: 1 } },
        },
      ),
    ]),
  );
  const schema = await loadSchema(db, tenant);
  const person = await db.$transaction((tx) =>
    createRecord(
      tx,
      ctx,
      schema,
      {
        objectType: "person",
        data: { name: { full: "Ada" } },
      },
      noLinks,
    ),
  );
  const companies = await Promise.all(
    ["One", "Two"].map((name) =>
      db.$transaction((tx) =>
        createRecord(
          tx,
          ctx,
          schema,
          { objectType: "company", data: { name } },
          noLinks,
        ),
      ),
    ),
  );
  return {
    tenant,
    ctx,
    schema,
    person: person.record,
    companies: companies.map((item) => item.record),
  };
}

afterAll(async () => {
  await Promise.all(
    organizations.map((organizationId) => dropTenant(db, organizationId)),
  );
  await db.$disconnect();
});

describe("direct links", () => {
  it("replaces a cardinality conflict with one final version per endpoint", async () => {
    const { ctx, schema, person, companies } = await setup();
    const [first, second] = companies;
    if (first === undefined || second === undefined)
      throw new Error("Missing company fixtures");
    const initial = await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "direct_employer",
        fromRecordId: person.id,
        toRecordId: first.id,
      }),
    );
    const replaced = await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "direct_employer",
        fromRecordId: person.id,
        toRecordId: second.id,
      }),
    );
    expect(replaced.endedLinks).toEqual([initial.link.id]);
    expect(replaced.touchedRecordIds).toEqual(
      [person.id, first.id, second.id].sort(),
    );
    expect(replaced.changes).toHaveLength(4);
    expect(
      replaced.changes
        .filter((change) => change.recordId === person.id)
        .map((change) => change.resultingVersion),
    ).toEqual([3, 3]);
    expect(
      replaced.changes
        .filter((change) => change.recordId === first.id)
        .map((change) => change.resultingVersion),
    ).toEqual([3]);
    expect(
      replaced.changes
        .filter((change) => change.recordId === second.id)
        .map((change) => change.resultingVersion),
    ).toEqual([2]);
    const pairs = new Map<string, number>();
    for (const change of replaced.changes) {
      const key = `${change.kind}:${change.linkId}:${change.groupId}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    expect([...pairs.values()]).toEqual([2, 2]);
  });

  it("runs link and triple-unlink callbacks under the resolved active-link lock", async () => {
    const { tenant, ctx, schema, person, companies } = await setup();
    const [first, second] = companies;
    if (first === undefined || second === undefined)
      throw new Error("Missing company fixtures");
    const initial = await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "direct_employer",
        fromRecordId: person.id,
        toRecordId: first.id,
      }),
    );
    let linkResolved = false;
    await db.$transaction((tx) =>
      linkRecords(
        tx,
        ctx,
        schema,
        {
          relationType: "direct_employer",
          fromRecordId: person.id,
          toRecordId: second.id,
        },
        async (resolved) => {
          linkResolved = true;
          expect(resolved.endpointRecordIds).toEqual(
            [person.id, first.id, second.id].sort(),
          );
          expect(resolved.conflictLinkIds).toEqual([initial.link.id]);
          expect(
            await tx.recordLink.count({
              where: { organizationId: tenant.organizationId, teamId: tenant.teamId, id: initial.link.id, activeUntil: null },
            }),
          ).toBe(1);
        },
      ),
    );
    expect(linkResolved).toBe(true);
    let unlinkResolved = false;
    await db.$transaction((tx) =>
      unlinkRecords(
        tx,
        ctx,
        schema,
        "direct_employer",
        person.id,
        second.id,
        async (resolved) => {
          unlinkResolved = true;
          expect(resolved.endpointRecordIds).toEqual(
            [person.id, second.id].sort(),
          );
          expect(resolved.conflictLinkIds).toHaveLength(1);
        },
      ),
    );
    expect(unlinkResolved).toBe(true);
  });

  it("strips edge config discriminators and makes an exact M:N retry a no-op", async () => {
    const { tenant, ctx, schema, person, companies } = await setup();
    const first = companies[0];
    if (first === undefined) throw new Error("Missing company fixture");
    const initial = await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "direct_edge",
        fromRecordId: person.id,
        toRecordId: first.id,
        data: { note: "okay" },
      }),
    );
    expect(initial.link).toMatchObject({
      fromRecordId: person.id,
      toRecordId: first.id,
    });
    const before = await db.record.findMany({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, id: { in: [person.id, first.id] } },
      select: { id: true, version: true }, orderBy: { id: 'asc' },
    });
    const repeated = await db.$transaction((tx) => linkRecords(tx, ctx, schema, {
      relationType: 'direct_edge', fromRecordId: person.id, toRecordId: first.id, data: { note: 'okay' },
    }))
    expect(repeated.link.id).toBe(initial.link.id)
    expect(repeated.endedLinks).toEqual([])
    expect(repeated.changes).toEqual([])
    expect(repeated.touchedRecordIds).toEqual([])
    expect(await db.recordLink.count({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, relationTypeId: initial.link.relationTypeId, activeUntil: null },
    })).toBe(1)
    expect(await db.record.findMany({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, id: { in: [person.id, first.id] } },
      select: { id: true, version: true }, orderBy: { id: 'asc' },
    })).toEqual(before)
    await expect(
      db.$transaction((tx) =>
        linkRecords(tx, ctx, schema, {
          relationType: "direct_edge",
          fromRecordId: person.id,
          toRecordId: first.id,
          data: { note: "too long" },
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it("enforces relation edge limits without leaking competing record ids", async () => {
    const { ctx, schema, person, companies } = await setup();
    const [first, second] = companies;
    if (first === undefined || second === undefined)
      throw new Error("Missing company fixtures");
    await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "direct_limited",
        fromRecordId: person.id,
        toRecordId: first.id,
        label: "ceo",
      }),
    );
    await expect(db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "direct_limited",
        fromRecordId: person.id,
        toRecordId: second.id,
        label: "ceo",
      }),
    )).rejects.toMatchObject({
      code: ErrorCode.CARDINALITY_VIOLATION,
      details: { relation_type: "direct_limited", direction: "from", label: "ceo", bound: 1 },
    });
  });

  it("serializes concurrent edge-limit races under the topology lock", async () => {
    const { ctx, schema, person, companies } = await setup();
    const [first, second] = companies;
    if (first === undefined || second === undefined)
      throw new Error("Missing company fixtures");
    const attempts = await Promise.allSettled([
      db.$transaction((tx) => linkRecords(tx, ctx, schema, {
        relationType: "direct_limited", fromRecordId: person.id, toRecordId: first.id, label: "ceo",
      })),
      db.$transaction((tx) => linkRecords(tx, ctx, schema, {
        relationType: "direct_limited", fromRecordId: person.id, toRecordId: second.id, label: "ceo",
      })),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });
});
