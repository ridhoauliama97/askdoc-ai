-- Ask Doc AI — RPC functions.
-- Requires 202611220001_rag_schema.sql.

-- ---------------------------------------------------------------------------
-- Fixed-window rate limiter. One atomic upsert increments the counter for the
-- current window; the caller gets allowed/remaining/retry_after.
-- ---------------------------------------------------------------------------

create or replace function public.rag_check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'p_limit must be positive' using errcode = '22023';
  end if;

  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'p_window_seconds must be positive' using errcode = '22023';
  end if;

  insert into public.rag_rate_limits as rate_limit (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update set
    window_start = case
      when rate_limit.window_start <= v_now - make_interval(secs => p_window_seconds)
        then v_now
      else rate_limit.window_start
    end,
    count = case
      when rate_limit.window_start <= v_now - make_interval(secs => p_window_seconds)
        then 1
      else rate_limit.count + 1
    end
  returning rate_limit.window_start, rate_limit.count
  into v_window_start, v_count;

  allowed := v_count <= p_limit;
  remaining := greatest(p_limit - v_count, 0);

  if allowed then
    retry_after := 0;
  else
    retry_after := greatest(
      1,
      ceil(extract(epoch from (
        v_window_start + make_interval(secs => p_window_seconds) - v_now
      )))::integer
    );
  end if;

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cosine-similarity retrieval scoped to one document.
-- ---------------------------------------------------------------------------

create or replace function public.rag_match_chunks(
  p_document_id uuid,
  p_query_embedding extensions.vector(768),
  p_match_count integer default 5,
  p_match_threshold double precision default 0.35
)
returns table (
  chunk_id bigint,
  page_number integer,
  content text,
  similarity double precision
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);

  return query
    select
      c.id,
      c.page_number,
      c.content,
      (1 - (c.embedding <=> p_query_embedding))::double precision
    from public.rag_chunks as c
    where c.document_id = p_document_id
      and c.embedding is not null
      and (1 - (c.embedding <=> p_query_embedding)) >= p_match_threshold
    order by c.embedding <=> p_query_embedding
    limit greatest(p_match_count, 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Remove sessions that are older than 7 days and never produced a document.
-- ---------------------------------------------------------------------------

create or replace function public.rag_cleanup_orphan_sessions()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.rag_sessions as s
  where s.created_at < now() - interval '7 days'
    and not exists (
      select 1
      from public.rag_documents as d
      where d.session_id = s.id
    );

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs are server-only: revoke the default PUBLIC execute grant and grant
-- execute to the service role only.
-- ---------------------------------------------------------------------------

revoke all on function public.rag_check_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.rag_check_rate_limit(text, integer, integer)
  to service_role;

revoke all on function public.rag_match_chunks(uuid, extensions.vector, integer, double precision)
  from public, anon, authenticated;
grant execute on function public.rag_match_chunks(uuid, extensions.vector, integer, double precision)
  to service_role;

revoke all on function public.rag_cleanup_orphan_sessions()
  from public, anon, authenticated;
grant execute on function public.rag_cleanup_orphan_sessions()
  to service_role;
