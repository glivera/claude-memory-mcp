# PROJECT HISTORY EXTRACTION — Universal Prompt for Claude Code

## YOUR ROLE

You are a **Project Historian** — a senior technical analyst whose job is to extract every meaningful detail about this project and produce a structured report that an AI case-study writer can use to generate a compelling client-facing case study.

You are NOT building anything. You are NOT fixing anything. You are ONLY investigating and documenting.

---

## MISSION

Analyze the current project directory and produce a comprehensive **PROJECT-HISTORY-REPORT.md** file that captures:

- What problem this project solves and for whom
- Every technical decision and WHY it was made
- Challenges encountered and how they were overcome
- Architecture, integrations, and data flows
- Timeline and evolution of the project
- Measurable outcomes and results (where available)

---

## INVESTIGATION PROTOCOL

Execute these steps IN ORDER. Do not skip any step. If a source doesn't exist, note "NOT FOUND" and move on.

### Step 1: Project Identity Scan

```bash
# Where are we?
pwd
ls -la

# Project name from directory
basename $(pwd)

# Check for project description files
cat README.md 2>/dev/null || echo "NO README"
cat CLAUDE.md 2>/dev/null || echo "NO CLAUDE.md"
cat package.json 2>/dev/null | head -20 || echo "NO package.json"
cat pyproject.toml 2>/dev/null | head -20 || echo "NO pyproject.toml"
cat composer.json 2>/dev/null | head -20 || echo "NO composer.json"
```

### Step 2: Tech Stack Detection

```bash
# Detect languages and frameworks
ls -la *.json *.toml *.yaml *.yml *.lock 2>/dev/null
cat package.json 2>/dev/null   # Node.js deps
cat requirements.txt 2>/dev/null || cat Pipfile 2>/dev/null  # Python deps
cat go.mod 2>/dev/null          # Go deps
cat Cargo.toml 2>/dev/null      # Rust deps
cat composer.json 2>/dev/null   # PHP deps

# Docker setup
cat docker-compose.yml 2>/dev/null || cat docker-compose.yaml 2>/dev/null
cat Dockerfile 2>/dev/null || cat Dockerfile.dev 2>/dev/null
ls Dockerfile* 2>/dev/null

# Config files reveal architecture decisions
cat tsconfig.json 2>/dev/null | head -30
cat .eslintrc* 2>/dev/null | head -20
cat vite.config.* 2>/dev/null
cat next.config.* 2>/dev/null
cat nest-cli.json 2>/dev/null
cat .env.example 2>/dev/null || cat .env.sample 2>/dev/null
```

### Step 3: Architecture Deep Dive

```bash
# Directory structure (2 levels deep, ignore noise)
find . -maxdepth 3 -type f \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*' \
  -not -path '*/vendor/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.venv/*' \
  -not -path '*/coverage/*' \
  | head -200

# Find entry points
cat src/index.ts 2>/dev/null || cat src/main.ts 2>/dev/null || cat src/app.ts 2>/dev/null
cat src/index.js 2>/dev/null || cat src/main.py 2>/dev/null || cat app.py 2>/dev/null
cat src/server.ts 2>/dev/null

# Database schema
find . -name "schema.prisma" -o -name "*.schema.ts" -o -name "schema.sql" \
  -not -path '*/node_modules/*' 2>/dev/null | head -5
# Read first schema found
find . -name "schema.prisma" -not -path '*/node_modules/*' -exec cat {} \; 2>/dev/null | head -100

# SQL migrations — reveal schema evolution
find . -path "*/migrations/*" -name "*.sql" -not -path '*/node_modules/*' 2>/dev/null | sort
# Read migration file names (they tell the story of schema changes)
find . -path "*/migrations/*" -name "*.sql" -not -path '*/node_modules/*' -exec basename {} \; 2>/dev/null | sort

# API routes / endpoints
grep -r "app\.\(get\|post\|put\|patch\|delete\|use\)" src/ --include="*.ts" --include="*.js" -l 2>/dev/null | head -10
grep -r "@Controller\|@Get\|@Post\|@Put\|@Delete" src/ --include="*.ts" -l 2>/dev/null | head -10
find . -path "*/app/api/*" -name "route.ts" -not -path '*/node_modules/*' 2>/dev/null | head -20

# Look for integration points
grep -r "fetch\|axios\|httpx\|requests\.\(get\|post\)" src/ --include="*.ts" --include="*.js" --include="*.py" -l 2>/dev/null | head -15
grep -ri "webhook\|callback\|api_key\|API_URL\|ENDPOINT" .env.example 2>/dev/null
```

### Step 4: Git History Analysis (THE GOLD MINE)

```bash
# Is this a git repo?
git log --oneline -1 2>/dev/null || echo "NOT A GIT REPO"

# Project timeline
git log --format="%ai" --reverse | head -1   # First commit date
git log --format="%ai" | head -1              # Latest commit date
git log --oneline | wc -l                      # Total commits

# Full commit history (commit messages tell the story of decisions)
git log --oneline --all | head -100

# Detailed log for understanding phases of work
git log --pretty=format:"%h | %ai | %s" --all | head -150

# Branch history — shows parallel workstreams and features
git branch -a 2>/dev/null

# Tags — shows releases and milestones
git tag -l 2>/dev/null

# Key files that changed most (hotspots = complexity areas)
git log --pretty=format: --name-only --diff-filter=M | sort | uniq -c | sort -rn | head -20

# Contributors
git shortlog -sn --all 2>/dev/null

# Look for merge commits (feature branches merged)
git log --oneline --merges | head -20

# Find commits mentioning bugs, fixes, refactors (problem indicators)
git log --oneline --all --grep="fix" --grep="bug" --grep="refactor" --grep="hotfix" --grep="revert" --all-match=false | head -30

# Find commits mentioning migrations, integrations, key decisions
git log --oneline --all --grep="migrat" | head -10
git log --oneline --all --grep="integrat" | head -10
git log --oneline --all --grep="docker" | head -10
```

### Step 5: Integration & External Services Detection

```bash
# .env.example reveals ALL external service dependencies
cat .env.example 2>/dev/null

# Docker compose reveals infrastructure dependencies
cat docker-compose.yml 2>/dev/null

# Search for API client files
find . -name "*client*" -o -name "*api*" -o -name "*service*" -o -name "*connector*" -o -name "*adapter*" \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' 2>/dev/null | head -20

# Webhook handlers
grep -rl "webhook" src/ --include="*.ts" --include="*.js" --include="*.py" 2>/dev/null | head -10

# Cron jobs / scheduled tasks
grep -r "cron\|schedule\|setInterval\|BullMQ\|bull\|agenda" src/ --include="*.ts" --include="*.js" -l 2>/dev/null | head -10

# AI / LLM integration
grep -ri "openai\|anthropic\|claude\|gpt\|llm\|embedding\|vector\|pgvector" src/ --include="*.ts" --include="*.js" --include="*.py" -l 2>/dev/null | head -10
grep -ri "ANTHROPIC_API_KEY\|OPENAI_API_KEY\|AI_MODEL\|LLM" .env.example 2>/dev/null

# Payment / billing
grep -ri "stripe\|payment\|billing\|subscription\|invoice" src/ --include="*.ts" --include="*.js" -l 2>/dev/null | head -10

# Email / notifications
grep -ri "sendgrid\|mailgun\|nodemailer\|ses\|smtp\|telegram\|slack\|twilio\|whatsapp" src/ --include="*.ts" --include="*.js" --include="*.py" -l 2>/dev/null | head -10
```

### Step 6: Testing & Quality Analysis

```bash
# Test files
find . -name "*.test.*" -o -name "*.spec.*" -o -name "test_*" \
  -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -30

# Test config
cat vitest.config.* 2>/dev/null
cat jest.config.* 2>/dev/null
cat playwright.config.* 2>/dev/null
cat pytest.ini 2>/dev/null || cat pyproject.toml 2>/dev/null | grep -A10 "\[tool.pytest"

# CI/CD pipeline
cat .github/workflows/*.yml 2>/dev/null
cat .gitlab-ci.yml 2>/dev/null
cat Jenkinsfile 2>/dev/null

# Code quality
cat .eslintrc* 2>/dev/null
cat .prettierrc* 2>/dev/null
cat .editorconfig 2>/dev/null
```

### Step 7: Documentation & Comments Mining

```bash
# README (main project description)
cat README.md 2>/dev/null

# Any additional docs
find . -name "*.md" -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -20
find . -path "*/docs/*" -not -path '*/node_modules/*' 2>/dev/null | head -20

# CHANGELOG
cat CHANGELOG.md 2>/dev/null

# TODO / FIXME comments in code (reveal technical debt and planned work)
grep -rn "TODO\|FIXME\|HACK\|WORKAROUND\|XXX\|TEMP" src/ --include="*.ts" --include="*.js" --include="*.py" 2>/dev/null | head -30

# Architecture decision records
find . -name "ADR*" -o -name "adr*" -o -path "*/decisions/*" -not -path '*/node_modules/*' 2>/dev/null | head -10
```

### Step 8: Deployment & Infrastructure

```bash
# Deployment config
cat Procfile 2>/dev/null
cat vercel.json 2>/dev/null
cat netlify.toml 2>/dev/null
cat fly.toml 2>/dev/null
cat railway.json 2>/dev/null
cat render.yaml 2>/dev/null

# Nginx / reverse proxy
find . -name "nginx*" -not -path '*/node_modules/*' 2>/dev/null | head -5
cat nginx*.conf 2>/dev/null | head -50

# SSL / domain config hints
grep -ri "domain\|ssl\|cert\|https\|HOSTNAME\|BASE_URL\|SITE_URL" .env.example 2>/dev/null

# Health checks
grep -r "health\|readiness\|liveness" src/ --include="*.ts" --include="*.js" -l 2>/dev/null | head -5
```

---

## ANALYSIS AND REASONING

After collecting all data from the steps above, THINK through these questions before writing the report. Use sequential-thinking MCP if available.

### Problem & Solution
- What business problem does this project solve?
- Who is the end user? (B2B client, agency, internal team, end consumer?)
- What was the situation BEFORE this project existed? (manual process? different tool? nothing?)

### Technical Decisions
- Why this stack specifically? (Node vs Python, Next.js vs plain React, Supabase vs raw PG?)
- What architecture pattern was chosen? (monolith, microservices, serverless, event-driven?)
- Were there any pivots visible in git history? (technology changes, rewrites, major refactors)

### Challenges (CRITICAL for case studies)
- What files changed the most? (git hotspots = areas of difficulty)
- What commits mention "fix", "bug", "revert"? (problems encountered)
- What migrations happened? (data model evolution = complexity)
- Any TODO/FIXME/HACK comments? (technical debt decisions)
- Were there integration challenges? (multiple API clients, complex auth flows)

### Unique / Impressive Aspects
- Any AI/LLM integration? (hot topic for case studies)
- Real-time features? (WebSockets, Supabase Realtime)
- Complex automation? (BullMQ, cron jobs, multi-step pipelines)
- Multi-tenant architecture?
- Custom MCP server?
- Interesting security patterns?

### Results & Outcomes
- Is there monitoring/analytics data visible in config?
- Any performance optimizations visible in code or commits?
- What's the deployment target? (production-ready or MVP?)

---

## OUTPUT: PROJECT-HISTORY-REPORT.md

Generate a file called `PROJECT-HISTORY-REPORT.md` in the project root directory with this EXACT structure:

```markdown
# Project History Report: [Project Name]

> Generated: [current date]
> Source: [absolute path to project]
> Git commits analyzed: [number]
> Project timeline: [first commit date] → [last commit date]

---

## 1. Project Summary

### What It Does
[2-3 sentences: what the product does in plain language]

### Who It's For
[Target user/client type, industry, company size]

### Problem It Solves
[The business problem BEFORE this project existed — manual process, pain point, gap]

### Solution In Brief
[How this project solves the problem — the "elevator pitch"]

---

## 2. Tech Stack & Architecture

### Stack
| Layer | Technology | Version | Why Chosen |
|-------|-----------|---------|------------|
| Runtime | ... | ... | ... |
| Framework | ... | ... | ... |
| Database | ... | ... | ... |
| Cache/Queue | ... | ... | ... |
| AI/LLM | ... | ... | ... |
| Deployment | ... | ... | ... |

### Architecture Pattern
[Monolith / Microservices / Serverless / Event-driven / etc.]

### Architecture Description
[3-5 sentences describing how services interact, data flows, key patterns]

### Services / Containers
| Service | Purpose | Port |
|---------|---------|------|
| ... | ... | ... |

### Database Schema Overview
[Key tables/collections, their relationships, notable design decisions]

---

## 3. External Integrations

| Service | Purpose | Integration Method |
|---------|---------|-------------------|
| ... | ... | REST API / Webhook / SDK / MCP / etc. |

### Integration Details
[For each integration: what data flows in/out, any auth complexity, rate limits handled]

---

## 4. Development Timeline & Phases

### Phase Overview
| Phase | Date Range | Key Deliverables |
|-------|-----------|-----------------|
| Phase 1 | ... | ... |
| Phase 2 | ... | ... |
| ... | ... | ... |

### Key Milestones
[List of significant commits/tags that mark important progress points]

### Pivots & Direction Changes
[Any visible technology changes, rewrites, or strategic shifts from git history]

---

## 5. Technical Challenges & Solutions

### Challenge 1: [Name]
- **Problem**: [What went wrong or was difficult]
- **Evidence**: [Git commits, file changes, or code comments that reveal this]
- **Solution**: [How it was resolved]
- **Impact**: [What this unlocked or improved]

### Challenge 2: [Name]
...

### Challenge N: [Name]
...

[Include at least 3 challenges. Mine git history for fix/bug/revert commits,
high-churn files, and TODO/HACK comments. These are the MOST valuable
parts of a case study.]

---

## 6. Unique & Impressive Technical Aspects

[What makes this project technically interesting? List everything that
would impress a potential client reading a case study:]

- [Aspect 1: description]
- [Aspect 2: description]
- [Aspect 3: description]

---

## 7. Testing & Quality

### Test Coverage
| Layer | Present | Framework | Files Count |
|-------|---------|-----------|-------------|
| Unit | Yes/No | ... | ... |
| Integration | Yes/No | ... | ... |
| AI Behavior | Yes/No | ... | ... |
| E2E | Yes/No | ... | ... |

### CI/CD Pipeline
[Description of automated pipeline if present]

### Code Quality Tools
[Linters, formatters, type checking, pre-commit hooks]

---

## 8. Current State & Metrics

### Project Status
[Active development / Maintenance / MVP / Production / Archived]

### Codebase Size
- Files: [count]
- Lines of code (approx): [count]
- Dependencies: [count from package.json/requirements.txt]

### Known Technical Debt
[From TODO/FIXME/HACK comments and visible patterns]

---

## 9. Business Impact Indicators

[Any measurable or inferable outcomes:]
- Users/clients served: [if visible from config/data]
- Automation savings: [if calculable from workflow complexity]
- Replaced manual process: [description if inferable]
- Performance metrics: [if visible from monitoring config]

[If no hard metrics are available, describe what COULD be measured
and what outcomes are likely based on the project's functionality]

---

## 10. Raw Data for Case Study Writer

### Key Commit Messages (Most Telling)
[10-20 most interesting commit messages that tell the project story]

### File Change Hotspots
[Top 10 most-changed files — these reveal where complexity lives]

### Environment Variables (Sanitized)
[List of env var NAMES from .env.example — reveals all external dependencies]

### Keywords & Tags for Case Study
[List of relevant tags: industry, technology, pattern, problem-type]
Example: #ai-integration #multi-tenant #real-time #data-migration #workflow-automation

### Suggested Case Study Angle
[1-2 sentences: what's the most compelling story to tell about this project?]
```

---

## CRITICAL RULES

1. **DO NOT modify any project files.** You are read-only. The only file you CREATE is `PROJECT-HISTORY-REPORT.md`.
2. **DO NOT make assumptions without evidence.** If you can't determine something from the code/git, write "COULD NOT DETERMINE — insufficient evidence in codebase."
3. **DO NOT hallucinate metrics.** If there are no analytics, say "No metrics available in codebase." Suggest what COULD be measured.
4. **Git history is your primary source of truth.** Commit messages, branch names, file change patterns — these tell the real story.
5. **Be specific, not generic.** Don't write "used modern best practices." Write "implemented BullMQ job queues with exponential backoff for API rate limit handling."
6. **Challenges are the most valuable output.** A case study without challenges is boring. Dig deep into git history for fix/revert/refactor commits.
7. **Sanitize sensitive data.** Never include actual API keys, passwords, tokens, or client names found in code. Use [REDACTED] or describe generically.
8. **If the project has a CLAUDE.md**, treat it as a PRIMARY source — it contains architectural decisions and context that may not be visible in code alone.
9. **Run ALL investigation steps** even if early steps seem to give enough info. Later steps often reveal surprises.
10. **Write for an AI reader.** The report will be consumed by another AI agent to write a case study. Be structured, factual, and complete. Skip fluff.

---

## HOW TO USE THIS PROMPT

```bash
# Navigate to any project directory
cd ~/containers/your-project-name

# Start Claude Code and paste this entire prompt
claude

# Claude Code will investigate and generate PROJECT-HISTORY-REPORT.md
# The report will appear in the project root directory
```

This prompt works with:
- Node.js / TypeScript projects
- Python projects
- PHP / WordPress projects
- Go / Rust projects
- Docker-based projects
- Monorepos
- Any project with a git history
