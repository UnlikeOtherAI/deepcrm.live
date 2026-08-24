import { Prisma, tenantWhere } from "@deepcrm/db";
import { ErrorCode, ServiceError, type ActorContext } from "@deepcrm/schemas";
import { attributeTypes } from "../attribute-types/index.js";
import type { ChangeIntent } from "../records/changes.js";
import { canonicalJsonValue, type JsonValue } from "../records/json.js";
import { lockLinkTopology, lockRecords } from "../records/locks.js";
import type { LoadedRelationType, LoadedSchema } from "../schema/load.js";
import type { RecordTx } from "../schema/tx.js";
import type { LinkInput, LinkOperationResult } from "./types.js";
import type { ResolvedLinkOperationHandler } from "./types.js";
type ActiveRecord = {
  id: string; objectTypeId: string; version: number; deletedAt: Date | null; mergedIntoId: string | null
};
type ActiveLink = { id: string; fromRecordId: string; toRecordId: string; position: number | null; data: unknown }

function relation(schema: LoadedSchema, slug: string): LoadedRelationType {
  const found = schema.relationTypesBySlug.get(slug);
  if (found === undefined || found.archivedAt !== null)
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, "Relation type is not active");
  return found;
}

function inputData(
  value: Record<string, unknown> | undefined,
  relationType: LoadedRelationType,
): { [key: string]: JsonValue } {
  const raw = value ?? {};
  const parsed = canonicalJsonValue(raw);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, "Invalid link data", {
      issues: [{ path: "/data", message: "Invalid link data" }],
    });
  }
  const specs = canonicalJsonValue(relationType.edgeAttributes);
  if (!Array.isArray(specs))
    throw new ServiceError(
      ErrorCode.SCHEMA_CONFLICT,
      "Relation edge attributes are invalid",
    );
  const result: Record<string, JsonValue> = {};
  for (const spec of specs) {
    if (spec === null || Array.isArray(spec) || typeof spec !== "object")
      throw new ServiceError(
        ErrorCode.SCHEMA_CONFLICT,
        "Relation edge attributes are invalid",
      );
    const slug = spec.slug;
    const type = spec.type;
    if (typeof slug !== "string" || typeof type !== "string")
      throw new ServiceError(
        ErrorCode.SCHEMA_CONFLICT,
        "Relation edge attributes are invalid",
      );
    const supplied = parsed[slug];
    if (supplied === undefined) {
      if (spec.is_required === true)
        throw new ServiceError(
          ErrorCode.VALIDATION_FAILED,
          "Invalid link data",
          { issues: [{ path: `/data/${slug}`, message: "Invalid link data" }] },
        );
      continue;
    }
    try {
      const definition = Object.entries(attributeTypes).find(
        ([name]) => name === type,
      )?.[1];
      if (definition === undefined) throw new Error("unknown edge type");
      const rawConfig = spec.config;
      if (
        rawConfig !== undefined &&
        (rawConfig === null ||
          Array.isArray(rawConfig) ||
          typeof rawConfig !== "object")
      )
        throw new Error("invalid edge config");
      const config = Object.fromEntries(
        Object.entries(rawConfig ?? {}).filter(([key]) => key !== "type"),
      );
      const valueSchema = definition.valueSchema(config);
      const valid = valueSchema.safeParse(supplied);
      if (!valid.success) throw new Error("invalid");
      result[slug] = canonicalJsonValue(valid.data);
    } catch {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, "Invalid link data", {
        issues: [{ path: `/data/${slug}`, message: "Invalid link data" }],
      });
    }
  }
  for (const key of Object.keys(parsed)) {
    if (
      !Object.hasOwn(result, key) &&
      !specs.some(
        (spec) =>
          spec !== null &&
          !Array.isArray(spec) &&
          typeof spec === "object" &&
          spec.slug === key,
      )
    ) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, "Invalid link data", {
        issues: [{ path: `/data/${key}`, message: "Unknown edge attribute" }],
      });
    }
  }
  return result;
}

function prismaJson(value: JsonValue): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(prismaJson);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, prismaJson(child)]),
    );
  }
  return value;
}

function prismaObject(value: {
  [key: string]: JsonValue;
}): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, prismaJson(child)]),
  );
}

async function live(
  tx: RecordTx,
  ctx: ActorContext,
  id: string,
): Promise<ActiveRecord> {
  const found = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id },
    select: {
      id: true,
      objectTypeId: true,
      version: true,
      deletedAt: true,
      mergedIntoId: true,
    },
  });
  if (found === null || found.deletedAt !== null)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
  if (found.mergedIntoId !== null)
    throw new ServiceError(ErrorCode.MERGED, "Record has been merged", {
      redirect_to: found.mergedIntoId,
    });
  return found;
}

function compatible(
  relationType: LoadedRelationType,
  from: ActiveRecord,
  to: ActiveRecord,
): void {
  if (
    relationType.fromObjectTypeId !== null &&
    relationType.fromObjectTypeId !== from.objectTypeId
  )
    throw new ServiceError(
      ErrorCode.VALIDATION_FAILED,
      "Invalid relation endpoint",
    );
  if (
    relationType.toObjectTypeId !== null &&
    relationType.toObjectTypeId !== to.objectTypeId
  )
    throw new ServiceError(
      ErrorCode.VALIDATION_FAILED,
      "Invalid relation endpoint",
    );
}

function change(
  recordId: string,
  kind: "link" | "unlink",
  relationTypeId: string,
  linkId: string,
  groupId: string,
  version: number,
  oldValue: JsonValue | null,
  newValue: JsonValue | null,
): ChangeIntent {
  return {
    recordId,
    kind,
    attributeSlug: null,
    relationTypeId,
    linkId,
    groupId,
    oldValue,
    newValue,
    snapshot: null,
    resultingVersion: version,
    reason: null,
  };
}

async function endLinks(
  tx: RecordTx,
  ctx: ActorContext,
  links: readonly ActiveLink[],
): Promise<readonly string[]> {
  if (links.length === 0) return [];
  const ids = links.map((link) => link.id).sort();
  await tx.recordLink.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: ids }, activeUntil: null },
    data: { activeUntil: ctx.now },
  });
  return ids;
}

async function bumpVersions(
  tx: RecordTx,
  ctx: ActorContext,
  endpoints: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const versions = new Map<string, number>();
  for (const id of endpoints) {
    const updated = await tx.record.updateMany({
      where: { ...tenantWhere(ctx.tenant), id, deletedAt: null },
      data: { version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
    const row = await tx.record.findFirst({
      where: { ...tenantWhere(ctx.tenant), id },
      select: { version: true },
    });
    if (row === null)
      throw new ServiceError(ErrorCode.NOT_FOUND, "Record not found");
    versions.set(id, row.version);
  }
  return versions;
}

function unlinkChanges(
  links: readonly ActiveLink[],
  relationType: LoadedRelationType,
  versions: ReadonlyMap<string, number>,
): ChangeIntent[] {
  const changes: ChangeIntent[] = [];
  const groupId = crypto.randomUUID();
  for (const link of links) {
    const oldValue = canonicalJsonValue({
      from_record_id: link.fromRecordId,
      to_record_id: link.toRecordId,
      data: link.data,
      position: link.position,
    });
    const fromVersion = versions.get(link.fromRecordId);
    const toVersion = versions.get(link.toRecordId);
    if (fromVersion === undefined || toVersion === undefined)
      throw new ServiceError(ErrorCode.INTERNAL, "Endpoint version is missing");
    changes.push(
      change(
        link.fromRecordId,
        "unlink",
        relationType.id,
        link.id,
        groupId,
        fromVersion,
        oldValue,
        null,
      ),
    );
    changes.push(
      change(
        link.toRecordId,
        "unlink",
        relationType.id,
        link.id,
        groupId,
        toVersion,
        oldValue,
        null,
      ),
    );
  }
  return changes;
}

export async function linkRecords(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  input: LinkInput,
  onResolved?: ResolvedLinkOperationHandler,
): Promise<LinkOperationResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId);
  const relationType = relation(schema, input.relationType);
  if (input.fromRecordId === input.toRecordId)
    throw new ServiceError(
      ErrorCode.VALIDATION_FAILED,
      "A record cannot link to itself",
    );
  const query = {
    where: {
      ...tenantWhere(ctx.tenant),
      relationTypeId: relationType.id,
      activeUntil: null,
      OR: [
        {
          fromRecordId: input.fromRecordId,
          toRecordId: input.toRecordId,
        },
        ...(relationType.cardinality === "many_to_one" ||
        relationType.cardinality === "one_to_one"
          ? [{ fromRecordId: input.fromRecordId }]
          : []),
        ...(relationType.cardinality === "one_to_many" ||
        relationType.cardinality === "one_to_one"
          ? [{ toRecordId: input.toRecordId }]
          : []),
      ],
    },
    select: {
      id: true,
      fromRecordId: true,
      toRecordId: true,
      position: true,
      data: true,
    },
    orderBy: { id: "asc" as const },
  };
  const preliminary = await tx.recordLink.findMany(query);
  await lockRecords(tx, ctx.tenant.teamId, [
    input.fromRecordId,
    input.toRecordId,
    ...preliminary.flatMap((item) => [item.fromRecordId, item.toRecordId]),
  ]);
  const [from, to, discoveredConflicts] = await Promise.all([
    live(tx, ctx, input.fromRecordId),
    live(tx, ctx, input.toRecordId),
    tx.recordLink.findMany(query),
  ]);
  await lockRecords(tx, ctx.tenant.teamId, discoveredConflicts.flatMap((item) => [
    item.fromRecordId,
    item.toRecordId,
  ]));
  const conflicts = await tx.recordLink.findMany(query);
  compatible(relationType, from, to);
  const data = inputData(input.data, relationType);
  if (onResolved !== undefined)
    await onResolved({
      relationTypeId: relationType.id,
      endpointRecordIds: [
        ...new Set([
          from.id,
          to.id,
          ...conflicts.flatMap((item) => [item.fromRecordId, item.toRecordId]),
        ]),
      ].sort(),
      conflictLinkIds: conflicts.map((item) => item.id).sort(),
    });
  const retained = conflicts.filter(
    (item) => item.fromRecordId === from.id && item.toRecordId === to.id,
  );
  if (retained.length > 0) {
    const current = retained[0];
    if (current === undefined)
      throw new ServiceError(ErrorCode.INTERNAL, "Active link is missing");
    return {
      link: {
        id: current.id,
        relationTypeId: relationType.id,
        fromRecordId: from.id,
        toRecordId: to.id,
      },
      endedLinks: [],
      changes: [],
      touchedRecordIds: [],
    };
  }
  const ended = await endLinks(tx, ctx, conflicts);
  const created = await tx.recordLink.create({
    data: {
      ...tenantWhere(ctx.tenant),
      relationTypeId: relationType.id,
      fromRecordId: from.id,
      toRecordId: to.id,
      data: prismaObject(data),
      label: input.label ?? null,
      position: null,
      createdByType: ctx.actor.type,
      createdById: ctx.actor.id,
    },
  });
  const endpoints = [
    ...new Set([
      from.id,
      to.id,
      ...conflicts.flatMap((item) => [item.fromRecordId, item.toRecordId]),
    ]),
  ].sort();
  const versions = await bumpVersions(tx, ctx, endpoints);
  const groupId = crypto.randomUUID();
  const linkValue = canonicalJsonValue({
    from_record_id: from.id,
    to_record_id: to.id,
    data,
    position: null,
  });
  const fromVersion = versions.get(from.id);
  const toVersion = versions.get(to.id);
  if (fromVersion === undefined || toVersion === undefined)
    throw new ServiceError(ErrorCode.INTERNAL, "Endpoint version is missing");
  return {
    link: {
      id: created.id,
      relationTypeId: relationType.id,
      fromRecordId: from.id,
      toRecordId: to.id,
    },
    endedLinks: ended,
    changes: [
      ...unlinkChanges(conflicts, relationType, versions),
      change(
        from.id,
        "link",
        relationType.id,
        created.id,
        groupId,
        fromVersion,
        null,
        linkValue,
      ),
      change(
        to.id,
        "link",
        relationType.id,
        created.id,
        groupId,
        toVersion,
        null,
        linkValue,
      ),
    ],
    touchedRecordIds: endpoints,
  };
}

export async function unlinkRecords(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  relationSlug: string,
  fromRecordId: string,
  toRecordId: string,
  onResolved?: ResolvedLinkOperationHandler,
): Promise<LinkOperationResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId);
  const relationType = relation(schema, relationSlug);
  await lockRecords(tx, ctx.tenant.teamId, [fromRecordId, toRecordId]);
  const links = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      relationTypeId: relationType.id,
      fromRecordId,
      toRecordId,
      activeUntil: null,
    },
    select: {
      id: true,
      fromRecordId: true,
      toRecordId: true,
      position: true,
      data: true,
    },
  });
  if (links.length === 0)
    throw new ServiceError(ErrorCode.NOT_FOUND, "Active link not found");
  if (onResolved !== undefined)
    await onResolved({
      relationTypeId: relationType.id,
      endpointRecordIds: [fromRecordId, toRecordId].sort(),
      conflictLinkIds: links.map((link) => link.id).sort(),
    });
  const endpoints = [
    ...new Set(links.flatMap((link) => [link.fromRecordId, link.toRecordId])),
  ].sort();
  const ended = await endLinks(tx, ctx, links);
  const versions = await bumpVersions(tx, ctx, endpoints);
  const first = links[0];
  if (first === undefined)
    throw new ServiceError(ErrorCode.INTERNAL, "Active link is missing");
  return {
    link: {
      id: first.id,
      relationTypeId: relationType.id,
      fromRecordId,
      toRecordId,
    },
    endedLinks: ended,
    changes: unlinkChanges(links, relationType, versions),
    touchedRecordIds: endpoints,
  };
}
