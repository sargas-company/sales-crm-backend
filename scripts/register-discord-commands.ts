/* eslint-disable no-console */
/**
 * Register the `/report` slash command with Discord.
 *
 * Guild id is NOT read from env — it lives on `DiscordProfile.guildId`
 * (per-profile, non-secret). The CLI reads it from the TEST profile by
 * default so Owner can run drill with no shell state. Overridable:
 *
 *   npx ts-node scripts/register-discord-commands.ts                      # TEST profile guild
 *   npx ts-node scripts/register-discord-commands.ts --profile=PRODUCTION # PRODUCTION profile guild
 *   npx ts-node scripts/register-discord-commands.ts --guild=<id>         # explicit guild
 *   npx ts-node scripts/register-discord-commands.ts --global             # global (slow — up to 1h)
 *
 * Reads `DISCORD_APP_ID` and `DISCORD_BOT_TOKEN` from env; never writes
 * secrets to disk or stdout.
 */
import 'dotenv/config';
import axios from 'axios';
import { PrismaClient, type DiscordProfileName } from '@prisma/client';

async function main() {
  const appId = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !botToken) {
    throw new Error('DISCORD_APP_ID and DISCORD_BOT_TOKEN must be set');
  }
  const argv = process.argv.slice(2);
  const forceGlobal = argv.includes('--global');
  const explicitGuild = argv.find((a) => a.startsWith('--guild='))?.split('=')[1];
  const profileArg =
    (argv.find((a) => a.startsWith('--profile='))?.split('=')[1] as DiscordProfileName | undefined) ??
    'TEST';

  let guildId: string | null = explicitGuild ?? null;
  const prisma = new PrismaClient();
  try {
    if (!forceGlobal && !guildId) {
      const row = await prisma.discordProfile.findUnique({
        where: { name: profileArg as DiscordProfileName },
        select: { guildId: true },
      });
      guildId = row?.guildId ?? null;
    }
  } finally {
    await prisma.$disconnect();
  }

  if (!forceGlobal && !guildId) {
    throw new Error(
      `No guildId for profile ${profileArg}. Set it in Settings → Discord Integration first, or pass --guild=<id>.`,
    );
  }

  const url = forceGlobal
    ? `https://discord.com/api/v10/applications/${appId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;

  const command = {
    name: 'report',
    description: 'Log a work report for this project channel',
    type: 1,
    options: [
      {
        name: 'hours',
        description: 'Hours worked (0 < h ≤ 24)',
        type: 10, // NUMBER
        required: true,
        min_value: 0.01,
        max_value: 24,
      },
      {
        name: 'text',
        description: 'What was done (max 2048 characters)',
        type: 3, // STRING
        required: true,
        max_length: 2048,
      },
    ],
  };

  try {
    const res = await axios.post(url, command, {
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
    const target = forceGlobal ? 'global' : `guild ${guildId}`;
    console.log(
      JSON.stringify(
        { ok: true, scope: target, name: res.data.name, id: res.data.id },
        null,
        2,
      ),
    );
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
    console.error(
      JSON.stringify(
        {
          ok: false,
          status: ax.response?.status ?? 0,
          error: ax.response?.data ?? ax.message,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[register-discord-commands] FAILED', (e as Error).message);
  process.exit(1);
});
