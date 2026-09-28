# Sales CRM — System Overview

## Stack

- **Runtime:** Node.js + NestJS 11
- **ORM:** Prisma 6 → PostgreSQL (localhost:5433, db: `ai_dashboard`)
- **Auth:** JWT (access + refresh), passport-jwt
- **Queue:** BullMQ + Redis
- **AI:** Anthropic SDK (`claude-*`) — Job-Post gatekeeper + evaluator only
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
├── auth/              JWT auth, guards, roles/permissions
├── account/           Developer accounts (Upwork profile, LinkedIn profile)
├── platform/          Platforms (Upwork, LinkedIn) — seeded on deploy
├── proposal/          Proposals (detail / update / delete; created from Job-Post)
├── job-post/          Job posts staging + AI gatekeeper/evaluator
├── lead/              Leads (from proposals or standalone)
├── client-requests/   Inbound client form submissions
├── client-calls/      Scheduled calls with leads or client requests
├── invoice/           Invoices with line items + PDF generation
├── counterparty/      Invoice recipients (client | contractor)
├── prompt/            AI prompt templates (JOB_GATEKEEPER + JOB_EVALUATION)
├── ai/                Anthropic service wrappers
├── notification/      Discord notifications via BullMQ
├── settings/          Runtime settings (key/value)
├── audit-log/         Audit trail
├── roles/             Roles + permissions + user assignment
├── storage/           Backblaze B2 helpers
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
 ├── Lead? (1:1, proposalId on Lead)
 └── JobPost? (1:1)

JobPost (staging)
 └── Proposal? (after conversion)

Lead
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
1. Job post is staged as `JobPost` (status: NEW) by an external ingestion path.
2. AI evaluates `JobPost` via `JOB_GATEKEEPER` + `JOB_EVALUATION` prompts → sets `decision`, `matchScore`, `aiResponse`.
3. Manager converts `JobPost` → `Proposal` (via `/job-posts/:id/to-proposal`).
4. Manager promotes `Proposal` → `Lead` (via `/proposals/:id/lead`).
5. Standalone lead can also be created directly via `POST /leads`.

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

### AI prompts
- Prompt templates managed via `/prompts` (types: `JOB_GATEKEEPER`, `JOB_EVALUATION`).
- One active row per type; used by `AiJobEvaluatorService` during Job-Post processing.

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
- Lead deleted → ClientCall deleted (CASCADE)
- ClientRequest deleted → ClientCall deleted (CASCADE)
- Invoice deleted → InvoiceLineItems deleted (CASCADE)

---

## Notifications
- Type: `CALL_REMINDER | JOB_POST_MATCH | CLIENT_REQUEST`
- Channel: Discord only (currently)
- Stored as `NotificationEvent` + `NotificationDelivery` (status: PENDING → SENT | FAILED)

---

## Migrations
Located in `prisma/migrations/`. Run with:
```bash
npx prisma migrate dev --name <name>
```
Config loaded from `prisma.config.ts` (not `.env` directly).
