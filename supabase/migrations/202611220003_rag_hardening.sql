-- Ask Doc AI — hardening follow-up.
-- Applied as a new migration after 202611220002; does not rewrite applied history.

-- The identity sequence is only used by the server. Remove the Supabase default
-- grants that anon/authenticated received on it.
revoke all on sequence public.rag_chunks_id_seq from anon, authenticated;

-- Fix the trigger helper name inherited from the brief. The trigger references the
-- function by OID, so it keeps working across the rename.
alter function public.rg_set_updated_at() rename to rag_set_updated_at;

-- Harden retrieval defaults: explicit NULLs must fall back to the documented
-- defaults instead of meaning "no limit" (LIMIT NULL) or "nothing matches"
-- (comparison with NULL).
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
      and (1 - (c.embedding <=> p_query_embedding)) >= coalesce(p_match_threshold, 0.35)
    order by c.embedding <=> p_query_embedding
    limit greatest(coalesce(p_match_count, 5), 1);
end;
$$;

-- CREATE OR REPLACE keeps the existing ACL, but re-assert it explicitly so the
-- function stays server-only even if this migration is replayed.
revoke all on function public.rag_match_chunks(uuid, extensions.vector, integer, double precision)
  from public, anon, authenticated;
grant execute on function public.rag_match_chunks(uuid, extensions.vector, integer, double precision)
  to service_role;
