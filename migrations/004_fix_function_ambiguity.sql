-- Migration: 004_fix_function_ambiguity
-- Description: Drop old 5-param overload of match_memories that conflicts with 6-param version from 003
-- Date: 2026-04-05

drop function if exists all_global_match_memories(vector, text, text, int, float);
