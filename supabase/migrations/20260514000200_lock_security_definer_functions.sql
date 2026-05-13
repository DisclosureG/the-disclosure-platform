-- Lock down SECURITY DEFINER functions so they cannot be called via PostgREST
-- by anon / authenticated. pg_cron runs as the database owner (postgres) so
-- the scheduled job is unaffected.

REVOKE EXECUTE ON FUNCTION public.finalize_stale_evidence() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()         FROM anon, authenticated, public;
