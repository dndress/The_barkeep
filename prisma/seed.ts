// Seed script — idempotent. Safe to run on every container boot.
//
// Source of truth for static reference data:
//   - Campaigns (name, system, Discord text channel + guild)
//   - Users (Discord ID, current username, display/real name)
//   - Characters (PCs scoped to a campaign and a user)
//
// Strategy:
//   - Upsert by stable keys (Discord IDs, channel IDs, composite uniques).
//   - Never overwrite `displayName` — it's the human's real name, set once.
//   - Never overwrite `personality` if a row already has one — assume the
//     user has been editing it manually.
//   - Always refresh `discordUsername` (cheap, Discord rename is real).
//
// To add a campaign or player: edit the arrays below and redeploy. The seed
// will pick up the new rows on next boot and leave existing rows alone.
import { PrismaClient, GameSystem } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedUser {
  /** Discord snowflake (stable) */
  discordUserId: string;
  /** Current Discord username — refreshed on every boot */
  discordUsername: string;
  /** Real human name from the player roster doc */
  displayName: string;
  /** True for music bots / soundboards. Cook skips their tracks. */
  isBot?: boolean;
}

interface SeedCharacter {
  /** Maps to SeedUser.discordUserId */
  ownerDiscordUserId: string;
  name: string;
  race: string | null;
  classOrRole: string | null;
  /** Initial personality blurb. Null = let the Barkeep learn it. */
  personality?: string | null;
}

interface SeedCampaign {
  name: string;
  gameSystem: GameSystem;
  discordGuildId: string;
  discordTextChannelId: string;
  /** Discord user ID of the DM (used to backfill recent-session lookups) */
  defaultDmDiscordUserId: string;
  characters: SeedCharacter[];
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

const DISCORD_GUILD_ID = '698633790972493855'; // "D&D - IJR"

const USERS: SeedUser[] = [
  { discordUserId: '573738613653635072', discordUsername: 'dres7234',                displayName: 'Andres Naranjo' },
  { discordUserId: '297531355665793024', discordUsername: 'lukas8a',                 displayName: 'Lucas Ochoa' },
  { discordUserId: '909602004135993365', discordUsername: '.dmorar',                 displayName: 'David Mora' },
  { discordUserId: '698639859304103986', discordUsername: 'juanricardoescobarmejia', displayName: 'Juan Ricardo Escobar Mejia' },
  { discordUserId: '357479840443793408', discordUsername: 'omikronpi',               displayName: 'Simon Zapata' },
  { discordUserId: '394878699520000020', discordUsername: 'lucasguti20',             displayName: 'Lucas Gutierrez' },
  { discordUserId: '700033531946205255', discordUsername: 'cceballos',               displayName: 'Cristian Ceballos' },
  { discordUserId: '1020800023350489108', discordUsername: '_danielgallego',         displayName: 'Daniel Gallego' },
  { discordUserId: '925758694799572992',  discordUsername: 'andreaarango118',        displayName: 'Andrea Arango' },
  // Bots — cook skips creating AudioFile rows for them.
  { discordUserId: '1145363441524166758', discordUsername: 'matchbox',               displayName: 'MatchBox (music bot)', isBot: true }
];

const CAMPAIGNS: SeedCampaign[] = [
  {
    name: 'Drakar',
    gameSystem: 'DND_5E',
    discordGuildId: DISCORD_GUILD_ID,
    discordTextChannelId: '1512484888979308704', // #drakar
    defaultDmDiscordUserId: '297531355665793024', // Lucas Ochoa
    characters: [
      { ownerDiscordUserId: '573738613653635072', name: 'Caelis Wardfall',  race: 'Elf', classOrRole: 'Wizard' },
      { ownerDiscordUserId: '909602004135993365', name: 'Karis Arcanis',    race: 'Elf', classOrRole: 'Wizard' },
      { ownerDiscordUserId: '698639859304103986', name: 'Skneider',         race: 'Elf', classOrRole: 'Rogue' },
      { ownerDiscordUserId: '357479840443793408', name: 'Choppa',           race: 'Orc', classOrRole: 'Barbarian' },
      { ownerDiscordUserId: '394878699520000020', name: 'Therion',          race: 'Elf', classOrRole: 'Wizard' },
      { ownerDiscordUserId: '700033531946205255', name: 'Leokas Raventel',  race: 'Elf', classOrRole: 'Cleric' },
      { ownerDiscordUserId: '1020800023350489108', name: 'Kirian',          race: 'Elf', classOrRole: 'Monk' },
      { ownerDiscordUserId: '925758694799572992',  name: 'Azriel',          race: 'Elf', classOrRole: 'Paladin' }
    ]
  },
  {
    name: 'Hellknight Hill',
    gameSystem: 'PF2E',
    discordGuildId: DISCORD_GUILD_ID,
    discordTextChannelId: '1512485052984852520', // #pf2e
    defaultDmDiscordUserId: '909602004135993365', // David Mora
    characters: [
      { ownerDiscordUserId: '573738613653635072', name: 'Cassian Voss',      race: 'Human',     classOrRole: 'Cleric' },
      { ownerDiscordUserId: '297531355665793024', name: 'Cuervo',            race: 'Elf',       classOrRole: 'Gunslinger' },
      { ownerDiscordUserId: '698639859304103986', name: 'Redfalck',          race: 'Elf',       classOrRole: 'Ranger' },
      { ownerDiscordUserId: '357479840443793408', name: 'Jago',              race: 'Hobgoblin', classOrRole: 'Champion' },
      { ownerDiscordUserId: '394878699520000020', name: 'Brok Greystone',    race: 'Human',     classOrRole: 'Barbarian' },
      { ownerDiscordUserId: '700033531946205255', name: 'Tippi Bellyspark',  race: 'Gnome',     classOrRole: 'Alchemist' },
      { ownerDiscordUserId: '1020800023350489108', name: 'Silas BlackRobbed', race: 'Elf',      classOrRole: 'Cleric' },
      { ownerDiscordUserId: '925758694799572992',  name: 'Sari Nueve-Vidas', race: 'Catfolk',   classOrRole: 'Swashbuckler' }
    ]
  }
];

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  // 1. Users — upsert by discordUserId. Refresh username + isBot, never
  // displayName (it's the real human / bot label, not auto-managed).
  const userIdByDiscord = new Map<string, string>();
  for (const u of USERS) {
    const row = await prisma.user.upsert({
      where: { discordUserId: u.discordUserId },
      update: { discordUsername: u.discordUsername, isBot: u.isBot ?? false },
      create: {
        discordUserId: u.discordUserId,
        discordUsername: u.discordUsername,
        displayName: u.displayName,
        isBot: u.isBot ?? false
      }
    });
    userIdByDiscord.set(u.discordUserId, row.id);
  }

  // 2. Campaigns — upsert by discordTextChannelId (unique).
  for (const c of CAMPAIGNS) {
    const campaign = await prisma.campaign.upsert({
      where: { discordTextChannelId: c.discordTextChannelId },
      update: {
        name: c.name,
        gameSystem: c.gameSystem,
        discordGuildId: c.discordGuildId
      },
      create: {
        name: c.name,
        gameSystem: c.gameSystem,
        discordGuildId: c.discordGuildId,
        discordTextChannelId: c.discordTextChannelId
      }
    });

    // 3. Characters — upsert by (campaignId, name). Don't touch personality
    //    if the row already has one (user may have edited it).
    for (const ch of c.characters) {
      const userId = userIdByDiscord.get(ch.ownerDiscordUserId);
      if (!userId) {
        console.warn(`seed: character ${ch.name} references unknown user ${ch.ownerDiscordUserId} — skipped`);
        continue;
      }
      await prisma.character.upsert({
        where: { campaignId_name: { campaignId: campaign.id, name: ch.name } },
        update: {
          race: ch.race,
          classOrRole: ch.classOrRole,
          userId
        },
        create: {
          campaignId: campaign.id,
          userId,
          name: ch.name,
          race: ch.race,
          classOrRole: ch.classOrRole,
          personality: ch.personality ?? null
        }
      });
    }

    // (We do NOT seed Sessions or SessionPlayers — those come from real
    // recordings via Chronicler webhooks + voice-intro extraction.)
    void campaign; // appease ts-unused-vars if defaultDmDiscordUserId becomes unused
  }

  // Stage 6.5 — make sure the singleton BotSettings row exists.
  // Idempotent: we never overwrite existing values, only create if missing.
  await prisma.botSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      transcriptionSource: 'EXTERNAL_WHISPER',
      drivePollIntervalHours: 6
    }
  });

  // Counts for the boot log
  const [campaignCount, userCount, characterCount] = await Promise.all([
    prisma.campaign.count(),
    prisma.user.count(),
    prisma.character.count()
  ]);
  console.log(`seed: ${campaignCount} campaigns, ${userCount} users, ${characterCount} characters`);
}

seed()
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
