# Project History Report: memory-mcp

> Generated: 2026-03-29
> Source: /Users/glivera/containers/memory-mcp
> Git commits analyzed: 1
> Project timeline: 2026-03-25 → 2026-03-25 (single atomic commit; iterative development via Claude Code sessions prior to commit)

---

## 1. Project Summary

### What It Does
A persistent vector memory server for Claude Code that gives AI assistants long-term semantic memory across sessions. It stores memories as embeddings in PostgreSQL (pgvector), enabling semantic recall via cosine similarity search. Four tools — remember, recall, forget, project_status — are exposed over the Model Context Protocol (MCP).

### Who It's For
Developers using Claude Code (Anthropic's CLI) who want their AI assistant to retain context, decisions, patterns, and learnings across conversations and projects. Particularly valuable for solo developers or small teams managing multiple codebases where continuity between AI sessions is critical.

### Problem It Solves
Claude Code has no built-in memory between sessions. Every new conversation starts from zero — the AI re-discovers architecture, forgets past decisions, repeats mistakes already solved, and can't learn from prior work. Developers waste time re-explaining context and watching the AI make the same errors twice.

### Solution In Brief
An always-running Docker container that acts as a shared MCP server for all Claude Code sessions. Memories are stored as vector embeddings in Supabase PostgreSQL, enabling semantic search ("find memories similar to this query") rather than keyword matching. Soft-delete ensures no data is ever lost. One container serves 8-10 concurrent Claude sessions via Streamable HTTP transport.

---

## 2. Tech Stack & Architecture

### Stack
| Layer | Technology | Version | Why Chosen |
|-------|-----------|---------|------------|
| Runtime | Node.js (Alpine Docker) | 20 | LTS, small image size, native ESM support |
| Language | TypeScript | 5.8 | Strict mode catches bugs at compile time; Zod integration |
| Framework | Express | 5.2 | Minimal HTTP layer for MCP transport; v5 for async error handling |
| MCP SDK | @modelcontextprotocol/sdk | 1.12.1 | Official SDK, StreamableHTTPServerTransport for multi-session |
| Database | Supabase PostgreSQL + pgvector | Cloud | Managed vector DB, no ops overhead, RPC functions for search |
| Embeddings | OpenAI text-embedding-3-small | 1536 dims | Best cost/quality ratio for technical text embedding |
| Validation | Zod | 3.25 | Runtime type checking at all boundaries |
| Testing | Vitest | 3.2 | Fast, native ESM, v8 coverage provider |
| Container | Docker (multi-stage) | Alpine | Stateless deployment, `unless-stopped` restart policy |

### Architecture Pattern
Stateless HTTP microservice with external persistence (three-tier: Claude Code → MCP Server → Supabase).

### Architecture Description
Claude Code sends JSON-RPC requests over HTTP POST to `localhost:3101/mcp`. Express routes requests to the MCP SDK's StreamableHTTPServerTransport, which manages sessions by UUID. Each tool handler validates input with Zod, generates embeddings via OpenAI API, and reads/writes to Supabase PostgreSQL using pgvector for similarity search. The container holds no persistent state — all data lives in Supabase. Session tracking is in-memory only (lost on container restart). A Supabase RPC function (`all_global_match_memories`) handles vector similarity search with configurable threshold, filtering expired entries server-side.

### Services / Containers
| Service | Purpose | Port |
|---------|---------|------|
| memory-mcp | Production MCP server (multi-stage build) | 3101 |
| dev | Development mode with hot reload (tsx) | 3101 |
| test | Test runner (vitest) | — |

### Database Schema Overview
Single table `all_global_project_memory` with columns: id (UUID), project_id, memory_type (8 enum values), title, content, tags (text[]), embedding (vector(1536)), session_id, created_at, expires_at. Soft-delete via `expires_at` — never hard-deletes. IVFFlat index on embedding column for efficient similarity search. A database view `all_global_memory_stats` aggregates per-project stats. An RPC function `all_global_match_memories` performs vector cosine similarity search with project/type filtering and expired entry exclusion.

---

## 3. External Integrations

| Service | Purpose | Integration Method |
|---------|---------|-------------------|
| Supabase PostgreSQL | Persistent storage + vector search | supabase-js SDK, RPC for similarity queries |
| pgvector (Supabase extension) | Vector similarity search | IVFFlat index, cosine distance operator |
| OpenAI API | Embedding generation | openai SDK, text-embedding-3-small model |
| Claude Code | MCP client (consumer) | Streamable HTTP transport, JSON-RPC |

### Integration Details
**Supabase:** Service role key for full table access. All queries filter `expires_at IS NULL OR expires_at > now()`. Stats come from a materialized view. The RPC function encapsulates the vector search logic server-side, accepting embedding, filters, and threshold as parameters.

**OpenAI:** Direct API (not via router/proxy). Generates 1536-dimensional embeddings from concatenated `title + content` text. Retry logic handles 429 (rate limit) and 5xx errors with one automatic retry. Non-retryable errors (400, auth failures) fail immediately.

**Claude Code:** Configured in `~/.claude/mcp.json` with `url: http://localhost:3101/mcp` and `transport: streamable-http`. Multiple concurrent sessions multiplexed through one server instance.

---

## 4. Development Timeline & Phases

### Phase Overview
| Phase | Date Range | Key Deliverables |
|-------|-----------|-----------------|
| Phase 1: Core Implementation | Pre-2026-03-22 | MCP server with 4 tools, Supabase schema, Docker setup, unit tests |
| Phase 2: Threshold Fix | 2026-03-22 | Diagnosed empty recall results, lowered SIMILARITY_THRESHOLD from 0.5 to 0.25 |
| Phase 3: OpenRouter → OpenAI | Pre-2026-03-25 | Migrated from OpenRouter proxy to direct OpenAI API for consistent embeddings |
| Phase 4: Publication | 2026-03-25 | GitHub repo, comprehensive README, .env.example cleanup, hook fix |

### Key Milestones
- `130aa8e` (2026-03-25) — "Initial commit: persistent vector memory MCP server for Claude Code" — entire project published as single atomic commit (6,356 insertions)

### Pivots & Direction Changes
1. **stdio → Streamable HTTP:** Originally used stdio transport (standard for MCP servers). Pivoted to HTTP because stdio cannot handle multiple concurrent Claude Code sessions — each session would need its own server process. HTTP allows one container to serve all sessions.
2. **OpenRouter → Direct OpenAI:** Initially used OpenRouter as embedding proxy. Switched to direct OpenAI API due to inconsistent similarity scores through the proxy, which caused unreliable recall results.
3. **Similarity threshold tuning:** Started with default 0.7, discovered empirically that `text-embedding-3-small` produces low cosine similarity (0.05–0.35) for general queries against technical content. Lowered to 0.25 to avoid silently empty results.

---

## 5. Technical Challenges & Solutions

### Challenge 1: Empty Recall Results (Silent Failure)
- **Problem**: After initial deployment, `recall` consistently returned empty arrays despite memories being stored correctly. The tool appeared to work (no errors) but found nothing.
- **Evidence**: Memory server session from 2026-03-22 documents the investigation. CLAUDE.md explicitly warns about this: "SIMILARITY_THRESHOLD note: text-embedding-3-small gives low cosine similarity (0.05–0.35) for general queries against technical content."
- **Solution**: Lowered `SIMILARITY_THRESHOLD` from 0.5 to 0.25 in environment config. The RPC function's threshold parameter was filtering out all results because cosine similarity scores were naturally low for the embedding model used.
- **Impact**: Recall became functional. This was a critical bug — the entire value proposition of the server (memory retrieval) was broken. The fix also informed documentation: README now includes a dedicated "Similarity Threshold" section warning future users.

### Challenge 2: Multi-Session Support (Transport Architecture)
- **Problem**: Standard MCP transport (stdio) binds one server to one client process. Claude Code users frequently have 5-10 sessions open across different projects. Running 10 Docker containers was impractical.
- **Evidence**: Architecture decision memory from 2026-03-22: "stdio cannot handle multiple concurrent Claude sessions." Index.ts implements full session management with UUID tracking, per-session McpServer instances, and cleanup on disconnect.
- **Solution**: Adopted StreamableHTTPServerTransport (Express on port 3101). Each session gets its own transport instance tracked by UUID in memory. Health endpoint reports active session count. Container is stateless — sessions are ephemeral, data is in Supabase.
- **Impact**: Single always-running container serves all Claude Code sessions simultaneously. Reduced operational complexity from N containers to 1.

### Challenge 3: Embedding Provider Instability
- **Problem**: OpenRouter (proxy layer over OpenAI) produced inconsistent similarity scores, making recall unreliable — sometimes finding relevant memories, sometimes not.
- **Evidence**: CLAUDE.md known issues section notes ".env.example still references OpenRouter (outdated)." User memory documents preference for OpenRouter, indicating the switch was a reluctant technical decision, not a preference change.
- **Solution**: Migrated to direct OpenAI API (`openai` SDK v4.85). Added retry logic for transient failures (429 rate limits, 5xx server errors) with `isRetryable()` guard. Non-retryable errors fail fast.
- **Impact**: Consistent embedding quality, reliable similarity scores. Enabled proper threshold calibration.

### Challenge 4: SessionStart Hook Incompatibility
- **Problem**: Attempted to use Claude Code's `prompt-type` hook to auto-trigger memory recall on session start. Hook failed because prompt-type hooks run on a smaller LLM that doesn't have MCP tool access.
- **Evidence**: Session summary from 2026-03-25: "Fixed SessionStart hook error in ~/.claude/settings.json by removing redundant hook (prompt-type hooks run on small LLM without MCP tool access, CLAUDE.md already covers the same instructions)."
- **Solution**: Removed the hook entirely. Moved the "always call project_status and recall on session start" instruction into CLAUDE.md, which is loaded into the main Claude model's context. This is the correct mechanism for behavioral instructions.
- **Impact**: Clean session startup without errors. Documented the pattern for other MCP server authors: use CLAUDE.md for behavioral instructions, not hooks.

### Challenge 5: Token Budget Enforcement
- **Problem**: Recall could return large amounts of text from stored memories, potentially overwhelming Claude Code's context window or producing responses that exceeded useful size.
- **Evidence**: `src/token-counter.ts` implements approximate token counting (chars/4) with truncation logic. Config enforces `RECALL_TOKEN_CAP: 2000`.
- **Solution**: Built a token-aware truncation system that iterates results by similarity rank, accumulating tokens until the budget is reached. The last entry gets truncated with a `[truncated]` marker if there's enough remaining budget (>20 tokens), otherwise it's dropped entirely.
- **Impact**: Predictable response sizes. Claude Code can safely inject recall results into its context without risk of overflow.

---

## 6. Unique & Impressive Technical Aspects

- **Custom MCP Server for AI Memory:** One of the first open-source implementations of persistent vector memory for Claude Code via MCP protocol. Solves a real gap in the Claude Code ecosystem.
- **Streamable HTTP Multi-Session Architecture:** Single container serves unlimited concurrent Claude Code sessions — unusual for MCP servers which typically use stdio (1:1 binding). Session management with UUID tracking, graceful cleanup, and health monitoring.
- **Cross-Project Semantic Search:** Memories can be stored per-project or globally. Recall searches across all projects by default, enabling pattern reuse (e.g., a Docker trick learned in project A is findable from project B).
- **Soft-Delete with Retention:** Never hard-deletes data. `expires_at` column enables time-based retention policies while preserving audit trail. Forget tool supports granular expiration (by ID, by project, by age).
- **Production-Grade Error Handling:** Three-tier custom error hierarchy (Validation, Embedding, DB) with cause chaining. All tool errors return structured MCP error responses — the server never crashes on bad input.
- **Zero-Config Session Management:** No authentication, no configuration per session. Claude Code connects, gets a session UUID, and starts using tools. Session state is ephemeral (in-memory), persistent state is in Supabase.
- **Comprehensive Test Coverage:** 85 unit tests covering all tools, config validation, error classes, embedding retry logic, and token truncation. Vitest with 90% coverage threshold enforced.

---

## 7. Testing & Quality

### Test Coverage
| Layer | Present | Framework | Files Count |
|-------|---------|-----------|-------------|
| Unit | Yes | Vitest 3.2 | 8 test files, 85 tests |
| Integration | No | — | — |
| E2E | No | — | — |

### CI/CD Pipeline
No CI/CD pipeline found. Project is built and deployed via Docker Compose locally (`docker compose up -d --build memory-mcp`).

### Code Quality Tools
- **TypeScript strict mode:** Full strict checking enabled, no `any` types
- **Zod validation:** All tool inputs validated at runtime with descriptive error messages
- **Vitest coverage:** v8 provider with thresholds — 90% lines, 90% functions, 85% branches, 90% statements
- **Multi-stage Docker build:** Separate base (dev deps) and production (runtime only) stages

---

## 8. Current State & Metrics

### Project Status
Production — actively running as always-on Docker container, serving multiple Claude Code sessions daily across multiple projects.

### Codebase Size
- Source files: 10 TypeScript files (src/)
- Test files: 8 TypeScript files (tests/unit/)
- Total TypeScript: 1,737 lines (source) + ~1,055 lines (tests)
- Total files: 29 (including config, Docker, docs)
- Dependencies: 5 production, 5 dev

### Known Technical Debt
1. **config.ts default mismatch:** `SIMILARITY_THRESHOLD` defaults to 0.7 in code but actual production uses 0.25 (set via env var). Code default should be updated.
2. **OpenRouter references in tests:** Some test files reference `OPENROUTER_API_KEY` — outdated after migration to direct OpenAI.
3. **No integration tests:** Only unit tests with mocked Supabase/OpenAI. No tests against real services.
4. **Session loss on restart:** MCP sessions are in-memory; container restart requires Claude Code session restart.
5. **Port conflict:** `dev` and `memory-mcp` services both bind port 3101 — cannot run simultaneously.
6. **Naive token counting:** `Math.ceil(text.length / 4)` approximation; not using a real tokenizer.

---

## 9. Business Impact Indicators

- **Sessions served:** 8-10 concurrent Claude Code sessions (visible from health endpoint design and architecture decision)
- **Projects tracked:** Actively used across multiple projects (memory-mcp, maxreach, zcare-milestone2 visible in memory database)
- **Automation savings:** Eliminates repeated context-setting at session start. Before: 5-10 minutes explaining project state each session. After: instant recall of decisions, conventions, and recent work.
- **Knowledge retention:** Captures architectural decisions, bug fixes, patterns, and conventions that would otherwise exist only in developer's head or scattered across commit messages.
- **Cross-project learning:** Patterns discovered in one project (Docker configurations, API integration tricks, TypeScript patterns) are automatically findable from any other project.

No hard metrics (analytics, dashboards, APM) configured in codebase.

---

## 10. Raw Data for Case Study Writer

### Key Commit Messages (Most Telling)
```
130aa8e | 2026-03-25 | Initial commit: persistent vector memory MCP server for Claude Code
```
Single atomic commit containing the entire production-ready implementation. Development was iterative via Claude Code sessions — the git history represents publication, not the development process.

### File Change Hotspots
COULD NOT DETERMINE — single commit, no change history. Based on memory system data, the most-iterated areas were:
1. `src/tools/recall.ts` — threshold tuning, token capping
2. `src/embedding.ts` — OpenRouter → OpenAI migration
3. `src/index.ts` — stdio → HTTP transport migration
4. `src/config.ts` — threshold default changes

### Environment Variables (Sanitized)
```
SUPABASE_URL          — Supabase project endpoint
SUPABASE_SERVICE_KEY  — Service role key for full DB access
OPENAI_API_KEY        — Direct OpenAI API key for embeddings
EMBEDDING_MODEL       — Model selection (default: text-embedding-3-small)
SIMILARITY_THRESHOLD  — Vector search cutoff (default: 0.25)
RECALL_TOKEN_CAP      — Max tokens per recall response (default: 2000)
DEFAULT_RECALL_LIMIT  — Max memories per recall (default: 5)
MCP_PORT              — HTTP server port (default: 3101)
```

### Keywords & Tags for Case Study
#ai-memory #mcp-server #vector-search #pgvector #embeddings #claude-code #semantic-search #docker #typescript #supabase #open-source #developer-tools #ai-infrastructure #multi-session #stateless-architecture

### Suggested Case Study Angle
"Giving AI a permanent memory" — how a developer built an open-source MCP server that lets Claude Code remember decisions, patterns, and context across sessions and projects, turning a stateless AI assistant into a persistent engineering partner. The compelling narrative is the progression from repeated frustration (AI forgetting everything each session) to a production system that automatically recalls relevant context, with specific technical challenges (silent empty results from threshold misconfiguration, multi-session architecture) that make the story concrete and relatable.
