CREATE UNLOGGED TABLE "seen_request_ids" (
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "app" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args_sha256" TEXT NOT NULL,
    "seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "seen_request_ids_pkey" PRIMARY KEY ("team_id", "request_id")
);

CREATE INDEX "seen_request_ids_expires_at_idx" ON "seen_request_ids" ("expires_at");
CREATE INDEX "seen_request_ids_tenant_tool_idx" ON "seen_request_ids" ("organization_id", "team_id", "tool");

CREATE TABLE "principal_token_versions" (
    "uoa_user_id" TEXT NOT NULL,
    "token_version" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "principal_token_versions_pkey" PRIMARY KEY ("uoa_user_id")
);
