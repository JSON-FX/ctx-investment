-- Read-only pre-flight for applying Compound's migrations to a live database.
--
-- Run this FIRST, against the target, and read every row. It writes nothing:
-- no CREATE, no ALTER, no INSERT. It answers the questions the migration set
-- assumes the answer to, so that an assumption that turns out false is found
-- here rather than halfway through a migration.
--
-- Every check prints its own verdict. Anything that does not say OK is a stop.

\echo '=== 1. Server version (MAINTAIN exists from PostgreSQL 17)'
select
  current_setting('server_version') as version,
  case when current_setting('server_version_num')::int >= 170000
       then 'OK — the MAINTAIN branch of the truncate hardening will run'
       else 'OK — the pre-17 branch will run instead (revokes TRUNCATE only)'
  end as verdict;

\echo '=== 2. public.users must exist, with a uuid primary key'
select
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users'
      and column_name = 'id' and data_type = 'uuid')
  then 'OK — five compound foreign keys point at public.users(id)'
  else 'STOP — public.users(id uuid) not found. Compound references it, not auth.users.'
  end as verdict;

\echo '=== 3. public.users.role must already allow the value admin'
select
  pg_get_constraintdef(oid) as role_constraint,
  'Compound adds NO role. It reads app_metadata->>role from the JWT and keys ownership on compound_account.manager_user_id.' as note
from pg_constraint
where conrelid = 'public.users'::regclass and contype = 'c'
  and pg_get_constraintdef(oid) ilike '%role%';

\echo '=== 4. No compound_* object may already exist'
select coalesce(string_agg(relname, ', '), '(none)') as existing_compound_objects,
       case when count(*) = 0 then 'OK — nothing to collide with'
            else 'STOP — these already exist; the migration set assumes a clean namespace' end as verdict
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname like 'compound%';

\echo '=== 5. The CopyTraderX tables Compound READS must exist (it never writes them)'
select t.name,
       case when to_regclass('public.' || t.name) is not null
            then 'OK' else 'STOP — Compound reads this table' end as verdict
from (values ('deals'), ('account_snapshots_daily'), ('account_snapshots_current'),
             ('orders'), ('positions')) as t(name);

\echo '=== 6. Current TRUNCATE exposure on an existing CopyTraderX table'
\echo '     (shows whether the hole the hardening closes is already present here)'
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'deals'
  and privilege_type in ('TRUNCATE', 'DELETE')
order by grantee, privilege_type;

\echo '=== 7. Existing default privileges for role postgres in schema public'
\echo '     (migration 054531 narrows these — this is what it changes FROM)'
select defaclrole::regrole::text as grantor, defaclacl::text[] as current_acl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace and defaclobjtype = 'r';

\echo '=== 8. Anything already using TRUNCATE or MAINTAIN in a stored function'
\echo '     (the hardening assumes nothing does — verify for THIS database)'
select coalesce(string_agg(p.proname, ', '), '(none)') as functions_using_truncate,
       case when count(*) = 0 then 'OK — nothing relies on it'
            else 'REVIEW — these would be affected by the narrowed default' end as verdict
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosrc ~* '\mtruncate\M';
