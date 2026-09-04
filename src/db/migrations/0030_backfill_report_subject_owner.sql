-- Backfill reports.subject_owner_id for rows filed before 0029 added it.
--
-- The column exists so a report can still be claimed after its subject is
-- gone: deletePour is a hard delete, and deriving the owner from the live
-- subject fails once there is nothing to derive it from — which made deleting
-- the evidence a way to keep a complaint permanently unresolvable. Rows filed
-- before the column existed carry null and fall back to that derivation, so
-- the guarantee held only for reports filed after this deployment.
--
-- Derived now, while the subjects are still there. This cannot be done later:
-- the moment a subject is hard-deleted its owner is unrecoverable, so the
-- backfill has to run at deploy rather than lazily when the queue is worked.
-- A report whose subject is already gone stays null and stays as unresolvable
-- as it was; nothing can recover what was not recorded.
--
-- Statement-breakpoint separated for the runner, and idempotent: only rows
-- with no recorded owner are touched, so a re-run is a no-op and a recorded
-- owner is never overwritten by a later re-derivation.

UPDATE "reports" SET "subject_owner_id" = "subject_id"
  WHERE "subject_owner_id" IS NULL AND "subject_type" = 'profile';
--> statement-breakpoint
UPDATE "reports" AS r SET "subject_owner_id" = p."user_id"
  FROM "pours" AS p
  WHERE r."subject_owner_id" IS NULL AND r."subject_type" = 'pour' AND p."id" = r."subject_id";
--> statement-breakpoint
UPDATE "reports" AS r SET "subject_owner_id" = c."user_id"
  FROM "comments" AS c
  WHERE r."subject_owner_id" IS NULL AND r."subject_type" = 'comment' AND c."id" = r."subject_id";
