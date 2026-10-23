-- Run as the owner (or trusted administration) AFTER migrations, with the same
-- session settings as provision-roles.sql. No default grants for future tables.
DO $grants$
DECLARE
  owner_name text := current_setting('ledgerflow.owner_role');
  runtime_name text := current_setting('ledgerflow.runtime_role');
  schema_name text := current_setting('ledgerflow.schema');
BEGIN
  IF owner_name = runtime_name OR NOT EXISTS (
    SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = schema_name AND (r.rolname = owner_name
      -- PostgreSQL 15+ public is owned by this implicit database-owner role.
      OR (r.rolname = 'pg_database_owner' AND EXISTS (
        SELECT 1 FROM pg_database d JOIN pg_roles o ON o.oid = d.datdba
        WHERE d.datname = current_database() AND o.rolname = owner_name
      )))
  ) OR EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = runtime_name
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = runtime_name
  ) THEN
    RAISE EXCEPTION 'Provision distinct, unprivileged roles and owner schema first';
  END IF;
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC, %I', schema_name, runtime_name);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC, %I', schema_name, runtime_name);
  EXECUTE format('GRANT SELECT ON %I.users TO %I', schema_name, runtime_name);
  EXECUTE format('GRANT SELECT, INSERT ON %I.organizations, %I.memberships, %I.idempotency_records TO %I',
    schema_name, schema_name, schema_name, runtime_name);
  EXECUTE format('GRANT UPDATE (role, updated_at) ON %I.memberships TO %I', schema_name, runtime_name);
  EXECUTE format('GRANT UPDATE (status, response_status, response_snapshot) ON %I.idempotency_records TO %I', schema_name, runtime_name);
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I.sessions TO %I', schema_name, runtime_name);
  EXECUTE format('GRANT SELECT, INSERT ON %I.audit_events TO %I', schema_name, runtime_name);
  -- Read-only catalog access; the runtime cannot escalate its own capabilities.
  EXECUTE format('GRANT SELECT ON %I.permissions, %I.role_permissions TO %I', schema_name, schema_name, runtime_name);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, runtime_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
    owner_name, schema_name, runtime_name);
END;
$grants$;
