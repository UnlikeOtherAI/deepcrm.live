import { createDb, dropTenant, seedTenant } from "@deepcrm/db";
import type { ActorContext } from "@deepcrm/schemas";
import { afterAll, describe, expect, it } from "vitest";

import {
  applyTemplate,
  createProjectionLinkWriter,
  createRecord,
  defineRelationType,
  deleteRecord,
  linkRecords,
  loadSchema,
  restoreRecord,
} from "../../src/index.js";

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("DATABASE_URL is required");
const db = createDb(url);
const organizations: string[] = [];

async function setup() {
  const tenant = await seedTenant(db);
  organizations.push(tenant.organizationId);
  const ctx: ActorContext = {
    tenant,
    app: "test",
    actor: { type: "system", id: "test" },
    onBehalfOf: { uoaUserId: "uoa", role: "owner" },
    provenance: null,
    actChain: [],
    requestId: crypto.randomUUID(),
    now: new Date(),
  };
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
  await db.relationType.updateMany({
    where: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      slug: "person_works_at",
    },
    data: { onDelete: "cascade" },
  });
  await db.team.update({
    where: { id: tenant.teamId },
    data: { schemaVersion: { increment: 1 } },
  });
  return { tenant, ctx, schema: await loadSchema(db, tenant) };
}

afterAll(async () => {
  await Promise.all(organizations.map((id) => dropTenant(db, id)));
  await db.$disconnect();
});

describe("projection delete/restore", () => {
  it("rolls back restore when an active pair now conflicts", async () => {
    const { tenant, ctx } = await setup();
    await db.relationType.updateMany({
      where: {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        slug: "person_works_at",
      },
      data: { onDelete: "unlink" },
    });
    await db.team.update({
      where: { id: tenant.teamId },
      data: { schemaVersion: { increment: 1 } },
    });
    const schema = await loadSchema(db, tenant);
    const links = createProjectionLinkWriter();
    const company = await db.$transaction((tx) =>
      createRecord(
        tx,
        ctx,
        schema,
        { objectType: "company", data: { name: "root" } },
        links,
      ),
    );
    const person = await db.$transaction((tx) =>
      createRecord(
        tx,
        ctx,
        schema,
        {
          objectType: "person",
          data: { name: { full: "Ada" }, company: company.record.id },
        },
        links,
      ),
    );
    const original = await db.recordLink.findFirstOrThrow({
      where: {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        fromRecordId: person.record.id,
        toRecordId: company.record.id,
        activeUntil: null,
      },
    });
    const current = await db.record.findFirstOrThrow({
      where: { id: company.record.id },
      select: { version: true },
    });
    const deleted = await db.$transaction((tx) =>
      deleteRecord(tx, ctx, schema, company.record.id, current.version, links),
    );
    await db.recordLink.create({
      data: {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        relationTypeId: original.relationTypeId,
        fromRecordId: person.record.id,
        toRecordId: company.record.id,
        data: {},
        position: null,
        createdByType: "system",
        createdById: "conflict",
      },
    });
    const before = await db.record.findFirstOrThrow({
      where: { id: company.record.id },
      select: { deletedAt: true, version: true },
    });
    await expect(
      db.$transaction((tx) =>
        restoreRecord(
          tx,
          ctx,
          schema,
          company.record.id,
          deleted.record.version,
          links,
        ),
      ),
    ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
    expect(
      await db.record.findFirstOrThrow({
        where: { id: company.record.id },
        select: { deletedAt: true, version: true },
      }),
    ).toEqual(before);
    expect(
      await db.recordLink.findFirstOrThrow({
        where: { id: original.id },
        select: { activeUntil: true, data: true, position: true },
      }),
    ).toMatchObject({
      activeUntil: expect.any(Date),
      data: {},
      position: null,
    });
  });

  it("preflights restrict without mutating records or links", async () => {
    const { tenant, ctx } = await setup();
    await db.$transaction((tx) =>
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
          slug: "restrict_any",
          fromObjectType: null,
          toObjectType: null,
          forwardName: "blocks",
          inverseName: "blocked",
          cardinality: "many_to_many",
          onDelete: "restrict",
        },
      ),
    );
    await db.team.update({
      where: { id: tenant.teamId },
      data: { schemaVersion: { increment: 1 } },
    });
    const schema = await loadSchema(db, tenant);
    const links = createProjectionLinkWriter();
    const root = await db.$transaction((tx) =>
      createRecord(
        tx,
        ctx,
        schema,
        { objectType: "company", data: { name: "root" } },
        links,
      ),
    );
    const dependent = await db.$transaction((tx) =>
      createRecord(
        tx,
        ctx,
        schema,
        { objectType: "company", data: { name: "dependent" } },
        links,
      ),
    );
    const edge = await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "restrict_any",
        fromRecordId: dependent.record.id,
        toRecordId: root.record.id,
      }),
    );
    const version = await db.record.findFirstOrThrow({
      where: { id: root.record.id },
      select: { version: true },
    });
    await expect(
      db.$transaction((tx) =>
        deleteRecord(tx, ctx, schema, root.record.id, version.version, links),
      ),
    ).rejects.toMatchObject({ code: "DELETE_RESTRICTED" });
    expect(
      await db.record.findFirstOrThrow({
        where: { id: root.record.id },
        select: { deletedAt: true },
      }),
    ).toEqual({ deletedAt: null });
    expect(
      await db.recordLink.findFirstOrThrow({
        where: { id: edge.link.id },
        select: { activeUntil: true },
      }),
    ).toEqual({ activeUntil: null });
  });

  it("cascades a multilevel direct-link closure while leaving an unrelated record live", async () => {
    const { tenant, ctx } = await setup();
    await db.$transaction((tx) =>
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
          slug: "cascade_any",
          fromObjectType: null,
          toObjectType: null,
          forwardName: "depends",
          inverseName: "needed",
          cardinality: "many_to_many",
          onDelete: "cascade",
        },
      ),
    );
    await db.team.update({
      where: { id: tenant.teamId },
      data: { schemaVersion: { increment: 1 } },
    });
    const schema = await loadSchema(db, tenant);
    const links = createProjectionLinkWriter();
    const make = (name: string) =>
      db.$transaction((tx) =>
        createRecord(
          tx,
          ctx,
          schema,
          { objectType: "company", data: { name } },
          links,
        ),
      );
    const [root, dependent, grandchild, survivor] = await Promise.all([
      make("root"),
      make("dependent"),
      make("grandchild"),
      make("survivor"),
    ]);
    if (
      root === undefined ||
      dependent === undefined ||
      grandchild === undefined ||
      survivor === undefined
    )
      throw new Error("fixtures missing");
    const first = await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "cascade_any",
        fromRecordId: dependent.record.id,
        toRecordId: root.record.id,
      }),
    );
    const second = await db.$transaction((tx) =>
      linkRecords(tx, ctx, schema, {
        relationType: "cascade_any",
        fromRecordId: grandchild.record.id,
        toRecordId: dependent.record.id,
      }),
    );
    const current = await db.record.findFirstOrThrow({
      where: { id: root.record.id },
      select: { version: true },
    });
    const deleted = await db.$transaction((tx) =>
      deleteRecord(tx, ctx, schema, root.record.id, current.version, links),
    );
    const ended = deleted.changes.filter((change) => change.kind === "unlink");
    expect(new Set(ended.map((change) => change.recordId))).toEqual(
      new Set([root.record.id, dependent.record.id, grandchild.record.id]),
    );
    expect(new Set(ended.map((change) => change.groupId)).size).toBe(1);
    expect(
      new Set(
        ended.map((change) => `${change.recordId}:${change.resultingVersion}`),
      ).size,
    ).toBe(3);
    expect(
      await db.record.count({
        where: {
          organizationId: tenant.organizationId,
          teamId: tenant.teamId,
          id: { in: [dependent.record.id, grandchild.record.id] },
          deletedAt: { not: null },
        },
      }),
    ).toBe(2);
    expect(
      await db.record.findFirstOrThrow({
        where: { id: survivor.record.id },
        select: { deletedAt: true },
      }),
    ).toEqual({ deletedAt: null });
    const restored = await db.$transaction((tx) =>
      restoreRecord(
        tx,
        ctx,
        schema,
        root.record.id,
        deleted.record.version,
        links,
      ),
    );
    const reopened = restored.changes.filter(
      (change) => change.kind === "link",
    );
    expect(new Set(reopened.map((change) => change.recordId))).toEqual(
      new Set([root.record.id, dependent.record.id, grandchild.record.id]),
    );
    expect(new Set(reopened.map((change) => change.groupId)).size).toBe(1);
    expect(
      await db.recordLink.count({
        where: {
          organizationId: tenant.organizationId,
          teamId: tenant.teamId,
          id: { in: [first.link.id, second.link.id] },
          activeUntil: null,
        },
      }),
    ).toBe(2);
  });

  it("cascades through a backing link and restores the exact link row in place", async () => {
    const { tenant, ctx, schema } = await setup();
    const links = createProjectionLinkWriter();
    const company = await db.$transaction((tx) =>
      createRecord(
        tx,
        ctx,
        schema,
        { objectType: "company", data: { name: "Engine Co" } },
        links,
      ),
    );
    const person = await db.$transaction((tx) =>
      createRecord(
        tx,
        ctx,
        schema,
        {
          objectType: "person",
          data: { name: { full: "Ada" }, company: company.record.id },
        },
        links,
      ),
    );
    const original = await db.recordLink.findFirstOrThrow({
      where: {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        fromRecordId: person.record.id,
        toRecordId: company.record.id,
        activeUntil: null,
      },
    });
    const currentCompany = await db.record.findFirstOrThrow({
      where: { id: company.record.id },
      select: { version: true },
    });
    const deleted = await db.$transaction((tx) =>
      deleteRecord(
        tx,
        ctx,
        schema,
        company.record.id,
        currentCompany.version,
        links,
      ),
    );
    const cascade = await db.record.findFirstOrThrow({
      where: { id: person.record.id },
      select: { deletedAt: true },
    });
    expect(cascade.deletedAt).not.toBeNull();
    const deletion = await db.recordChange.findFirstOrThrow({
      where: {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        recordId: company.record.id,
        kind: "delete",
      },
      select: { snapshot: true },
    });
    expect(deletion.snapshot).toMatchObject({
      links: [expect.objectContaining({ id: original.id, data: {} })],
      cascaded: [expect.objectContaining({ record_id: person.record.id })],
    });
    await db.$transaction((tx) =>
      restoreRecord(
        tx,
        ctx,
        schema,
        company.record.id,
        deleted.record.version,
        links,
      ),
    );
    const restored = await db.recordLink.findFirstOrThrow({
      where: { id: original.id },
      select: { activeUntil: true, data: true, position: true },
    });
    expect(restored).toEqual({ activeUntil: null, data: {}, position: null });
  });
});
