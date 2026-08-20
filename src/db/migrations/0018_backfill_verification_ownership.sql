-- Legacy verifier rows used random UUIDs and always accompanied an imported ->
-- verified promotion. Deterministic source-ingestion rows use the
-- `verification-` prefix and may merely corroborate an already verified bottle,
-- so leave their default ownership marker unchanged.
UPDATE "bottle_verifications"
SET "promoted_bottle" = true
WHERE "promoted_bottle" = false
  AND "id" NOT LIKE 'verification-%';
