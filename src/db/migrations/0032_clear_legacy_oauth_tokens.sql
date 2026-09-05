-- Clear provider tokens written before `account.encryptOAuthTokens` was on.
--
-- The option only encrypts tokens written after it — every row already in the
-- table keeps its plaintext `access_token`, `refresh_token` and `id_token`
-- indefinitely, for accounts that may never sign in again. `/privacy` now says
-- the provider's tokens are encrypted at rest, so leaving them would make that
-- sentence false for exactly the users least able to fix it by returning.
--
-- Cleared rather than encrypted, which is the stronger of the two answers and
-- the one the app can afford: Whaikey never calls Google or Apple on a user's
-- behalf, so nothing reads these columns. The session lives in `session` with
-- its own token and is untouched, and the next sign-in writes fresh values
-- through the encrypting path.
--
-- Idempotent: only rows that still hold something are touched.

UPDATE "account"
   SET "access_token" = NULL,
       "refresh_token" = NULL,
       "id_token" = NULL,
       "access_token_expires_at" = NULL,
       "refresh_token_expires_at" = NULL
 WHERE "access_token" IS NOT NULL
    OR "refresh_token" IS NOT NULL
    OR "id_token" IS NOT NULL;
