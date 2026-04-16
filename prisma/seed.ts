import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const UPWORK_ID = '00000000-0000-0000-0000-000000000001';
const LINKEDIN_ID = '00000000-0000-0000-0000-000000000002';

async function main() {
  // Platforms
  const upworkImageUrl =
    'https://www.citypng.com/public/uploads/preview/upwork-round-logo-icon-png-7017516949686332n4bo69bd8.png';

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

  await prisma.platform.upsert({
    where: { id: LINKEDIN_ID },
    update: { title: 'LinkedIn', slug: 'linkedin' },
    create: { id: LINKEDIN_ID, title: 'LinkedIn', slug: 'linkedin' },
  });

  console.log('Seeded platforms: Upwork, LinkedIn');

  // Users
  const passwordHash = await bcrypt.hash('admin123', 10);

  const user = await prisma.user.upsert({
    where: { email: 'admin@test.com' },
    update: { firstName: 'Dmytro', lastName: 'Sarafaniuk' },
    create: {
      email: 'admin@test.com',
      passwordHash,
      firstName: 'Dmytro',
      lastName: 'Sarafaniuk',
    },
  });

  const user2 = await prisma.user.upsert({
    where: { email: 'manager@test.com' },
    update: { firstName: 'Test', lastName: 'Manager' },
    create: {
      email: 'manager@test.com',
      passwordHash,
      firstName: 'Test',
      lastName: 'Manager',
    },
  });

  console.log(`Seeded users: ${user.email}, ${user2.email}`);

  // Accounts
  await prisma.account.upsert({
    where: { userId_platformId: { userId: user.id, platformId: UPWORK_ID } },
    update: { firstName: 'Dmytro', lastName: 'Sarafaniuk' },
    create: { firstName: 'Dmytro', lastName: 'Sarafaniuk', platformId: UPWORK_ID, userId: user.id },
  });

  console.log('Seeded account: Dmytro Sarafaniuk (Upwork)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
