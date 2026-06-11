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
  /**
   * Physical description for session-art generation. Free-form: hair,
   * build, clothing, distinguishing features. Null/omitted = the image
   * model improvises. Recommended to fill in for visual consistency.
   */
  appearance?: string | null;
}

interface SeedCampaign {
  name: string;
  gameSystem: GameSystem;
  discordGuildId: string;
  discordTextChannelId: string;
  /** Discord user ID of the DM (used to backfill recent-session lookups) */
  defaultDmDiscordUserId: string;
  characters: SeedCharacter[];
  /**
   * Optional: one-time character renames applied before the upsert loop.
   * Use when a canonical spelling changes (e.g. Redfalck → Redflack) and
   * we need to migrate the existing row instead of creating a duplicate.
   * Idempotent: updateMany is a no-op when the old name no longer exists,
   * so safe to leave in place across redeploys.
   */
  renames?: Array<{ from: string; to: string }>;
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
      {
        ownerDiscordUserId: '573738613653635072',
        name: 'Caelis Wardfall',
        race: 'Elf',
        classOrRole: 'Wizard',
        appearance:
          `A slight, youthful figure with long silver-white hair pulled back into a low ponytail, pale skin, light grey-blue eyes, faint freckles across the nose, a guarded expression. Dressed simply in a roughspun short-sleeve tunic the color of weathered tan, frayed at the hem, with a knotted leather belt and a small wooden talisman at the waist. Patched grey-brown trousers with tears at the knees tucked into worn leather boots. Carries a tall, gnarled wooden walking staff. Quiet, wary posture.`
      },
      {
        ownerDiscordUserId: '909602004135993365',
        name: 'Karis Arcanis',
        race: 'Elf',
        classOrRole: 'Wizard',
        appearance:
          `A tall, regal male elf with long straight black hair falling past his shoulders, fair skin, dark almond-shaped eyes, and an elegant, slightly amused smirk. He wears a silver circlet set with a small green gem on his brow. His robes are deep teal-blue with intricate silver and gold filigree across the chest, shoulders, and sleeves, with a glowing teardrop gem set at the sternum. Several silver rings glint on his long fingers. Composed, magnetic, slightly vain bearing. Often shown with an aura of conjuration light around his hands.`
      },
      {
        ownerDiscordUserId: '698639859304103986',
        name: 'Skneider',
        race: 'Elf',
        classOrRole: 'Rogue',
        appearance:
          `A handsome young male half-elf or elf with long, flowing silver-white hair swept back from a tan, sun-warmed complexion, striking pale blue eyes, dark brows, and sharp upswept ears. Faint constellations of glowing starlight freckle his cheekbone and trail across his face. He wears dark, fitted leather armor with shoulder pauldrons and silver-buckled harness straps across his bare upper arms. A confident, slightly roguish half-smile. Cosmic glimmer and stardust drift around him.`
      },
      {
        ownerDiscordUserId: '357479840443793408',
        name: 'Choppa',
        race: 'Orc',
        classOrRole: 'Barbarian',
        appearance:
          `A massive male orc with thick, weathered green skin, deep sunken eyes, and a heavy lower jaw crowded with long ivory tusks. Brutal, scarred features. He wears a tall pointed bronze helm flanked by sweeping white feathered wings, fronted by a dark gem. Across his shoulders sits jagged black plate armor with cruel spikes. A heavy necklace of large yellowed fangs strung on iron links hangs across his chest over a pale tabard. Imposing, intimidating presence. Dim red sky behind him.`
      },
      {
        ownerDiscordUserId: '394878699520000020',
        name: 'Therion',
        race: 'Elf',
        classOrRole: 'Wizard',
        appearance:
          `A young male half-elf with messy, spiky jet-black hair, pale skin, sharp glaring dark eyes, and slightly upswept pointed ears, drawn in an anime-style aesthetic. He wears a dark hooded sleeveless robe over engraved black plate armor inscribed with arcane runes across the chest and shoulders, a wide cinched leather belt, and dark tattered tabards at the waist. Holds an open spellbook bound in dark leather. Crackling blue-white lightning courses around him, and several greatswords float in the air around him as if telekinetically suspended. Intense, fierce expression.`
      },
      {
        ownerDiscordUserId: '700033531946205255',
        name: 'Leokas Raventel',
        race: 'Elf',
        classOrRole: 'Cleric',
        appearance:
          `A graceful, slender male elf with long, wavy golden hair parted down the middle and flowing past his shoulders, very fair skin, delicate features, and a serene, downcast expression. He wears flowing saffron-yellow robes with intricate green and gold vine embroidery along the collar, cuffs, and hem, fastened with a wide green-and-gold belt bearing a sunburst medallion. A single pink blossom is pinned at his chest. Calm, gentle bearing, often depicted among flowers and dappled light.`
      },
      {
        ownerDiscordUserId: '1020800023350489108',
        name: 'Kirian',
        race: 'Elf',
        classOrRole: 'Monk',
        appearance:
          `A lean, athletic male elf with rich dark brown skin, sharp pointed ears, golden-amber eyes, and a striking shock of short, swept-back white hair. Tribal-style brown markings curl across his right shoulder and arm. He wears a torn olive-green gi-style sleeveless robe wrapped at the chest, cinched with a thick knotted brown rope-belt; loose patched green trousers; and brown cloth wrappings binding his forearms, knuckles, and shins. Barefoot or in minimal wrappings. Confident martial stance, fists clenched.`
      },
      {
        ownerDiscordUserId: '925758694799572992',
        name: 'Azriel',
        race: 'Elf',
        classOrRole: 'Paladin',
        appearance:
          `A young female elf with long, golden-blonde hair worn loose past her shoulders, fair skin, light blue eyes, slender pointed ears, a small white-flower crown resting on her brow. She wears a forest-green sleeveless tunic over a chainmail shirt, brown leather bracers, a wide leather belt with a side pouch, brown leather trousers, and laced brown leather boots. A longsword in a worn brown scabbard hangs at her left hip. Calm, watchful expression; relaxed stance. Soft woodland light and faint motes hang around her.`
      }
    ]
  },
  {
    name: 'Hellknight Hill',
    gameSystem: 'PF2E',
    discordGuildId: DISCORD_GUILD_ID,
    discordTextChannelId: '1512485052984852520', // #pf2e
    defaultDmDiscordUserId: '909602004135993365', // David Mora
    renames: [
      // Canonical spelling corrected 2026-06-10. Safe to leave in place;
      // updateMany no-ops once the rename has run in every environment.
      { from: 'Redfalck', to: 'Redflack' }
    ],
    characters: [
      {
        ownerDiscordUserId: '573738613653635072',
        name: 'Cassian Voss',
        race: 'Human',
        classOrRole: 'Cleric',
        appearance:
          `A lean, athletic human male with refined features and a calm, thoughtful demeanor. Thick dark-brown hair falls in loose waves around his face, while a neatly trimmed beard and mustache frame a strong jawline. Deep-set eyes, dark brows, and a lightly tanned complexion give him an intelligent and approachable appearance. Subtle signs of travel and experience show in his skin and faint scars, while his posture projects quiet confidence rather than physical intimidation.`
      },
      {
        ownerDiscordUserId: '297531355665793024',
        name: 'Cuervo',
        race: 'Elf',
        classOrRole: 'Gunslinger',
        appearance:
          `A lean, weathered man with a sharp, angular face, prominent cheekbones, and intense brown eyes beneath heavy brows. Dark stubble covers his jaw, and shoulder-length dark hair spills from beneath a battered leather cowboy hat. His sun-darkened skin and hardened expression reflect years of hard living, while his generally unkempt appearance—including a noticeable lack of concern for personal hygiene—adds to his rough, dangerous presence. He looks like someone shaped by violence, survival, and long days under the open sky.`
      },
      {
        ownerDiscordUserId: '698639859304103986',
        name: 'Redflack',
        race: 'Elf',
        classOrRole: 'Ranger',
        appearance:
          `A lean, athletic elf with copper-toned skin, sharp angular features, and the easy confidence of a seasoned woodsman. Long auburn hair falls to his shoulders beneath a distinctive red cap decorated with small antler-like horns. Slightly taller than most humans, he is built for speed and endurance rather than brute strength. Keen, watchful eyes constantly scan his surroundings, giving the impression that little escapes his attention. His overall appearance is that of a skilled hunter equally at home in the wilderness and on the trail.`
      },
      {
        ownerDiscordUserId: '357479840443793408',
        name: 'Jago',
        race: 'Hobgoblin',
        classOrRole: 'Champion',
        appearance:
          `A towering hobgoblin with ash-gray skin, a powerful frame, and the disciplined bearing of a veteran soldier. His angular face is marked by old scars and striking crimson war paint across his eyes and cheeks, divided by a pale stripe running down the center of his face. Amber-yellow eyes, high cheekbones, a strong jaw, and swept-back pointed ears give him a severe and intimidating appearance. Black hair is tied into a tight warrior's topknot, and his rigid posture and unwavering gaze make him look perpetually alert and battle-ready.`
      },
      {
        ownerDiscordUserId: '394878699520000020',
        name: 'Brok Greystone',
        race: 'Human',
        classOrRole: 'Barbarian',
        appearance:
          `A bald, broad-shouldered human male of advanced age with a stocky, powerful build and a commanding presence. His weathered face is marked by deep wrinkles, a broad nose, heavy white eyebrows, and piercing eyes. A long white beard, braided and decorated with beads and clasps, hangs to his chest and dominates his appearance. Rough, sun-worn skin, thick forearms, large calloused hands, and faint dark markings along his arms suggest a lifetime of hardship and strength that age has done little to diminish.`
      },
      {
        ownerDiscordUserId: '700033531946205255',
        name: 'Tippi Bellyspark',
        race: 'Gnome',
        classOrRole: 'Alchemist',
        appearance:
          `A short, stout gnome with a round face, ruddy cheeks, and bright eyes behind small round spectacles. Deep laugh lines crease his face, while a long grey-and-white beard, slightly singed and stained from experimentation, hangs across his chest. His most memorable feature is his wildly untamed hair, which erupts in vivid streaks of magenta, purple, teal, green, and gold as though permanently charged with static. Long pointed ears and an expression of cheerful curiosity complete the image of an eccentric inventor who looks as though he has survived countless magical mishaps and enjoyed every one of them.`
      },
      {
        ownerDiscordUserId: '1020800023350489108',
        name: 'Brokk Spellforge',
        race: 'Dwarf',
        classOrRole: 'Wizard',
        appearance:
          `A short but massively built dwarf with a broad chest, thick limbs, and the compact strength of a seasoned craftsman. His rugged face features a wide nose, heavy brow, deep-set intelligent eyes, and weathered skin darkened by years near forge fires. An enormous dark-brown beard, braided and adorned with metal rings, reaches nearly to his waist. Long dark hair falls beneath an ornate dwarven crown crowned by a glowing amber gem and a carved bear motif, giving him the appearance of a respected master of both craft and magic.`
      },
      {
        ownerDiscordUserId: '925758694799572992',
        name: 'Sari Nueve-Vidas',
        race: 'Catfolk',
        classOrRole: 'Swashbuckler',
        appearance:
          `A lithe catfolk woman with tawny, striped fur patterned like a tabby cat and a long expressive tail. Bright green eyes dominate her feline features, constantly reflecting amusement, curiosity, or mischief. Large pointed ears and sensitive whiskers accentuate her animated expressions, while her graceful posture and fluid movements emphasize speed and agility. She carries herself with effortless confidence, projecting the charm and danger of a skilled duelist who always seems one step ahead.`
      }
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

    // 2.5. Apply any one-time character renames BEFORE the upsert loop.
    // Idempotent: updateMany returns count=0 once the rename has run.
    for (const r of c.renames ?? []) {
      const result = await prisma.character.updateMany({
        where: { campaignId: campaign.id, name: r.from },
        data: { name: r.to }
      });
      if (result.count > 0) {
        console.log(`seed: renamed ${result.count} character row(s) in ${c.name}: ${r.from} → ${r.to}`);
      }
    }

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
          userId,
          // Re-seed appearance from file if present; leave existing value
          // intact if the seed entry omits it (so prod edits aren't lost).
          ...(ch.appearance !== undefined ? { appearance: ch.appearance } : {})
        },
        create: {
          campaignId: campaign.id,
          userId,
          name: ch.name,
          race: ch.race,
          classOrRole: ch.classOrRole,
          personality: ch.personality ?? null,
          appearance: ch.appearance ?? null
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
