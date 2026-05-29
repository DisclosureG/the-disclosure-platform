-- Complete on-chain backup support (EvidenceArchive sidecar).
--
-- archive_notes: the canonical note store reconstructable from chain. The
-- indexer fills it from NotePublished events (note_hash == keccak(text), the
-- same hash the signed vote committed), so every deliberation note survives a
-- full wipe even for vote tables that don't carry note_hash themselves.
create table if not exists public.archive_notes (
  note_hash  text primary key,
  note       text not null,
  created_at timestamptz not null default now()
);
alter table public.archive_notes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'archive_notes' and policyname = 'archive_notes_read') then
    create policy archive_notes_read on public.archive_notes for select using (true);
  end if;
end $$;

-- Schedule the archive-flush keeper: pushes evidence content, taxonomy node
-- metadata, and deliberation note text onto the EvidenceArchive sidecar so the
-- chain is a complete, self-sufficient backup of the off-chain tables. Runs
-- often (loss window before a wipe = the cron interval); each write is verified
-- on-chain and idempotent, so re-runs are safe. Mirrors invoke_consensus_keeper:
-- reads project_url / service_role_key from vault (see consolidated schema).

create or replace function public.invoke_archive_flush()
returns bigint language plpgsql security definer set search_path to 'public', 'vault' as $fn$
declare v_url text; v_key text; v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise notice 'archive-flush secrets missing; skipping invocation'; return null;
  end if;
  select net.http_post(
    url     := v_url || '/functions/v1/archive-flush',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_req;
  return v_req;
end;
$fn$;
revoke execute on function public.invoke_archive_flush() from anon, authenticated, public;

do $cron$
begin
  if not exists (select 1 from cron.job where jobname = 'archive-flush-every-2-min') then
    perform cron.schedule('archive-flush-every-2-min', '*/2 * * * *',
      'select public.invoke_archive_flush();');
  end if;
end
$cron$;
