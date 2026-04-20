-- Migration: 003_recall_since_days
-- Description: Add min_created_at parameter to match_memories RPC for since_days filtering
-- Date: 2026-04-03

create or replace function all_global_match_memories(
  query_embedding vector(1024),
  filter_project text default null,
  filter_type text default null,
  match_count int default 5,
  threshold float default 0.5,
  min_created_at timestamptz default null
)
returns table (
  id uuid,
  project_id text,
  memory_type text,
  title text,
  content text,
  tags text[],
  similarity float,
  session_id text,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
    select
      m.id,
      m.project_id,
      m.memory_type,
      m.title,
      m.content,
      m.tags,
      1 - (m.embedding <=> query_embedding) as similarity,
      m.session_id,
      m.created_at
    from all_global_project_memory m
    where (m.expires_at is null or m.expires_at > now())
      and (filter_project is null or m.project_id = filter_project)
      and (filter_type is null or m.memory_type = filter_type)
      and (min_created_at is null or m.created_at >= min_created_at)
      and 1 - (m.embedding <=> query_embedding) > threshold
    order by m.embedding <=> query_embedding
    limit match_count;
end;
$$;
