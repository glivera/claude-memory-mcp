import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from './config.js';
import { DbError, ValidationError } from './errors.js';
import { generateEmbedding } from './embedding.js';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const config = getConfig();
  client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
  return client;
}

export interface MemoryRow {
  id: string;
  project_id: string;
  memory_type: string;
  title: string;
  content: string;
  tags: string[];
  embedding?: number[];
  session_id: string | null;
  created_at: string;
  expires_at: string | null;
  linked_to?: string[];
  relation?: string | null;
  status?: string;
  provenance?: string;
  trust_score?: number;
}

export interface MatchResult {
  id: string;
  project_id: string;
  memory_type: string;
  title: string;
  content: string;
  tags: string[];
  similarity: number;
  session_id: string | null;
  created_at: string;
  status?: string;
  linked_to?: string[];
  relation?: string | null;
  link_depth?: number;
  provenance?: string | null;
  trust_score?: number | null;
  rrf_score?: number;
}

export interface MemoryStats {
  project_id: string;
  memory_type: string;
  count: number;
  last_updated: string;
}

export interface GoalProgress {
  total_goals: number;
  completed: number;
  in_progress: number;
  waived: number;
  deviations_open: number;
  blockers_open: number;
  completion_pct: number;
}

export interface ComplianceCheckRow {
  id: string;
  title: string;
  status: string;
  tags: string[];
  created_at: string;
  linked_to: string[];
}

export interface LinkMemoriesResult {
  id: string;
  linked_to: string[];
  relation: string | null;
}

export interface MemoryListRow {
  id: string;
  title: string;
  memory_type: string;
  status: string | null;
  created_at: string;
}

export interface ListMemoriesResult {
  memories: MemoryListRow[];
  total: number;
}

const TABLE = 'all_global_project_memory';

export async function insertMemory(
  row: Omit<MemoryRow, 'id' | 'created_at' | 'provenance' | 'trust_score'> & {
    provenance: string;
    trust_score: number;
  }
): Promise<MemoryRow> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from(TABLE)
    .insert(row)
    .select()
    .single();

  if (error) throw new DbError(`Insert failed: ${error.message}`, { cause: error });
  return data as MemoryRow;
}

export async function matchMemories(
  queryEmbedding: number[],
  filterProject: string | null,
  filterType: string | null,
  matchCount: number,
  threshold: number,
  minCreatedAt?: string | null
): Promise<MatchResult[]> {
  const db = getSupabaseClient();
  const params: Record<string, unknown> = {
    query_embedding: queryEmbedding,
    filter_project: filterProject,
    filter_type: filterType,
    match_count: matchCount,
    threshold,
  };
  if (minCreatedAt) {
    params.min_created_at = minCreatedAt;
  }
  const { data, error } = await db.rpc('all_global_match_memories_v2', params);

  if (error) throw new DbError(`Match query failed: ${error.message}`, { cause: error });
  return (data ?? []) as MatchResult[];
}

export async function matchMemoriesHybrid(
  queryEmbedding: number[],
  queryText: string,
  filterProject: string | null,
  filterType: string | null,
  matchCount: number,
  threshold: number,
  minCreatedAt: string | null
): Promise<MatchResult[]> {
  const db = getSupabaseClient();
  const { data, error } = await db.rpc('all_global_match_memories_hybrid', {
    query_embedding: queryEmbedding,
    query_text: queryText,
    filter_project: filterProject,
    filter_type: filterType,
    match_count: matchCount,
    threshold,
    min_created_at: minCreatedAt,
  });

  if (error) throw new DbError(`all_global_match_memories_hybrid failed: ${error.message}`, { cause: error });
  return (data ?? []) as MatchResult[];
}

export async function matchMemoriesWithLinks(
  queryEmbedding: number[],
  filterProject: string | null,
  filterType: string | null,
  filterStatus: string | null,
  matchCount: number,
  threshold: number,
  minCreatedAt: string | null,
  followLinks: boolean
): Promise<MatchResult[]> {
  const db = getSupabaseClient();
  const { data, error } = await db.rpc('match_memories_with_links_v2', {
    query_embedding: queryEmbedding,
    filter_project: filterProject,
    filter_type: filterType,
    filter_status: filterStatus,
    match_count: matchCount,
    threshold,
    min_created_at: minCreatedAt,
    follow_links: followLinks,
  });

  if (error) throw new DbError(`match_memories_with_links_v2 failed: ${error.message}`, { cause: error });
  return (data ?? []) as MatchResult[];
}

export async function getGoalProgress(
  projectId: string,
  goalId?: string
): Promise<GoalProgress> {
  const db = getSupabaseClient();
  const { data, error } = await db.rpc('goal_progress_rpc', {
    filter_project: projectId,
    filter_goal_id: goalId ?? null,
  });

  if (error) throw new DbError(`goal_progress_rpc failed: ${error.message}`, { cause: error });
  return data as GoalProgress;
}

export async function getComplianceTrend(
  projectId: string,
  sinceDays: number
): Promise<ComplianceCheckRow[]> {
  const db = getSupabaseClient();
  const { data, error } = await db.rpc('compliance_trend_rpc', {
    filter_project: projectId,
    filter_since_days: sinceDays,
  });

  if (error) throw new DbError(`compliance_trend_rpc failed: ${error.message}`, { cause: error });
  return (data ?? []) as ComplianceCheckRow[];
}

export async function linkMemoriesAtomic(
  fromId: string,
  toIds: string[],
  relation: string | null
): Promise<LinkMemoriesResult> {
  const db = getSupabaseClient();
  const { data, error } = await db.rpc('link_memories_rpc', {
    from_id: fromId,
    to_ids: toIds,
    relation_value: relation,
  });

  if (error) throw new DbError(`link_memories_rpc failed: ${error.message}`, { cause: error });
  const rows = (data ?? []) as LinkMemoriesResult[];
  const row = rows[0];
  if (!row) throw new ValidationError(`Memory ${fromId} not found or expired`);
  return row;
}

async function resolveNotFoundError(
  memoryId: string,
  projectId: string
): Promise<ValidationError> {
  const db = getSupabaseClient();
  const { data } = await db
    .from(TABLE)
    .select('project_id')
    .eq('id', memoryId)
    .maybeSingle();

  if (data && data.project_id !== projectId) {
    return new ValidationError(`Memory ${memoryId} belongs to project ${data.project_id}, not ${projectId}`);
  }
  return new ValidationError(`Memory ${memoryId} not found or expired`);
}

export async function updateStatus(
  memoryId: string,
  projectId: string,
  status: 'open' | 'resolved' | 'waived' | 'superseded',
  resolutionNote?: string
): Promise<MemoryRow> {
  const db = getSupabaseClient();

  if (resolutionNote) {
    const { data: existing, error: readError } = await db
      .from(TABLE)
      .select('title, content')
      .eq('id', memoryId)
      .eq('project_id', projectId)
      .or('expires_at.is.null,expires_at.gt.now()')
      .maybeSingle();

    if (readError) throw new DbError(`Status update read failed: ${readError.message}`, { cause: readError });
    if (!existing) throw await resolveNotFoundError(memoryId, projectId);

    const closureLine = `\n\n[CLOSURE ${new Date().toISOString()} -> ${status}] ${resolutionNote}`;
    const newContent = `${existing.content}${closureLine}`;
    const embedding = await generateEmbedding(`${existing.title} ${newContent}`);

    const { data, error } = await db
      .from(TABLE)
      .update({ status, content: newContent, embedding })
      .eq('id', memoryId)
      .eq('project_id', projectId)
      .or('expires_at.is.null,expires_at.gt.now()')
      .select()
      .maybeSingle();

    if (error) throw new DbError(`Status update failed: ${error.message}`, { cause: error });
    if (!data) throw await resolveNotFoundError(memoryId, projectId);
    return data as MemoryRow;
  }

  const { data, error } = await db
    .from(TABLE)
    .update({ status })
    .eq('id', memoryId)
    .eq('project_id', projectId)
    .or('expires_at.is.null,expires_at.gt.now()')
    .select()
    .maybeSingle();

  if (error) throw new DbError(`Status update failed: ${error.message}`, { cause: error });
  if (!data) throw await resolveNotFoundError(memoryId, projectId);
  return data as MemoryRow;
}

export async function listMemories(
  projectId: string,
  options: {
    memoryType?: string;
    status?: string;
    sinceDays?: number;
    limit?: number;
  } = {}
): Promise<ListMemoriesResult> {
  const db = getSupabaseClient();
  const { memoryType, status, sinceDays, limit } = options;

  let query = db
    .from(TABLE)
    .select('id, title, memory_type, status, created_at', { count: 'exact' })
    .eq('project_id', projectId)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('created_at', { ascending: false });

  if (memoryType) query = query.eq('memory_type', memoryType);
  if (status) query = query.eq('status', status);
  if (sinceDays !== undefined) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - sinceDays);
    query = query.gte('created_at', cutoff.toISOString());
  }
  if (limit !== undefined) query = query.limit(limit);

  const { data, error, count } = await query;

  if (error) throw new DbError(`List query failed: ${error.message}`, { cause: error });
  return { memories: (data ?? []) as MemoryListRow[], total: count ?? 0 };
}

export async function expireMemoryById(memoryId: string, projectId: string): Promise<number> {
  const db = getSupabaseClient();
  // Idempotent: re-expiring an already-expired row (in the right project)
  // is a no-op from the recall perspective (it's already filtered out)
  // but will refresh expires_at and still return count 1. We omit the
  // or() guard on expires_at here for two reasons:
  //   1. PostgREST rejects `or(expires_at...)` + `select('id')` + UPDATE
  //      with error 42703 "column expires_at does not exist" because the
  //      RETURNING projection doesn't include expires_at.
  //   2. After SET expires_at=now(), the RETURNING row has
  //      expires_at=now() (not > now()), so PostgREST re-applying the
  //      filter on the returned row yields empty data → count=0 even
  //      though the UPDATE succeeded. Semantically wrong.
  const { data, error } = await db
    .from(TABLE)
    .update({ expires_at: new Date().toISOString() })
    .eq('id', memoryId)
    .eq('project_id', projectId)
    .select('id');

  if (error) throw new DbError(`Expire by ID failed: ${error.message}`, { cause: error });
  const count = data?.length ?? 0;
  if (count === 0) throw await resolveNotFoundError(memoryId, projectId);
  return count;
}

export async function expireMemoriesByProject(
  projectId: string,
  olderThanDays?: number
): Promise<number> {
  const db = getSupabaseClient();
  // Same PostgREST quirk as expireMemoryById — or() guard on expires_at
  // combined with UPDATE + select yields both 42703 errors and wrong
  // counts. Idempotent: already-expired rows will have expires_at
  // refreshed, which is acceptable for project-wide cleanup.
  let query = db
    .from(TABLE)
    .update({ expires_at: new Date().toISOString() })
    .eq('project_id', projectId);

  if (olderThanDays !== undefined) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    query = query.lt('created_at', cutoff.toISOString());
  }

  const { data, error } = await query.select('id');

  if (error) throw new DbError(`Expire by project failed: ${error.message}`, { cause: error });
  return data?.length ?? 0;
}

export async function getMemoryStats(projectId?: string): Promise<MemoryStats[]> {
  const db = getSupabaseClient();
  let query = db.from('all_global_memory_stats').select('*');

  if (projectId) {
    query = query.eq('project_id', projectId);
  }

  const { data, error } = await query;

  if (error) throw new DbError(`Stats query failed: ${error.message}`, { cause: error });
  return (data ?? []) as MemoryStats[];
}

export async function getLatestContext(projectId: string): Promise<string | null> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from(TABLE)
    .select('content')
    .eq('project_id', projectId)
    .eq('memory_type', 'context')
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new DbError(`Latest context query failed: ${error.message}`, { cause: error });
  return data?.content ?? null;
}

export function resetDbClient(): void {
  client = null;
}
