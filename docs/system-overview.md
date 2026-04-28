# Sales CRM — System Overview

## Stack

- **Runtime:** Node.js + NestJS 11
- **ORM:** Prisma 6 → PostgreSQL (localhost:5433, db: `ai_dashboard`)
- **Auth:** JWT (access + refresh), passport-jwt
- **Queue:** BullMQ + Redis
- **AI:** Anthropic SDK (`claude-*`) + OpenAI SDK
- **Real-time:** Socket.io (WebSockets)
- **Notifications:** Discord (BullMQ queue)
- **File storage:** Backblaze B2 (transcript URLs stored as plain strings in DB)

---

## Auth

- `POST /auth/register` → create user
- `POST /auth/login` → `{ accessToken, refreshToken }`
- All routes protected by `JwtAuthGuard`
- Current user accessed via `@Request() req` → `req.user.id`
- JWT payload: `{ sub: userId, email, role }`
- Roles: `ADMIN | MANAGER`

---

## Module Structure

```
src/
├── auth/              JWT auth, guards, roles
├── account/           Developer accounts (Upwork profile, LinkedIn profile)
├── platform/          Platforms (Upwork, LinkedIn) — seeded on deploy
├── proposal/          Proposals with AI chat, source: telegram | manual
├── job-post/          Telegram job posts staging, AI scoring/parsing
├── lead/              Leads (from proposals or standalone)
├── client-requests/   Inbound client form submissions
├── client-calls/      Scheduled calls with leads or client requests
├── chat/              Chat sessions (linked to proposal or lead)
├── invoice/           Invoices with line items + PDF generation
├── counterparty/      Invoice recipients (client | contractor)
├── base-knowledge/    Vector embeddings for AI context (pgvector)
├── prompt/            AI prompt templates (CRUD, versioned, one active per type)
├── ai/                Anthropic/OpenAI service wrappers
├── notification/      Discord notifications via BullMQ
├── telegram/          Telegram bot listener → job-post staging
└── prisma/            PrismaService (extends PrismaClient)
```

---

## Entity Relationships

```
User
 ├── Proposal[] (userId FK)
 ├── Account[] (userId FK)
 └── ClientCall[] (createdById FK)

Platform
 ├── Account[]
 └── Proposal[]

Account (developer profile on a platform)
 └── Proposal[]

Proposal
 ├── Chat? (1:1)
 ├── Lead? (1:1, proposalId on Lead)
 └── JobPost? (1:1)

JobPost (Telegram staging)
 └── Proposal? (after conversion)

Chat
 ├── ChatMessage[]
 ├── Proposal? (optional link)
 └── Lead? (optional link)

Lead
 ├── Chat? (1:1, created on lead creation)
 ├── Proposal? (optional backlink)
 └── ClientCall[] (leadId FK, CASCADE DELETE)

ClientRequest (inbound form)
 └── ClientCall[] (clientRequestId FK, CASCADE DELETE)

ClientCall
 ├── Lead? (leadId FK)
 ├── ClientRequest? (clientRequestId FK)
 └── createdBy User

Counterparty
 └── Invoice[]

Invoice
 └── InvoiceLineItem[]
```

---

## Key Business Flows

### Proposal → Lead flow
1. Job post comes from Telegram → staged as `JobPost` (status: NEW)
2. AI evaluates `JobPost` → sets `decision`, `matchScore`, `aiResponse`
3. Manager converts `JobPost` → `Proposal` (via `/job-posts/:id/convert`)
4. Manager promotes `Proposal` → `Lead` (via `/proposals/:id/lead`)
5. Lead gets a `Chat` automatically (inherits from proposal's chat)
6. Standalone lead can also be created directly via `POST /leads`

### Lead — display name logic
Lead may have no name (created from proposal, only proposalId set).
`GET /leads` returns `proposal: { id, title }` in each lead.
Frontend display priority: `firstName lastName` → `proposal.title` → `id`

### Client Calls flow
1. Select `clientType: "lead" | "client_request"`
2. Fetch leads (`GET /leads`) or client requests for dropdown
3. `POST /client-calls` with `leadId` or `clientRequestId`, `scheduledAt` (UTC), `clientTimezone`, `duration`
4. Server computes and returns `clientDateTime` + `kyivDateTime` on every response (not stored in DB)
5. After call: `PATCH /client-calls/:id` → set `status: completed`, `notes`, `summary`, `transcriptUrl`, `aiSummary`
6. `transcriptUrl` = Backblaze B2 URL, uploaded separately, then patched onto the call

### Chat / AI
- Each Proposal and Lead has one Chat with ChatMessages
- AI uses `base-knowledge` (pgvector embeddings) for context
- Prompt templates managed via `/prompts` (type: JOB_GATEKEEPER | JOB_EVALUATION | CHAT_SYSTEM | CHAT_FALLBACK)

---

## Timezone handling (ClientCall)
- `scheduledAt` stored as UTC (`DateTime` / `TIMESTAMP(3)`)
- `clientTimezone` stored as string: IANA (`America/New_York`) or fixed offset (`+05:00`)
- `clientDateTime` / `kyivDateTime` computed via `Intl.DateTimeFormat` (IANA) or manual offset math
- Frontend uses **luxon** for preview before save; backend is source of truth

---

## Common Patterns

### CRUD pattern (all modules follow this)
```
Controller  → @UseGuards(JwtAuthGuard), @Request() req for userId
Service     → PrismaService injected, throws NotFoundException / BadRequestException
DTO         → class-validator decorators, @ApiProperty for Swagger
Module      → exports Service for cross-module use
```

### Pagination (standard across all list endpoints)
```
GET /resource?page=1&limit=10
Response: { data: [...], total: N }
```

### Cascade delete
- Lead deleted → Chat deleted (if no proposalId) or unlinked
- Lead deleted → ClientCall deleted (CASCADE)
- ClientRequest deleted → ClientCall deleted (CASCADE)
- Invoice deleted → InvoiceLineItems deleted (CASCADE)
- Chat deleted → ChatMessages deleted (CASCADE)

---

## Notifications
- Type: `CALL_REMINDER | JOB_POST_MATCH | CLIENT_REQUEST`
- Channel: Discord only (currently)
- Stored as `NotificationEvent` + `NotificationDelivery` (status: PENDING → SENT | FAILED)
- Discord/Telegram listeners disabled in current branch (`DISABLE LISTENERS` commit)

---

## Migrations
Located in `prisma/migrations/`. Run with:
```bash
npx prisma migrate dev --name <name>
```
Config loaded from `prisma.config.ts` (not `.env` directly).
