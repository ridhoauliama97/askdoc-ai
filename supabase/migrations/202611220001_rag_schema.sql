-- Ask Doc AI — base schema.
-- Creates the rag_* tables, indexes, storage bucket, grants, and the hourly
-- pg_cron cleanup for documents that never finished uploading.

create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.rag_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.rag_documents (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.rag_sessions (id) on delete cascade,
  file_name text not null,
  file_size bigint not null,
  page_count integer,
  chunk_count integer not null default 0,
  status text not null check (
    status in ('awaiting_upload', 'parsing', 'embedding', 'ready', 'failed')
  ),
  error_code text,
  error_message text,
  storage_path text not null,
  ingest_lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table if not exists public.rag_chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.rag_documents (id) on delete cascade,
  page_number integer not null,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(768),
  created_at timestamptz not null default now(),
  constraint rag_chunks_document_id_chunk_index_key
    unique (document_id, chunk_index)
);

create table if not exists public.rag_messages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.rag_documents (id) on delete cascade,
  session_id uuid not null references public.rag_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.rag_rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists rag_documents_session_created_idx
  on public.rag_documents (session_id, created_at desc);

create index if not exists rag_documents_expires_at_idx
  on public.rag_documents (expires_at);

create index if not exists rag_documents_status_idx
  on public.rag_documents (status);

create index if not exists rag_chunks_document_page_idx
  on public.rag_chunks (document_id, page_number);

create index if not exists rag_chunks_pending_embedding_idx
  on public.rag_chunks (document_id)
  where embedding is null;

create index if not exists rag_chunks_embedding_hnsw_idx
  on public.rag_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists rag_messages_document_created_idx
  on public.rag_messages (document_id, created_at);

-- ---------------------------------------------------------------------------
-- Row level security: enabled everywhere, intentionally no policies.
-- Only the service role (server-side) may touch these tables.
-- ---------------------------------------------------------------------------

alter table public.rag_sessions enable row level security;
alter table public.rag_documents enable row level security;
alter table public.rag_chunks enable row level security;
alter table public.rag_messages enable row level security;
alter table public.rag_rate_limits enable row level security;

revoke all on table
  public.rag_sessions,
  public.rag_documents,
  public.rag_chunks,
  public.rag_messages,
  public.rag_rate_limits
from anon, authenticated;

grant all on table
  public.rag_sessions,
  public.rag_documents,
  public.rag_chunks,
  public.rag_messages,
  public.rag_rate_limits
to service_role;

grant usage, select on sequence public.rag_chunks_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Storage bucket: private PDF bucket, 15 MB per object, PDF only.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rag-documents', 'rag-documents', false, 15728640, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = 15728640,
  allowed_mime_types = array['application/pdf'];

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.rg_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rag_documents_set_updated_at on public.rag_documents;
create trigger rag_documents_set_updated_at
  before update on public.rag_documents
  for each row
  execute function public.rg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Hourly cleanup for documents whose upload never completed.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from cron.job where jobname = 'rag-cleanup-awaiting-upload') then
    perform cron.unschedule('rag-cleanup-awaiting-upload');
  end if;
  perform cron.schedule(
    'rag-cleanup-awaiting-upload',
    '0 * * * *',
    $cron$delete from public.rag_documents where status = 'awaiting_upload' and created_at < now() - interval '1 hour';$cron$
  );
end $$;
