-- Built-in email+password credentials (AuthProvider "local"); swap for Clerk/Auth0 by implementing AuthProvider.
DEFINE TABLE IF NOT EXISTS credential SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user ON credential TYPE record<user>;
DEFINE FIELD IF NOT EXISTS email ON credential TYPE string;
DEFINE FIELD IF NOT EXISTS password_hash ON credential TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON credential TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON credential TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS credential_email ON credential FIELDS email UNIQUE;
DEFINE INDEX IF NOT EXISTS credential_user ON credential FIELDS user UNIQUE;
