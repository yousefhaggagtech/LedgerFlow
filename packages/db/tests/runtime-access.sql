-- Execute through a password-authenticated runtime connection after db:grants.
-- All successful writes and any unexpectedly allowed DDL are rolled back.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
DO $access$
DECLARE
  organization_id uuid;
  probe_table text := 'runtime_probe_' || replace(gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO public.organizations (name, base_currency, accounting_timezone)
    VALUES ('Runtime access probe (rolled back)', 'EGP', 'Africa/Cairo')
    RETURNING id INTO organization_id;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = organization_id) THEN
    RAISE EXCEPTION 'Runtime cannot read its inserted organization';
  END IF;
  -- The grant is column-specific; no existing memberships need to be mutated.
  UPDATE public.memberships SET role = role, updated_at = updated_at WHERE false;
  BEGIN
    EXECUTE format('CREATE TABLE public.%I (id integer)', probe_table);
    RAISE EXCEPTION 'Runtime unexpectedly allowed CREATE TABLE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DROP TABLE public.organizations;
    RAISE EXCEPTION 'Runtime unexpectedly allowed DROP TABLE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$access$;
SELECT 'PASS: SELECT/INSERT/column UPDATE allowed; CREATE TABLE/DROP TABLE denied (42501)' AS runtime_access;
ROLLBACK;
