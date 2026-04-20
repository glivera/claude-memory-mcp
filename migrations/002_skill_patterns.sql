-- Migration: 002_skill_patterns
-- Description: Add skill_patterns table for tracking reusable work patterns
-- Date: 2026-03-29
-- Executed via Supabase MCP (this file is for documentation only)

-- Batch 1: Create table
create table if not exists skill_patterns (
  id uuid primary key default gen_random_uuid(),
  pattern_id text not null,
  description text not null,
  category text not null check (category in (
    'n8n', 'supabase', 'devops', 'client', 'content', 'code', 'architecture', 'other'
  )),
  project text,
  examples jsonb not null default '[]'::jsonb,
  count int not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  proposed_skill boolean not null default false,
  skill_created boolean not null default false,
  embedding vector(1024) not null,
  constraint skill_patterns_count_positive check (count > 0)
);

-- Batch 2: Create indexes
create index if not exists skill_patterns_embedding_idx
  on skill_patterns
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists skill_patterns_category_idx
  on skill_patterns (category);

create index if not exists skill_patterns_count_idx
  on skill_patterns (count) where skill_created = false;

create index if not exists skill_patterns_project_idx
  on skill_patterns (project) where project is not null;

-- Batch 3: RPC functions
create or replace function match_skill_patterns(
  query_embedding vector(1024),
  match_threshold float default 0.9,
  match_count int default 1,
  filter_category text default null,
  filter_project text default null
)
returns table (
  id uuid,
  pattern_id text,
  description text,
  category text,
  project text,
  examples jsonb,
  count int,
  first_seen timestamptz,
  last_seen timestamptz,
  proposed_skill boolean,
  skill_created boolean,
  similarity float
)
language sql stable
as $$
  select
    sp.id,
    sp.pattern_id,
    sp.description,
    sp.category,
    sp.project,
    sp.examples,
    sp.count,
    sp.first_seen,
    sp.last_seen,
    sp.proposed_skill,
    sp.skill_created,
    1 - (sp.embedding <=> query_embedding) as similarity
  from skill_patterns sp
  where 1 - (sp.embedding <=> query_embedding) > match_threshold
    and (filter_category is null or sp.category = filter_category)
    and (filter_project is null or sp.project = filter_project)
  order by sp.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function get_mature_patterns(
  min_count int default 3,
  filter_category text default null,
  exclude_created boolean default true
)
returns table (
  id uuid,
  pattern_id text,
  description text,
  category text,
  project text,
  examples jsonb,
  count int,
  first_seen timestamptz,
  last_seen timestamptz
)
language sql stable
as $$
  select
    sp.id,
    sp.pattern_id,
    sp.description,
    sp.category,
    sp.project,
    sp.examples,
    sp.count,
    sp.first_seen,
    sp.last_seen
  from skill_patterns sp
  where sp.count >= min_count
    and (not exclude_created or sp.skill_created = false)
    and (filter_category is null or sp.category = filter_category)
  order by sp.count desc, sp.last_seen desc;
$$;

-- Rollback (if needed):
-- drop function if exists get_mature_patterns;
-- drop function if exists match_skill_patterns;
-- drop table if exists skill_patterns;
