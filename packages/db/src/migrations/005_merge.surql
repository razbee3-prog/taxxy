-- Merge Agent Handler: one Merge registered user per Taxxy user; it holds the connector credentials.
DEFINE TABLE IF NOT EXISTS merge_user SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user ON merge_user TYPE record<user>;
DEFINE FIELD IF NOT EXISTS registered_user_id ON merge_user TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON merge_user TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON merge_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS merge_user_user ON merge_user FIELDS user UNIQUE;
-- gmail_account.provider: 'google' = our OAuth client holds a sealed refresh token; 'merge' = Merge holds it (refresh_token_enc is empty).
DEFINE FIELD IF NOT EXISTS provider ON gmail_account TYPE string DEFAULT 'google' ASSERT $value IN ['google', 'merge'];
