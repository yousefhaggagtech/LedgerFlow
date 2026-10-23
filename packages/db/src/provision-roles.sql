-- Trusted administration only, in a dedicated database. Supply ledgerflow.owner_role,
-- ledgerflow.runtime_role and ledgerflow.schema with set_config or PGOPTIONS.
-- New logins have no password: set credentials securely outside this script.
DO $provision$
DECLARE
  owner_name text := current_setting('ledgerflow.owner_role');
  runtime_name text := current_setting('ledgerflow.runtime_role');
  schema_name text := current_setting('ledgerflow.schema');
  role_name text;
BEGIN
  IF owner_name = runtime_name OR schema_name IN ('public', 'information_schema')
    OR schema_name LIKE 'pg_%' OR schema_name = '' OR octet_length(schema_name) > 63 THEN
    RAISE EXCEPTION 'Use distinct owner/runtime roles and a dedicated application schema';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[owner_name, runtime_name] LOOP
    IF role_name = '' OR octet_length(role_name) > 63 THEN
      RAISE EXCEPTION 'Invalid database role name';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin)) THEN
      RAISE EXCEPTION 'Application roles must be unprivileged logins';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = runtime_name) THEN
    RAISE EXCEPTION 'Runtime must not inherit or be able to assume another role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = schema_name AND r.rolname <> owner_name) THEN
    RAISE EXCEPTION 'Existing schema ownership differs; no ownership transfer was performed';
  END IF;
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', schema_name, owner_name);
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, %I', current_database(), runtime_name);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), owner_name, runtime_name);
  -- Fixture administrators can assume the owner without inheriting its privileges.
  -- LOCAL ends with this statement's transaction; never grant runtime membership.
  EXECUTE format('SET LOCAL ROLE %I', owner_name);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC, %I', schema_name, runtime_name);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, runtime_name);
  IF has_database_privilege(runtime_name, current_database(), 'CREATE')
    OR has_database_privilege(runtime_name, current_database(), 'TEMPORARY')
    OR has_schema_privilege(runtime_name, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Runtime still has broad database/public-schema creation privileges';
  END IF;
END;
$provision$;
