import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from './config.js';
import { DbError } from './errors.js';

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
}

export interface MemoryStats {
  project_id: string;
  memory_type: string;
  count: number;
  last_updated: string;
}

const TABLE = 'all_global_project_memory';

export async function insertMemory(
  row: Omit<MemoryRow, 'id' | 'created_at'>
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
  const { data, error } = await db.rpc('all_global_match_memories', params);

  if (error) throw new DbError(`Match query failed: ${error.message}`, { cause: error });
  return (data ?? []) as MatchResult[];
}

export async function expireMemoryById(memoryId: string): Promise<number> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from(TABLE)
    .update({ expires_at: new Date().toISOString() })
    .eq('id', memoryId)
    .or('expires_at.is.null,expires_at.gt.now()')
    .select('id');

  if (error) throw new DbError(`Expire by ID failed: ${error.message}`, { cause: error });
  return data?.length ?? 0;
}

export async function expireMemoriesByProject(
  projectId: string,
  olderThanDays?: number
): Promise<number> {
  const db = getSupabaseClient();
  let query = db
    .from(TABLE)
    .update({ expires_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .or('expires_at.is.null,expires_at.gt.now()');

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
