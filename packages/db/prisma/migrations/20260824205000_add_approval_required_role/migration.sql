ALTER TABLE "approval_requests"
  ADD COLUMN "required_role" TEXT NOT NULL DEFAULT 'admin';

ALTER TABLE "approval_requests"
  ALTER COLUMN "required_role" DROP DEFAULT;
