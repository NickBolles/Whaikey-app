-- Backfill reports.subject_owner_id for rows filed before 0029 added it.
--
-- The column exists so a report can still be claimed after its subject is
-- gone: deletePour is a hard delete, and deriving the owner from the live
-- subject fails once there is nothing to derive it from — which made deleting
-- the evidence a way to keep a complaint permanently unresolvable. Rows filed
-- before the column existed carry null and fall back to that derivation, so
-- the guarantee held only for reports filed after this deployment.
--
-- Derived now, while the subjects are still there. A report whose subject is
-- already gone stays null and stays as unresolvable as it was; nothing can
-- recover what was not recorded.
--
-- An earlier version of this comment said the backfill "cannot be done later",
-- and that sentence is what hid a gap. It is only true once the subject is
-- gone: while it is alive the owner is derivable at any time, and the LAST
-- such moment is the delete itself. `deletePour` now records it there, in the
-- same transaction as the delete, which is what makes this migration a
-- backfill of existing rows rather than the only guarantee.
--
-- That matters because a one-time migration cannot cover writes that happen
-- after it runs, and `scripts/build.mjs` applies migrations BEFORE `next
-- build`: the previous deployment keeps serving for the length of a build, and
-- every report it files carries a null owner this UPDATE will never revisit.
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
