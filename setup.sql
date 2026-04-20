-- Run this in Supabase SQL Editor
-- Replaces the old memory table with 1024-dim vectors for Ollama

-- 1. Clean up old objects
drop view if exists all_global_memory_stats;
drop function if exists all_global_match_memories;
drop table if exists all_global_project_memory;
drop table if exists memory;

-- 2. Enable pgvector
create extension if not exists vector;

-- 3. Create memories table (1024 dims for Qwen3-Embedding-0.6B via Ollama)
create table all_global_project_memory (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  memory_type text not null,
  title text not null,
  content text not null,
  tags text[] default '{}',
  embedding vector(1024),
  session_id text,
  created_at timestamptz default now(),
  expires_at timestamptz
);

-- 4. Indexes
create index on all_global_project_memory
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index on all_global_project_memory (project_id);

-- 5. Vector search function
create or replace function all_global_match_memories(
  query_embedding vector(1024),
  filter_project text default null,
  filter_type text default null,
  match_count int default 5,
  threshold float default 0.5
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
      and 1 - (m.embedding <=> query_embedding) > threshold
    order by m.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- 6. Stats view
create or replace view all_global_memory_stats as
  select
    project_id,
    memory_type,
    count(*)::int as count,
    max(created_at)::text as last_updated
  from all_global_project_memory
  where expires_at is null or expires_at > now()
  group by project_id, memory_type;
