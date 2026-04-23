import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaClient, PromptType, UserRole } from '@prisma/client';
import { JOB_GATEKEEPER_PROMPT } from '../src/ai/prompts/job-gatekeeper.prompt';
import { JOB_EVALUATION_PROMPT } from '../src/ai/prompts/job-evaluation.prompt';

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
    update: {
      firstName: 'Dmytro',
      lastName: 'Sarafaniuk',
      role: UserRole.ADMIN,
    },
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
    update: { firstName: 'Test', lastName: 'Manager', role: UserRole.MANAGER },
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
      type: PromptType.CHAT_FALLBACK,
      title: 'Chat System (Fallback)',
      content: 'You are an assistant that helps write professional proposals.',
    },
  ];

  for (const { type, title, content } of prompts) {
    await prisma.prompt.upsert({
      where: {
        // upsert by type where isActive = true isn't a unique constraint,
        // so we use a dedicated unique seed id per type
        id: `seed-prompt-${type.toLowerCase()}`,
      },
      update: { title, content },
      create: {
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

  console.log('Seeded prompts: JOB_GATEKEEPER, JOB_EVALUATION, CHAT_SYSTEM');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
