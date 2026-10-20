-- Gmail connection: refresh token sealed by the vault; read-only scope recorded and enforced in code.
DEFINE TABLE IF NOT EXISTS gmail_account SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user ON gmail_account TYPE record<user>;
DEFINE FIELD IF NOT EXISTS email ON gmail_account TYPE string;
DEFINE FIELD IF NOT EXISTS refresh_token_enc ON gmail_account TYPE string;
DEFINE FIELD IF NOT EXISTS scope ON gmail_account TYPE string;
DEFINE FIELD IF NOT EXISTS status ON gmail_account TYPE string DEFAULT 'active' ASSERT $value IN ['active', 'revoked'];
DEFINE FIELD IF NOT EXISTS created_at ON gmail_account TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON gmail_account TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS gmail_account_user ON gmail_account FIELDS user UNIQUE;
