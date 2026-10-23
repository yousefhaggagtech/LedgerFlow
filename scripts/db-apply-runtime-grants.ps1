[CmdletBinding()]
param(
    [string]$EnvFile = '',
    [string]$Container = 'ledgerflow-postgres-1'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot '../.env' }

# Parse data, never evaluate .env as PowerShell. Values are literal (no expansion).
function Read-DotEnv([string]$Path) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        if ($line -match '^\s*(#|$)') { continue }
        if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            throw 'Invalid .env assignment; use one KEY=value per line.'
        }
        $key = $Matches[1]
        $value = $Matches[2]
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            $quote = [regex]::Escape($value.Substring(0, 1))
            if ($value -notmatch "^$quote(.*)$quote\s*(?:#.*)?`$") {
                throw "Invalid quoted .env value for $key. Multiline values are unsupported."
            }
            $value = $Matches[1]
        } else {
            $value = ($value -replace '\s+#.*$', '').TrimEnd()
        }
        $values[$key] = $value
    }
    return $values
}

function Require-Value([hashtable]$Values, [string]$Name) {
    if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Values[$Name])) {
        throw "$Name is required in the .env file."
    }
    return $Values[$Name]
}

# Hex literals keep quotes, backslashes and psql metacommands out of SQL syntax.
function Sql-Text([string]$Value) {
    $hex = [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($Value)).Replace('-', '')
    return "convert_from(decode('$hex', 'hex'), 'UTF8')"
}

function Invoke-Psql([string]$Sql, [string]$User, [switch]$Tcp) {
    $arguments = @('exec', '-i')
    if ($Tcp) { $arguments += @('-e', 'PGPASSWORD') }
    $arguments += @($Container, 'psql', '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-U', $User, '-d', $script:database)
    if ($Tcp) { $arguments += @('-h', '127.0.0.1') }
    # Capture diagnostics: a PostgreSQL error context can contain password SQL.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = $Sql | & docker @arguments 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) {
        throw 'psql failed. Check Docker, credentials, applied migrations and role/schema ownership; SQL diagnostics suppressed to protect credentials.'
    }
    return $output
}

$previousEncoding = $OutputEncoding
$previousPassword = $env:PGPASSWORD
try {
    $OutputEncoding = New-Object Text.UTF8Encoding $false
    $values = Read-DotEnv $EnvFile
    $owner = Require-Value $values 'POSTGRES_USER'
    $script:database = Require-Value $values 'POSTGRES_DB'
    $runtime = Require-Value $values 'RUNTIME_DB_USER'
    $password = Require-Value $values 'RUNTIME_DB_PASSWORD'
    foreach ($name in @($owner, $runtime, $script:database)) {
        if ([Text.Encoding]::UTF8.GetByteCount($name) -gt 63 -or $name -match '[\x00-\x1f\x7f]' -or $name.StartsWith('-')) {
            throw 'Role/database names must be valid PostgreSQL identifiers of at most 63 UTF-8 bytes.'
        }
    }
    if ($owner -eq $runtime) { throw 'Owner and runtime must be distinct roles.' }
    # Migrations use unqualified Kysely names; the Compose application lives in public.
    $settings = @"
SELECT set_config('ledgerflow.owner_role', $(Sql-Text $owner), false),
       set_config('ledgerflow.runtime_role', $(Sql-Text $runtime), false),
       set_config('ledgerflow.schema', 'public', false);
"@
    $bootstrap = @'
DO $bootstrap$
DECLARE
  owner_name text := current_setting('ledgerflow.owner_role');
  runtime_name text := current_setting('ledgerflow.runtime_role');
BEGIN
  IF current_user <> owner_name THEN RAISE EXCEPTION 'Connect as configured owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_name
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = runtime_name)
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = runtime_name)
    OR EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = runtime_name)
    OR EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = runtime_name) THEN
    RAISE EXCEPTION 'Refusing an elevated, member or object-owning runtime role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_name) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', runtime_name);
  END IF;
  EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', runtime_name, current_setting('ledgerflow.runtime_password'));
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, %I', current_database(), runtime_name);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), runtime_name);
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM PUBLIC, %I', runtime_name);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_name);
END;
$bootstrap$;
'@
    $grants = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../packages/db/src/runtime-grants.sql')
    $sql = "BEGIN;`nSET LOCAL lock_timeout = '5s';`nSET LOCAL statement_timeout = '30s';`nSELECT pg_advisory_xact_lock(hashtext('ledgerflow.runtime-grants'));`n$settings`nSELECT set_config('ledgerflow.runtime_password', $(Sql-Text $password), true);`n$bootstrap`n$grants`nCOMMIT;"
    $null = Invoke-Psql $sql $owner

    $env:PGPASSWORD = $password
    $verification = @'
DO $verify$
BEGIN
  IF current_user <> session_user
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR has_schema_privilege(current_user, 'public', 'CREATE')
    OR has_database_privilege(current_user, current_database(), 'CREATE')
    OR has_database_privilege(current_user, current_database(), 'TEMPORARY')
    OR NOT has_schema_privilege(current_user, 'public', 'USAGE')
    OR NOT has_table_privilege(current_user, 'public.organizations', 'SELECT')
    OR NOT has_table_privilege(current_user, 'public.organizations', 'INSERT')
    OR NOT has_column_privilege(current_user, 'public.memberships', 'role', 'UPDATE')
    OR has_table_privilege(current_user, 'public.permissions', 'INSERT')
    OR has_table_privilege(current_user, 'public.kysely_migration', 'SELECT') THEN
    RAISE EXCEPTION 'Runtime privilege verification failed';
  END IF;
END;
$verify$;
SELECT current_user AS runtime_login, session_user, current_schema();
SELECT table_name, privilege_type FROM information_schema.role_table_grants
WHERE grantee = current_user AND table_schema = 'public' ORDER BY table_name, privilege_type;
SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
WHERE grantee = current_user AND table_schema = 'public' AND privilege_type = 'UPDATE'
ORDER BY table_name, column_name;
'@
    $accessTests = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../packages/db/tests/runtime-access.sql')
    Invoke-Psql "$verification`n$accessTests" $runtime -Tcp
    Write-Host 'SUCCESS: runtime grants applied and verified using a password-authenticated runtime connection (public schema).'
} catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    $OutputEncoding = $previousEncoding
    $env:PGPASSWORD = $previousPassword
}
