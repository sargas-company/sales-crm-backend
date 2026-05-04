import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaClient, PromptType, UserRole } from '@prisma/client';
import { JOB_GATEKEEPER_PROMPT } from '../src/ai/prompts/job-gatekeeper.prompt';
import { JOB_EVALUATION_PROMPT } from '../src/ai/prompts/job-evaluation.prompt';
import { CHAT_CLASSIFIER_PROMPT } from '../src/ai/prompts/chat-classifier.prompt';
import { CHAT_SUMMARY_PROMPT } from '../src/ai/prompts/chat-summary.prompt';
import { KNOWLEDGE_TITLE_FILTER_PROMPT } from '../src/ai/prompts/knowledge-title-filter.prompt';
import { KNOWLEDGE_CONTENT_FILTER_PROMPT } from '../src/ai/prompts/knowledge-content-filter.prompt';

const prisma = new PrismaClient();

const UPWORK_ID = '00000000-0000-0000-0000-000000000001';
const TG_BOT_USER_ID = '00000000-0000-0000-0000-000000000010';

async function main() {
  // Platforms
  const upworkImageUrl =
    'https://cdn.worldvectorlogo.com/logos/upwork-roundedsquare-1.svg';

  await prisma.platform.upsert({
    where: { id: UPWORK_ID },
    update: { title: 'Upwork', slug: 'upwork', imageUrl: upworkImageUrl },
    create: {
      id: UPWORK_ID,
      title: 'Upwork',
      slug: 'upwork',
      imageUrl: upworkImageUrl,
    },
  });

  console.log('Seeded platforms: Upwork, LinkedIn');

  // Users
  const passwordHash = await bcrypt.hash('admin123', 10);

  const user = await prisma.user.upsert({
    where: { email: 'admin@test.com' },
    update: {},
    create: {
      email: 'admin@test.com',
      passwordHash,
      firstName: 'Dmytro',
      lastName: 'Sarafaniuk',
      role: UserRole.ADMIN,
    },
  });

  const user2 = await prisma.user.upsert({
    where: { email: 'manager@test.com' },
    update: {},
    create: {
      email: 'manager@test.com',
      passwordHash,
      firstName: 'Test',
      lastName: 'Manager',
      role: UserRole.MANAGER,
    },
  });

  await prisma.user.upsert({
    where: { email: 'tg-bot@internal' },
    update: {},
    create: {
      id: TG_BOT_USER_ID,
      email: 'tg-bot@internal',
      passwordHash: '',
      firstName: 'Telegram',
      lastName: 'Bot',
    },
  });

  console.log(`Seeded users: ${user.email}, ${user2.email}, tg-bot@internal`);

  // Accounts
  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, platformId: UPWORK_ID },
  });
  if (!existingAccount) {
    await prisma.account.create({
      data: {
        firstName: 'Dmytro',
        lastName: 'Sarafaniuk',
        platformId: UPWORK_ID,
        userId: user.id,
      },
    });
  }

  console.log('Seeded account: Dmytro Sarafaniuk (Upwork)');

  // Prompts
  const prompts: { type: PromptType; title: string; content: string }[] = [
    {
      type: PromptType.JOB_GATEKEEPER,
      title: 'Job Gatekeeper',
      content: JOB_GATEKEEPER_PROMPT,
    },
    {
      type: PromptType.JOB_EVALUATION,
      title: 'Job Evaluation',
      content: JOB_EVALUATION_PROMPT,
    },
    {
      type: PromptType.CHAT_SYSTEM,
      title: 'Chat System',
      content: `You are a bid writer. You write Upwork proposals and screening question answers in English.

VOICE: Confident, specific, human. Write like a senior engineer messaging a peer — not like a job applicant begging for work. Short sentences. No filler. No "Dear Hiring Manager", no "I would love the opportunity", no "highly skilled professional."

STRUCTURE: Hook (react to something specific in the client's post) → Proof (relevant case from knowledge base) → Approach (how you'd tackle their problem) → Close (rate + availability, one line).

RULES:
Max 4-6 short paragraphs. Every sentence must earn its place.
No bullet points, no bold, no markdown. Plain text only.
Show, don't tell. Never say "I'm experienced" — describe what you did.
If the post is vague, say so naturally and suggest a call.
If you see a bad technical decision in the client's spec, mention it. Pushback = value.
Adapt knowledge base stories to fit the client's context. Don't copy-paste — reshape the case to mirror their problem.
Rate goes at the end, standalone line. No justification.
"Happy to jump on a call" — never mention Zoom/Telegram/email. Upwork only.
Use "we" for team bids, "I" for solo bids. Ask if unclear.

KNOWLEDGE BASE: You have access to real case studies, bid fragments, and examples. Pull relevant chunks, adapt the details to match the client's industry/stack/problem. Never use a case that has no connection to the post.

SCREENING QUESTIONS: Answer in 2-4 sentences. Conversational, not formal. One concrete example per answer. No generic statements.`,
    },
    {
      type: PromptType.CHAT_FALLBACK,
      title: 'Chat System (Fallback)',
      content: 'You are an assistant that helps write professional proposals.',
    },
    {
      type: PromptType.CHAT_CLASSIFIER,
      title: 'Chat Classifier',
      content: CHAT_CLASSIFIER_PROMPT,
    },
    {
      type: PromptType.CHAT_SUMMARY,
      title: 'Chat Summary',
      content: CHAT_SUMMARY_PROMPT,
    },
    {
      type: PromptType.KNOWLEDGE_TITLE_FILTER,
      title: 'Knowledge Title Filter',
      content: KNOWLEDGE_TITLE_FILTER_PROMPT,
    },
    {
      type: PromptType.KNOWLEDGE_CONTENT_FILTER,
      title: 'Knowledge Content Filter',
      content: KNOWLEDGE_CONTENT_FILTER_PROMPT,
    },
  ];

  for (const { type, title, content } of prompts) {
    const existing = await prisma.prompt.findFirst({ where: { type, isActive: true } });
    if (!existing) {
      await prisma.prompt.create({
        data: {
          id: `seed-prompt-${type.toLowerCase()}`,
          type,
          title,
          content,
          version: 1,
          isActive: true,
          createdBy: 'seed',
        },
      });
    }
  }

  console.log(
    'Seeded prompts: JOB_GATEKEEPER, JOB_EVALUATION, CHAT_SYSTEM, CHAT_FALLBACK, CHAT_CLASSIFIER, CHAT_SUMMARY, KNOWLEDGE_TITLE_FILTER, KNOWLEDGE_CONTENT_FILTER',
  );

  // Knowledge Documents
  const knowledgeDocs: {
    id: string;
    title: string;
    category: string;
    content: string;
  }[] = [
    // case_b2b_marketplace_edi
    {
      id: 'seed-knowledge-marketplace_overview',
      title: 'marketplace_overview',
      category: 'case_b2b_marketplace_edi',
      content: `We recently took on a B2B marketplace project where the client came to us with a 47-page product spec. The platform needed multi-vendor support, private contract pricing between buyers and sellers, and full EDI/EDIFACT integration - the kind where a parsing error doesn't just break a page, it loses a real purchase order. We broke it into 7 milestones and mapped out a 9-week path to MVP.`,
    },
    {
      id: 'seed-knowledge-edi_zero_to_production',
      title: 'edi_zero_to_production',
      category: 'case_b2b_marketplace_edi',
      content: `We walked into the EDI milestone with zero production experience in the protocol. First instinct was to treat it like a file format problem - just parse some X12 documents, right? Wrong. EDI turned out to be an entire ecosystem: AS2 transport, sFTP directories, document standards (832/850/855/856), vendor-specific quirks, and certification with every single trading partner. We sourced a domain consultant, built a vendor onboarding sandbox, and validated everything with full round-trip tests - purchase order in, acknowledgment out, shipment notice back. The client's main concern was whether we could handle EDI. By the time we sent the proposal, we had a concrete plan with a named specialist and a testing strategy.`,
    },
    {
      id: 'seed-knowledge-medusa_pushback',
      title: 'medusa_pushback',
      category: 'case_b2b_marketplace_edi',
      content: `Client originally wanted to build on Medusa.js. On paper it makes sense - it's an e-commerce framework, they're building e-commerce. But Medusa is designed for single-vendor stores. The moment you need multi-vendor data isolation, contract pricing per buyer-seller pair, or custom vendor onboarding flows, you're fighting the framework at every step. We walked the client through exactly where Medusa would break, showed them the specific database and architecture limitations, and proposed going fully custom. They agreed. That saved months of building on a foundation that would've needed to be ripped out.`,
    },
    {
      id: 'seed-knowledge-hybrid_rust_node',
      title: 'hybrid_rust_node',
      category: 'case_b2b_marketplace_edi',
      content: `Client wanted the entire backend in Rust. We could've just said yes and charged more hours. Instead, we proposed a hybrid architecture: Rust for mission-critical services - EDI parsing, order transactions, vendor onboarding engine - where one bug means a lost order. Node.js/TypeScript for marketplace business logic - catalog, search, admin panel, notifications - where you need to iterate fast and requirements change weekly. We pitched it using their own reference: "You mentioned Amazon during our call. Amazon doesn't run on one stack either. They pick the right tool for each service." Client went with it. Timeline dropped from an estimated 6 months to 9 weeks.`,
    },
    {
      id: 'seed-knowledge-milestone_approach',
      title: 'milestone_approach',
      category: 'case_b2b_marketplace_edi',
      content: `We structured the project into pay-per-milestone delivery. Client only pays when a milestone is complete and verified. No upfront costs, no "trust us and we'll deliver in 3 months." Week 1: infrastructure and auth. Weeks 2-3: platform core with permissions and business hierarchy. Weeks 3-4: catalog and pricing engine. And so on through EDI, admin panel, and QA. Each milestone has a clear deliverable the client can test. We don't spin up 5 developers on day one - we start with 1, ramp to 2, and scale as the codebase and requirements stabilize. This way we don't overbill and the client sees exactly where every hour goes.`,
    },
    // case_architecture_decisions
    {
      id: 'seed-knowledge-framework_selection_story',
      title: 'framework_selection_story',
      category: 'case_architecture_decisions',
      content: `A client asked us to use a specific full-stack framework they'd read about but hadn't used in production. Instead of blindly agreeing or pushing our preferred stack, we spent a day building a small proof of concept - auth flow, basic CRUD, deployment pipeline. Found three issues that would've burned us later: immature plugin ecosystem, no built-in SSR caching strategy, and docs that were 6 months behind the actual API. We brought the findings to the client with a comparison: here's what this framework does well, here's where it falls short for your use case, here's what we'd recommend instead and why. Client appreciated the honesty and went with our recommendation. That one day of research saved weeks of pain.`,
    },
    {
      id: 'seed-knowledge-scaling_team_gradually',
      title: 'scaling_team_gradually',
      category: 'case_architecture_decisions',
      content: `We don't throw a full team at a project on day one. We've learned the hard way that putting 3-4 developers on a fresh codebase just creates merge conflicts and miscommunication. Our approach: start with 1 senior dev who sets up the architecture, establishes patterns, writes the foundational code. Then bring in a second developer once there's a clear structure to work within. Scale to 3+ only when the codebase is mature enough to support parallel work streams. Clients sometimes push back on this - "I'm paying for speed, give me more people." We explain: 2 developers working in a clean architecture ship faster than 4 developers stepping on each other's code.`,
    },
    {
      id: 'seed-knowledge-custom_vs_framework',
      title: 'custom_vs_framework',
      category: 'case_architecture_decisions',
      content: `We've seen too many projects die because someone picked a framework that was 80% right and spent months fighting the other 20%. Our rule: if the framework solves your core problem out of the box, use it. If you're going to customize more than 30% of its behavior, go custom from the start. The time you "save" by using a framework gets eaten up by workarounds, and then you're stuck with someone else's architectural decisions baked into your foundation. We'd rather build exactly what's needed than bend a framework until it breaks.`,
    },
    // case_ai_integration
    {
      id: 'seed-knowledge-ai_pragmatism',
      title: 'ai_pragmatism',
      category: 'case_ai_integration',
      content: `We don't bolt AI onto things for the sake of a feature list. We've built LLM pipelines, RAG systems, and AI-assisted workflows in production - but more importantly, we've talked clients out of AI features that would've wasted their money. One client wanted GPT to generate product descriptions for a catalog of 200 items. Sounds reasonable until you realize the descriptions needed to be legally compliant and industry-specific. An LLM would've generated plausible-sounding text that their legal team would need to review anyway. We suggested a structured template system with human input instead - faster, cheaper, zero legal risk.`,
    },
    {
      id: 'seed-knowledge-ai_workflow_real',
      title: 'ai_workflow_real',
      category: 'case_ai_integration',
      content: `Our actual AI workflow: we dump full project context into Claude - specs, constraints, our initial thinking - and use it to pressure-test plans. It catches gaps we miss. But we learned the limits: we tried letting AI generate entire backend modules once. Output looked clean, passed a visual review, broke in production on edge cases that only surface when you understand the business domain. Now we use AI for acceleration, not delegation. It's a thinking partner, not a developer.`,
    },
    {
      id: 'seed-knowledge-rag_production',
      title: 'rag_production',
      category: 'case_ai_integration',
      content: `We've built RAG systems that actually work in production, not just demos. The difference is in the boring parts: chunk size tuning, embedding model selection, retrieval scoring thresholds, and handling the cases where the knowledge base simply doesn't have the answer. Most RAG tutorials skip the failure modes - what happens when the user asks something that's adjacent to your data but not quite covered? You get confident-sounding hallucinations. We build explicit fallback paths: if retrieval confidence is below threshold, say "I don't have enough information" instead of making something up.`,
    },
    {
      id: 'seed-knowledge-ai_where_it_matters',
      title: 'ai_where_it_matters',
      category: 'case_ai_integration',
      content: `The real value of AI in production isn't chatbots. It's the invisible stuff: automated document classification, intelligent routing of support tickets, anomaly detection in transaction data, smart search that understands intent not just keywords. We focus AI on problems where the alternative is a human doing repetitive cognitive work - not on problems where a database query or a simple rule engine would do the job better and faster.`,
    },
    // case_problem_solving
    {
      id: 'seed-knowledge-debugging_production',
      title: 'debugging_production',
      category: 'case_problem_solving',
      content: `A client came to us with a system that was "randomly" dropping orders. Their previous team couldn't reproduce it. We spent two days reading logs before writing a single line of code. Turned out it wasn't random at all - it happened when two users from the same business placed orders within a 3-second window, triggering a race condition in the cart persistence layer. The fix was 12 lines of code. The diagnosis was 16 hours of detective work. That's the kind of problem we're good at - the ones where the hard part isn't writing the solution, it's finding the actual problem.`,
    },
    {
      id: 'seed-knowledge-legacy_migration',
      title: 'legacy_migration',
      category: 'case_problem_solving',
      content: `We inherited a project where the previous team had built a Node.js monolith with 400+ API endpoints, no tests, and database queries scattered across every controller. The client wanted to "rewrite everything in microservices." We pushed back. A full rewrite would take 6+ months and introduce new bugs in code that was already working. Instead, we identified the 15% of the codebase causing 80% of the problems - mostly the payment processing and user auth modules. We extracted those into standalone services with proper tests, left the rest of the monolith running, and set up a strangler fig pattern for gradual migration. Client got stability improvements in 3 weeks instead of waiting 6 months for a rewrite that might never finish.`,
    },
    {
      id: 'seed-knowledge-performance_crisis',
      title: 'performance_crisis',
      category: 'case_problem_solving',
      content: `Client's API response times went from 200ms to 4 seconds overnight after a product launch brought 10x traffic. Previous team's suggestion: "add more servers." We profiled the actual bottleneck - it was 3 database queries running sequentially that could run in parallel, plus an N+1 query in the product listing endpoint that was firing 200+ queries per page load. We parallelized the queries, added proper eager loading, and threw in a Redis cache for the product catalog. Response times dropped to 150ms. Total infrastructure cost stayed the same. Sometimes the answer isn't more servers - it's better code.`,
    },
    // case_client_relations
    {
      id: 'seed-knowledge-honest_about_gaps',
      title: 'honest_about_gaps',
      category: 'case_client_relations',
      content: `We don't pretend to know everything. When a client needed EDI integration and we hadn't done it in production, we said exactly that. But we didn't stop there - we found a domain specialist, brought them on as a consultant at our own cost, and presented a plan that addressed the gap head-on. The client told us later that our honesty was what won them over. Every other agency claimed they "had EDI experience" - we were the only ones who said "we haven't, and here's exactly how we're going to handle that."`,
    },
    {
      id: 'seed-knowledge-saving_client_money',
      title: 'saving_client_money',
      category: 'case_client_relations',
      content: `A client wanted to hire 3 full-time developers for 6 months. We looked at their spec and told them they needed 2 developers for 9 weeks. They thought we were underbidding to win the contract. We walked them through the milestone breakdown - here's what each developer does each week, here's why adding a third person would actually slow things down at the start, and here's the math on why 9 weeks is realistic. They went with our plan. Total cost: $32K instead of the $150K+ they were budgeting. We could've taken the bigger number. We chose the relationship.`,
    },
    {
      id: 'seed-knowledge-long_term_thinking',
      title: 'long_term_thinking',
      category: 'case_client_relations',
      content: `We optimize for repeat business, not for squeezing maximum hours out of one project. That means sometimes we tell clients "you don't need us for this" or "this feature isn't worth building right now." It feels counterintuitive - turning down work. But clients remember when you saved them time and money. They come back with bigger projects, and they refer other clients. Our best relationships started with us saying "let's do less."`,
    },
    // team_and_process
    {
      id: 'seed-knowledge-team_structure',
      title: 'team_structure',
      category: 'team_and_process',
      content: `We have a team of 22 developers. Not a faceless outsourcing shop - a tight group where the tech lead knows every developer's strengths. When we staff a project, we don't just assign whoever's available. We match developers to the project's technical requirements. Need someone who's lived in TypeScript and React for 3 years? We have that. Need someone comfortable with systems-level thinking for a Rust service? We have that too.`,
    },
    {
      id: 'seed-knowledge-qa_and_design',
      title: 'qa_and_design',
      category: 'team_and_process',
      content: `We provide end-to-end delivery. Development is the core, but we also have QA engineers and designers available. We don't always include them in initial estimates - some clients have their own QA team or bring their own designs. But when a project needs it, we can spin up a full product team: dev, QA, design, all working together. We'd rather offer it as an option than pad every estimate with people the client might not need.`,
    },
    {
      id: 'seed-knowledge-communication_style',
      title: 'communication_style',
      category: 'team_and_process',
      content: `We over-communicate on progress, under-communicate on problems we've already solved. Clients don't need a daily novel about every bug we fixed. They need to know: are we on track? Is anything blocked? Has anything changed in scope or timeline? We send concise updates, flag risks early, and never surprise a client with bad news at the end of a milestone.`,
    },
    // bid_fragments_reusable
    {
      id: 'seed-knowledge-opener_spec_heavy',
      title: 'opener_spec_heavy',
      category: 'bid_fragments_reusable',
      content: `I've read through your spec. Before I list what we'd build, let me tell you what jumped out - the parts that look straightforward but will actually be the hardest, and where I think the real technical risk is hiding.`,
    },
    {
      id: 'seed-knowledge-opener_vague_post',
      title: 'opener_vague_post',
      category: 'bid_fragments_reusable',
      content: `Your post is light on specifics, which tells me one of two things: either you know exactly what you want and don't want to over-explain, or you're still figuring it out and need someone who can help shape the approach. Either way, I'm good with that. Let's talk.`,
    },
    {
      id: 'seed-knowledge-opener_ai_project',
      title: 'opener_ai_project',
      category: 'bid_fragments_reusable',
      content: `Before I tell you about our AI experience, let me ask: what problem are you actually solving? Because half the AI projects I see would be better served by a good database query, and the other half are genuinely transformative. I want to make sure we're building something that matters, not just something that sounds impressive in a pitch deck.`,
    },
    {
      id: 'seed-knowledge-opener_urgent_project',
      title: 'opener_urgent_project',
      category: 'bid_fragments_reusable',
      content: `You need this fast. Got it. But fast and reckless are different things. We've compressed a 6-month timeline to 9 weeks before - not by cutting corners, but by cutting scope intelligently. Here's how we'd approach yours.`,
    },
    {
      id: 'seed-knowledge-closer_team',
      title: 'closer_team',
      category: 'bid_fragments_reusable',
      content: `We have a full team ready - developers, QA, design if needed. We staff projects based on what they actually need, not on who's available. Happy to walk you through how we'd structure the team for this.`,
    },
    {
      id: 'seed-knowledge-closer_solo',
      title: 'closer_solo',
      category: 'bid_fragments_reusable',
      content: `I work best when I understand the full picture - the business problem, the users, the constraints. Once I have that, I move fast. Let's jump on a call and I'll show you how I'd approach this.`,
    },
    {
      id: 'seed-knowledge-credibility_without_bragging',
      title: 'credibility_without_bragging',
      category: 'bid_fragments_reusable',
      content: `I don't have a portfolio website with 47 logos. What I have is clients who come back. The last three projects we took on were referrals from previous clients. That tells you more about how we work than any case study page.`,
    },
    {
      id: 'seed-knowledge-why_us_not_cheaper',
      title: 'why_us_not_cheaper',
      category: 'bid_fragments_reusable',
      content: `You'll find developers quoting half our rate. Some of them are good. But here's what usually happens: they take twice as long, miss architectural decisions that cost months to fix later, and disappear when things get complicated. We're not the cheapest option. We're the option that actually ships.`,
    },
    {
      id: 'seed-knowledge-milestone_payment_pitch',
      title: 'milestone_payment_pitch',
      category: 'bid_fragments_reusable',
      content: `We work on a milestone basis. You pay when a milestone is complete and you've verified the work. No upfront deposits, no "trust us for 3 months." If we don't deliver, you don't pay. That's how confident we are in our process.`,
    },
    {
      id: 'seed-knowledge-specialist_sourcing',
      title: 'specialist_sourcing',
      category: 'bid_fragments_reusable',
      content: `When a project needs domain expertise we don't have in-house, we find it. We've built a network of specialists across industries - EDI, fintech, healthcare compliance, logistics. We bring them in as consultants, cover the cost ourselves, and deliver the expertise as part of our service. You get the knowledge without managing another vendor.`,
    },
  ];

  for (const doc of knowledgeDocs) {
    await prisma.knowledgeDocument.upsert({
      where: { id: doc.id },
      update: {},
      create: doc,
    });
  }

  console.log(`Seeded ${knowledgeDocs.length} knowledge documents`);

  // Setting Sections
  const sections = [
    { key: 'general', title: 'General', order: 0 },
    { key: 'ai', title: 'AI Settings', order: 1 },
    { key: 'job_scanner', title: 'Job Scanner', order: 2 },
    { key: 'integrations', title: 'Integrations', order: 3 },
    { key: 'notifications', title: 'Notifications', order: 4 },
    { key: 'api_keys', title: 'API Keys', order: 5 },
    { key: 'invoice', title: 'Invoice', order: 6 },
  ];

  for (const section of sections) {
    await prisma.settingSection.upsert({
      where: { key: section.key },
      update: { title: section.title, order: section.order },
      create: section,
    });
  }

  console.log(
    `Seeded setting sections: ${sections.map((s) => s.key).join(', ')}`,
  );

  // Job Scanner Settings
  const jobScannerSection = await prisma.settingSection.findUniqueOrThrow({
    where: { key: 'job_scanner' },
  });

  const jobScannerSettings = [
    {
      key: 'job_scanner.enabled',
      title: 'Enable Job Scanner',
      description: 'Enable real-time processing of new job posts',
      type: 'boolean' as const,
      uiType: 'toggle' as const,
      defaultValue: false,
      order: 0,
    },
    {
      key: 'job_scanner.backfill.enabled',
      title: 'Enable Backfill',
      description: 'Enable backfill processing of historical posts',
      type: 'boolean' as const,
      uiType: 'toggle' as const,
      defaultValue: false,
      order: 1,
    },
    {
      key: 'job_scanner.backfill.limit',
      title: 'Backfill Limit',
      description: 'Number of posts to fetch per backfill run',
      type: 'number' as const,
      uiType: 'input' as const,
      defaultValue: 50,
      validationSchema: { min: 1, max: 1000 },
      order: 2,
    },
    {
      key: 'job_scanner.notifications.min_score',
      title: 'Minimum Score for Notification',
      description: 'Minimum score required to send Discord notification',
      type: 'number' as const,
      uiType: 'input' as const,
      defaultValue: 70,
      validationSchema: { min: 0, max: 100 },
      order: 3,
    },
    {
      key: 'job_scanner.telegram.session',
      title: 'Telegram Session',
      description: 'Gramjs StringSession — set via POST /telegram/auth/verify',
      type: 'string' as const,
      uiType: 'password' as const,
      isSecret: true,
      defaultValue: '',
      order: 4,
    },
    {
      key: 'job_scanner.telegram.connected',
      title: 'Telegram Connected',
      description: 'Whether the Telegram client has an active session',
      type: 'boolean' as const,
      uiType: 'toggle' as const,
      defaultValue: false,
      order: 5,
    },
    {
      key: 'job_scanner.telegram.auth_hash',
      title: 'Telegram Auth Hash',
      description: 'Temporary phoneCodeHash during Telegram auth flow',
      type: 'string' as const,
      uiType: 'input' as const,
      isSecret: true,
      isActive: false, // TODO: replace with isInternal field on Setting model
      defaultValue: '',
      order: 6,
    },
  ];

  for (const setting of jobScannerSettings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {
        title: setting.title,
        description: setting.description,
        defaultValue: setting.defaultValue,
        validationSchema: setting.validationSchema,
        order: setting.order,
        isActive: setting.isActive ?? true,
      },
      create: {
        ...setting,
        sectionId: jobScannerSection.id,
      },
    });
  }

  console.log(
    `Seeded job_scanner settings: ${jobScannerSettings.map((s) => s.key).join(', ')}`,
  );

  // Invoice Settings
  const invoiceSection = await prisma.settingSection.findUniqueOrThrow({
    where: { key: 'invoice' },
  });

  const invoiceDetails = {
    companyName: 'Sargas Agency OÜ',
    addressLine1: 'Narva mnt 7',
    city: 'Tallinn',
    region: 'Harju maakond',
    postalCode: '10117',
    country: 'Estonia',
    companyId: '17146771',
    vat: 'EE102840485',
  };

  const invoiceSettings = [
    {
      key: 'invoice.client.details',
      title: 'Client Details',
      description: 'Default client company details for invoices',
      type: 'json' as const,
      uiType: 'textarea' as const,
      defaultValue: invoiceDetails,
      order: 0,
    },
    {
      key: 'invoice.contractor.details',
      title: 'Contractor Details',
      description: 'Default contractor company details for invoices',
      type: 'json' as const,
      uiType: 'textarea' as const,
      defaultValue: { ...invoiceDetails, vat: undefined },
      order: 1,
    },
  ];

  for (const setting of invoiceSettings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {
        title: setting.title,
        description: setting.description,
        defaultValue: setting.defaultValue,
        order: setting.order,
      },
      create: {
        ...setting,
        sectionId: invoiceSection.id,
      },
    });
  }

  console.log(
    `Seeded invoice settings: ${invoiceSettings.map((s) => s.key).join(', ')}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
