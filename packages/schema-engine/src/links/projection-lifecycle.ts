import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { ChangeIntent } from '../records/changes.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockRecords } from '../records/locks.js'
import type { LinkWriteResult } from '../records/write.js'
import type { LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'
import { intentChange, relation, type ActiveLink, version } from './projection.js'

export async function deleteLinks(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
): Promise<LinkWriteResult> {
  void schema;
  const links = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      activeUntil: null,
      OR: [{ fromRecordId: recordId }, { toRecordId: recordId }],
    },
    select: {
      id: true,
      relationTypeId: true,
      fromRecordId: true,
      toRecordId: true,
      position: true,
      data: true,
      label: true,
    },
  });
  for (const link of links) {
    const relationType = relation(schema, link.relationTypeId);
    if (relationType.onDelete === "restrict")
      throw new ServiceError(
        ErrorCode.DELETE_RESTRICTED,
        "Record has restricted links",
        { link_id: link.id },
      );
  }
  const cascaded = new Set<string>();
  const pending = links
    .filter(
      (link) =>
        relation(schema, link.relationTypeId).onDelete === "cascade" &&
        link.toRecordId === recordId,
    )
    .map((link) => link.fromRecordId);
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (
      candidate === undefined ||
      candidate === recordId ||
      cascaded.has(candidate)
    )
      continue;
    cascaded.add(candidate);
    const dependentLinks = await tx.recordLink.findMany({
      where: {
        ...tenantWhere(ctx.tenant),
        toRecordId: candidate,
        activeUntil: null,
      },
      select: { fromRecordId: true, relationTypeId: true },
    });
    for (const dependent of dependentLinks) {
      if (relation(schema, dependent.relationTypeId).onDelete === "cascade")
        pending.push(dependent.fromRecordId);
    }
  }
  const cascadeIds = [...cascaded].sort();
  await lockRecords(tx, ctx.tenant.teamId, [recordId, ...cascadeIds]);
  const cascadeRows =
    cascadeIds.length === 0
      ? []
      : await tx.record.findMany({
          where: {
            ...tenantWhere(ctx.tenant),
            id: { in: cascadeIds },
            deletedAt: null,
          },
          select: { id: true, version: true },
        });
  const closureIds = [recordId, ...cascadeRows.map((row) => row.id)];
  let closureLinks = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      activeUntil: null,
      OR: [
        { fromRecordId: { in: closureIds } },
        { toRecordId: { in: closureIds } },
      ],
    },
    select: {
      id: true,
      relationTypeId: true,
      fromRecordId: true,
      toRecordId: true,
      position: true,
      data: true,
      label: true,
    },
  });
  await lockRecords(
    tx,
    ctx.tenant.teamId,
    closureLinks.flatMap((link) => [link.fromRecordId, link.toRecordId]),
  );
  closureLinks = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      activeUntil: null,
      OR: [
        { fromRecordId: { in: closureIds } },
        { toRecordId: { in: closureIds } },
      ],
    },
    select: {
      id: true,
      relationTypeId: true,
      fromRecordId: true,
      toRecordId: true,
      position: true,
      data: true,
      label: true,
    },
  });
  for (const link of closureLinks) {
    if (relation(schema, link.relationTypeId).onDelete === "restrict")
      throw new ServiceError(
        ErrorCode.DELETE_RESTRICTED,
        "Record has restricted links",
        { link_id: link.id },
      );
  }
  if (closureLinks.length === 0)
    return {
      changes: [],
      touchedRecordIds: [],
      snapshot: canonicalJsonValue({ links: [] }),
    };
  await tx.recordLink.updateMany({
    where: {
      ...tenantWhere(ctx.tenant),
      id: { in: closureLinks.map((link) => link.id) },
      activeUntil: null,
    },
    data: { activeUntil: ctx.now },
  });
  const cascadeGroupId = crypto.randomUUID();
  for (const row of cascadeRows) {
    await tx.record.updateMany({
      where: { ...tenantWhere(ctx.tenant), id: row.id, deletedAt: null },
      data: { deletedAt: ctx.now, version: { increment: 1 } },
    });
  }
  const source = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId },
    select: { version: true },
  });
  if (source === null)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
  const changes: ChangeIntent[] = [];
  const touched = new Set<string>([recordId]);
  for (const row of cascadeRows) {
    changes.push({
      recordId: row.id,
      kind: "delete",
      attributeSlug: null,
      relationTypeId: null,
      linkId: null,
      groupId: cascadeGroupId,
      oldValue: null,
      newValue: null,
      snapshot: null,
      resultingVersion: row.version + 1,
      reason: null,
    });
    touched.add(row.id);
  }
  const versions = new Map<string, number>([[recordId, source.version + 1]]);
  for (const row of cascadeRows) versions.set(row.id, row.version + 1);
  const internal = new Set(versions.keys());
  const external = [
    ...new Set(
      closureLinks
        .flatMap((link) => [link.fromRecordId, link.toRecordId])
        .filter((id) => !internal.has(id)),
    ),
  ].sort();
  for (const id of external) versions.set(id, await version(tx, ctx, id));
  for (const link of closureLinks) {
    const fromVersion = versions.get(link.fromRecordId);
    const toVersion = versions.get(link.toRecordId);
    if (fromVersion === undefined || toVersion === undefined)
      throw new ServiceError(ErrorCode.INTERNAL, "Endpoint version is missing");
    changes.push(
      intentChange(
        link.fromRecordId,
        "unlink",
        link.relationTypeId,
        link,
        fromVersion,
        cascadeGroupId,
      ),
    );
    changes.push(
      intentChange(
        link.toRecordId,
        "unlink",
        link.relationTypeId,
        link,
        toVersion,
        cascadeGroupId,
      ),
    );
    touched.add(link.fromRecordId);
    touched.add(link.toRecordId);
  }
  return {
    changes,
    touchedRecordIds: [...touched].sort(),
    snapshot: canonicalJsonValue({
      links: closureLinks.map((link) => ({
        id: link.id,
        relation_type_id: link.relationTypeId,
        from_record_id: link.fromRecordId,
        to_record_id: link.toRecordId,
        data: link.data,
        position: link.position,
        label: link.label,
      })),
      cascaded: cascadeRows.map((row) => ({
        record_id: row.id,
        pre_version: row.version,
      })),
    }),
  };
}

export async function restoreLinks(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
  snapshot: JsonValue,
): Promise<LinkWriteResult> {
  void schema;
  if (
    snapshot === null ||
    Array.isArray(snapshot) ||
    typeof snapshot !== "object"
  )
    return { changes: [], touchedRecordIds: [] };
  const links = snapshot.links;
  if (!Array.isArray(links)) return { changes: [], touchedRecordIds: [] };
  const rows: Array<
    ActiveLink & { relationTypeId: string; label: string | null }
  > = [];
  const cascadeIds: string[] = [];
  const cascade = snapshot.cascaded;
  if (Array.isArray(cascade))
    for (const item of cascade) {
      if (
        item !== null &&
        !Array.isArray(item) &&
        typeof item === "object" &&
        typeof item.record_id === "string"
      )
        cascadeIds.push(item.record_id);
    }
  for (const item of links) {
    if (item === null || Array.isArray(item) || typeof item !== "object")
      continue;
    if (
      typeof item.id !== "string" ||
      typeof item.relation_type_id !== "string" ||
      typeof item.from_record_id !== "string" ||
      typeof item.to_record_id !== "string"
    )
      continue;
    rows.push({
      id: item.id,
      relationTypeId: item.relation_type_id,
      fromRecordId: item.from_record_id,
      toRecordId: item.to_record_id,
      position: typeof item.position === "number" ? item.position : null,
      data: item.data ?? {},
      label: typeof item.label === "string" ? item.label : null,
    });
  }
  await lockRecords(tx, ctx.tenant.teamId, [
    recordId,
    ...cascadeIds,
    ...rows.flatMap((row) => [row.fromRecordId, row.toRecordId]),
  ]);
  const restoring = new Set([recordId, ...cascadeIds]);
  const externalIds = [
    ...new Set(rows.flatMap((row) => [row.fromRecordId, row.toRecordId]))
      .values(),
  ].filter((id) => !restoring.has(id));
  const externalRecords = await tx.record.findMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: externalIds } },
    select: { id: true, deletedAt: true, mergedIntoId: true },
  });
  if (
    externalRecords.length !== externalIds.length ||
    externalRecords.some((record) => record.deletedAt !== null || record.mergedIntoId !== null)
  ) throw new ServiceError(ErrorCode.RESTORE_CONFLICT, 'Link cannot be restored');
  for (const row of rows) {
    let relationType;
    try {
      relationType = relation(schema, row.relationTypeId);
    } catch {
      throw new ServiceError(ErrorCode.RESTORE_CONFLICT, 'Link cannot be restored');
    }
    const active = await tx.recordLink.findMany({
      where: {
        ...tenantWhere(ctx.tenant),
        relationTypeId: row.relationTypeId,
        activeUntil: null,
        OR: [
          { fromRecordId: row.fromRecordId, toRecordId: row.toRecordId },
          ...(relationType.cardinality === 'many_to_one' || relationType.cardinality === 'one_to_one'
            ? [{ fromRecordId: row.fromRecordId }] : []),
          ...(relationType.cardinality === 'one_to_many' || relationType.cardinality === 'one_to_one'
            ? [{ toRecordId: row.toRecordId }] : []),
          ...(relationType.cardinality === 'many_to_many' && row.position !== null
            ? [{ fromRecordId: row.fromRecordId, position: row.position }] : []),
        ],
      },
      select: { id: true },
    });
    if (active.some((link) => link.id !== row.id))
      throw new ServiceError(
        ErrorCode.RESTORE_CONFLICT,
        "Link cannot be restored",
      );
  }
  for (const row of rows)
    await tx.recordLink.updateMany({
      where: {
        ...tenantWhere(ctx.tenant),
        id: row.id,
        activeUntil: { not: null },
      },
      data: { activeUntil: null },
    });
  const cascadeGroupId = crypto.randomUUID();
  for (const id of [...new Set(cascadeIds)].sort()) {
    const updated = await tx.record.updateMany({
      where: { ...tenantWhere(ctx.tenant), id, deletedAt: { not: null } },
      data: { deletedAt: null, version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new ServiceError(
        ErrorCode.RESTORE_CONFLICT,
        "Cascade record cannot be restored",
      );
  }
  const source = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId },
    select: { version: true },
  });
  if (source === null)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
  const changes: ChangeIntent[] = [];
  const touched = new Set<string>([recordId]);
  for (const id of [...new Set(cascadeIds)].sort()) {
    const restored = await tx.record.findFirst({
      where: { ...tenantWhere(ctx.tenant), id },
      select: { version: true },
    });
    if (restored === null)
      throw new ServiceError(
        ErrorCode.RESTORE_CONFLICT,
        "Cascade record cannot be restored",
      );
    changes.push({
      recordId: id,
      kind: "restore",
      attributeSlug: null,
      relationTypeId: null,
      linkId: null,
      groupId: cascadeGroupId,
      oldValue: null,
      newValue: null,
      snapshot: null,
      resultingVersion: restored.version,
      reason: null,
    });
    touched.add(id);
  }
  const versions = new Map<string, number>([[recordId, source.version]]);
  for (const id of [...new Set(cascadeIds)].sort()) {
    const row = await tx.record.findFirst({
      where: { ...tenantWhere(ctx.tenant), id },
      select: { version: true },
    });
    if (row === null)
      throw new ServiceError(
        ErrorCode.RESTORE_CONFLICT,
        "Cascade record cannot be restored",
      );
    versions.set(id, row.version);
  }
  const internal = new Set(versions.keys());
  const external = [
    ...new Set(
      rows
        .flatMap((row) => [row.fromRecordId, row.toRecordId])
        .filter((id) => !internal.has(id)),
    ),
  ].sort();
  for (const id of external) versions.set(id, await version(tx, ctx, id));
  for (const row of rows) {
    const fromVersion = versions.get(row.fromRecordId);
    const toVersion = versions.get(row.toRecordId);
    if (fromVersion === undefined || toVersion === undefined)
      throw new ServiceError(ErrorCode.INTERNAL, "Endpoint version is missing");
    changes.push(
      intentChange(
        row.fromRecordId,
        "link",
        row.relationTypeId,
        row,
        fromVersion,
        cascadeGroupId,
      ),
    );
    changes.push(
      intentChange(
        row.toRecordId,
        "link",
        row.relationTypeId,
        row,
        toVersion,
        cascadeGroupId,
      ),
    );
    touched.add(row.fromRecordId);
    touched.add(row.toRecordId);
  }
  return { changes, touchedRecordIds: [...touched].sort() };
}
