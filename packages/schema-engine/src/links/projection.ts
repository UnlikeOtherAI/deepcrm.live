import { tenantWhere } from "@deepcrm/db";
import { ErrorCode, ServiceError, type ActorContext } from "@deepcrm/schemas";

import type { ChangeIntent } from "../records/changes.js";
import { canonicalJsonValue, type JsonValue } from "../records/json.js";
import { lockLinkTopology, lockRecords } from "../records/locks.js";
import type { LinkIntent } from "../records/types.js";
import type { LinkWriteResult, LinkWriter } from "../records/write.js";
import type { LoadedRelationType, LoadedSchema } from "../schema/load.js";
import type { RecordTx } from "../schema/tx.js";
import { enforceRelationEdgeLimits } from "./edge-limits.js";
import { deleteLinks, restoreLinks } from "./projection-lifecycle.js";

export type ActiveLink = {
  id: string;
  fromRecordId: string;
  toRecordId: string;
  position: number | null;
  data: unknown;
};

export function relation(schema: LoadedSchema, id: string): LoadedRelationType {
  const found = schema.relationTypesById.get(id);
  if (found === undefined || found.archivedAt !== null)
    throw new ServiceError(
      ErrorCode.SCHEMA_CONFLICT,
      "Relation type is not active",
    );
  return found;
}

async function target(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  id: string,
  allowed: LoadedRelationType,
): Promise<void> {
  const record = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id },
    select: {
      id: true,
      objectTypeId: true,
      deletedAt: true,
      mergedIntoId: true,
    },
  });
  if (record === null || record.deletedAt !== null)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Reference target not found");
  if (record.mergedIntoId !== null)
    throw new ServiceError(
      ErrorCode.MERGED,
      "Reference target has been merged",
      { redirect_to: record.mergedIntoId },
    );
  if (
    allowed.toObjectTypeId !== null &&
    allowed.toObjectTypeId !== record.objectTypeId
  )
    throw new ServiceError(
      ErrorCode.VALIDATION_FAILED,
      "Reference target type is invalid",
    );
  if (
    allowed.fromObjectTypeId !== null &&
    allowed.projectionAttributeSlug !== null
  ) {
    const attribute = schema.attributesByObjectTypeId
      .get(allowed.fromObjectTypeId)
      ?.get(allowed.projectionAttributeSlug);
    const config = attribute?.config;
    const permitted =
      config !== null && typeof config === "object" && !Array.isArray(config)
        ? config["objectTypes"]
        : undefined;
    const objectType = schema.objectTypesById.get(record.objectTypeId);
    if (
      !Array.isArray(permitted) ||
      objectType === undefined ||
      !permitted.includes(objectType.slug)
    ) {
      throw new ServiceError(
        ErrorCode.VALIDATION_FAILED,
        "Reference target type is invalid",
      );
    }
  }
}

export async function version(
  tx: RecordTx,
  ctx: ActorContext,
  id: string,
): Promise<number> {
  const updated = await tx.record.updateMany({
    where: { ...tenantWhere(ctx.tenant), id, deletedAt: null },
    data: { version: { increment: 1 } },
  });
  if (updated.count !== 1)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
  const record = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id },
    select: { version: true },
  });
  if (record === null)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
  return record.version;
}

export function intentChange(
  recordId: string,
  kind: "link" | "unlink",
  relationTypeId: string,
  link: ActiveLink,
  versionNumber: number,
  groupId: string,
): ChangeIntent {
  const value = canonicalJsonValue({
    from_record_id: link.fromRecordId,
    to_record_id: link.toRecordId,
    data: link.data,
    position: link.position,
  });
  return {
    recordId,
    kind,
    attributeSlug: null,
    relationTypeId,
    linkId: link.id,
    groupId,
    oldValue: kind === "unlink" ? value : null,
    newValue: kind === "link" ? value : null,
    snapshot: null,
    resultingVersion: versionNumber,
    reason: null,
  };
}

async function project(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
  operation: LinkIntent,
): Promise<LinkWriteResult> {
  const relationType = relation(schema, operation.relationTypeId);
  await lockLinkTopology(tx, ctx.tenant.teamId);
  const activeWhere = {
    ...tenantWhere(ctx.tenant),
    relationTypeId: relationType.id,
    fromRecordId: recordId,
    activeUntil: null,
  };
  const preliminary = await tx.recordLink.findMany({
    where: activeWhere,
    select: { fromRecordId: true, toRecordId: true },
  });
  await lockRecords(tx, ctx.tenant.teamId, [
    recordId,
    ...operation.targetIds,
    ...preliminary.flatMap((link) => [link.fromRecordId, link.toRecordId]),
  ]);
  let active = await tx.recordLink.findMany({
    where: {
      ...activeWhere,
    },
    select: {
      id: true,
      fromRecordId: true,
      toRecordId: true,
      position: true,
      data: true,
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  await lockRecords(
    tx,
    ctx.tenant.teamId,
    active.flatMap((link) => [link.fromRecordId, link.toRecordId]),
  );
  active = await tx.recordLink.findMany({
    where: activeWhere,
    select: {
      id: true,
      fromRecordId: true,
      toRecordId: true,
      position: true,
      data: true,
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const existing = new Map(active.map((link) => [link.toRecordId, link]));
  for (const id of operation.targetIds)
    await target(tx, ctx, schema, id, relationType);
  const desired = new Set(operation.targetIds);
  const ending = active.filter((link) => !desired.has(link.toRecordId));
  if (ending.length > 0)
    await tx.recordLink.updateMany({
      where: {
        ...tenantWhere(ctx.tenant),
        id: { in: ending.map((link) => link.id) },
        activeUntil: null,
      },
      data: { activeUntil: ctx.now },
    });
  const changes: ChangeIntent[] = [];
  const touched = new Set<string>();
  const source = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId },
    select: { version: true },
  });
  if (source === null)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
  for (const link of ending) {
    const targetVersion = await version(tx, ctx, link.toRecordId);
    const groupId = crypto.randomUUID();
    changes.push(
      intentChange(
        recordId,
        "unlink",
        relationType.id,
        link,
        source.version,
        groupId,
      ),
    );
    changes.push(
      intentChange(
        link.toRecordId,
        "unlink",
        relationType.id,
        link,
        targetVersion,
        groupId,
      ),
    );
    touched.add(link.toRecordId);
    touched.add(recordId);
  }
  const moving = active.filter((link) => {
    const next = operation.targetIds.indexOf(link.toRecordId);
    return next >= 0 && link.position !== next;
  });
  for (const [index, link] of moving.entries()) {
    await tx.recordLink.updateMany({
      where: { ...tenantWhere(ctx.tenant), id: link.id, activeUntil: null },
      data: { position: -1 - index },
    });
  }
  for (const [position, targetId] of operation.targetIds.entries()) {
    const present = existing.get(targetId);
    if (present !== undefined) {
      if (
        operation.cardinality === "many_to_many" &&
        present.position !== position
      ) {
        await tx.recordLink.updateMany({
          where: {
            ...tenantWhere(ctx.tenant),
            id: present.id,
            activeUntil: null,
          },
          data: { position },
        });
        const targetVersion = await version(tx, ctx, targetId);
        const groupId = crypto.randomUUID();
        const moved = { ...present, position };
        changes.push(
          intentChange(
            recordId,
            "unlink",
            relationType.id,
            present,
            source.version,
            groupId,
          ),
        );
        changes.push(
          intentChange(
            targetId,
            "unlink",
            relationType.id,
            present,
            targetVersion,
            groupId,
          ),
        );
        changes.push(
          intentChange(
            recordId,
            "link",
            relationType.id,
            moved,
            source.version,
            groupId,
          ),
        );
        changes.push(
          intentChange(
            targetId,
            "link",
            relationType.id,
            moved,
            targetVersion,
            groupId,
          ),
        );
        touched.add(recordId);
        touched.add(targetId);
      }
      continue;
    }
    await enforceRelationEdgeLimits(tx, ctx, relationType, recordId, targetId, null);
    const created = await tx.recordLink.create({
      data: {
        ...tenantWhere(ctx.tenant),
        relationTypeId: relationType.id,
        fromRecordId: recordId,
        toRecordId: targetId,
        data: {},
        position: operation.cardinality === "many_to_many" ? position : null,
        createdByType: ctx.actor.type,
        createdById: ctx.actor.id,
      },
    });
    const link: ActiveLink = {
      id: created.id,
      fromRecordId: recordId,
      toRecordId: targetId,
      position: created.position,
      data: created.data,
    };
    const targetVersion = await version(tx, ctx, targetId);
    const groupId = crypto.randomUUID();
    changes.push(
      intentChange(
        recordId,
        "link",
        relationType.id,
        link,
        source.version,
        groupId,
      ),
    );
    changes.push(
      intentChange(
        targetId,
        "link",
        relationType.id,
        link,
        targetVersion,
        groupId,
      ),
    );
    touched.add(targetId);
    touched.add(recordId);
  }
  return { changes, touchedRecordIds: [...touched].sort() };
}

export function createProjectionLinkWriter(): LinkWriter {
  return {
    apply: async (tx, ctx, schema, recordId, operations) => {
      const results: LinkWriteResult[] = [];
      for (const operation of operations)
        results.push(await project(tx, ctx, schema, recordId, operation));
      return {
        changes: results.flatMap((result) => result.changes),
        touchedRecordIds: [
          ...new Set(results.flatMap((result) => result.touchedRecordIds)),
        ].sort(),
      };
    },
    delete: deleteLinks,
    restore: restoreLinks,
  };
}

export function projectLinksIntoData(
  schema: LoadedSchema,
  objectTypeSlug: string,
  links: readonly {
    relationTypeId: string;
    toRecordId: string;
    position: number | null;
  }[],
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const relationType of schema.relationTypes) {
    if (
      relationType.fromObjectTypeId === null ||
      relationType.projectionAttributeSlug === null
    )
      continue;
    const objectType = schema.objectTypesBySlug.get(objectTypeSlug);
    if (
      objectType === undefined ||
      relationType.fromObjectTypeId !== objectType.id
    )
      continue;
    const values = links
      .filter((link) => link.relationTypeId === relationType.id)
      .sort((left, right) => (left.position ?? -1) - (right.position ?? -1))
      .map((link) => link.toRecordId);
    if (values.length === 0) continue;
    if (relationType.cardinality === "many_to_many")
      result[relationType.projectionAttributeSlug] = values;
    else {
      const first = values[0];
      if (first !== undefined)
        result[relationType.projectionAttributeSlug] = first;
    }
  }
  return result;
}
