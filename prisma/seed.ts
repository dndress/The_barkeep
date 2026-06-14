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
          `Young male elf apprentice caster, appears about 14–16 in human age. Soft youthful face; long pointed ears; pale skin; light grey-blue eyes; quiet sad expression; faint freckles across the nose. His blond hair is loosely tied back in a low ponytail, with a few loose strands falling near his face. He wears simple worn brown travel clothes — a plain rough tunic, patched grey-brown trousers torn at the knees, a basic knotted leather belt with a small wooden talisman, scuffed brown boots, no armor. He carries a tall gnarled wooden walking staff in both hands. Shoulders slightly hunched, wary posture.`
      },
      {
        ownerDiscordUserId: '909602004135993365',
        name: 'Karis Arcanis',
        race: 'Elf',
        classOrRole: 'Wizard',
        appearance:
          `Male high elf illusionist. Very refined features; long pointed ears; fair skin; dark almond-shaped eyes; immaculate long black hair falling past the shoulders, perfectly groomed and smooth; cold aristocratic expression; raised chin, upright posture, slight superior smirk. He wears deep teal-blue high-elven robes with gold trim and ornate elven embroidery, layered over polished silver ceremonial light armor. A jeweled silver circlet with a small green gem sits on his brow; elegant shoulder armor; fitted bracers; clean noble boots. He carries a fine elven bow. Translucent violet-blue mirror panels, square arcane frames, and floating image panes hang in the air around him.`
      },
      {
        ownerDiscordUserId: '698639859304103986',
        name: 'Skneider',
        race: 'Elf',
        classOrRole: 'Rogue',
        appearance:
          `Male elf rogue. Deep light-brown skin; sharp angular elven features; long pointed ears; narrow pale-blue eyes; white eyebrows; symmetrical handsome elven facial structure; hard focused stare and a charming half-smile. His hair is bright white, wild, layered, swept backward, falling around the sides and back of his head. He wears fitted black rogue gear with leather straps, very dark navy light armor, leather bracers, a wide belt with pouches, fitted dark trousers, tall black boots, and a short dark-navy cloak. His weapons are short daggers made of glowing blue-white force energy — solid dagger-shaped magical blades, one in each hand. Crouched low, blade in each hand, ready to strike.`
      },
      {
        ownerDiscordUserId: '357479840443793408',
        name: 'Choppa',
        race: 'Orc',
        classOrRole: 'Barbarian',
        appearance:
          `Hairless male green orc barbarian. Thick weathered green skin; deep sunken eyes; Hulk-level muscles, huge shoulders, thick arms, oversized hands. Heavy mouth with a maw of oversized broken crisscrossing pointy ivory tusks; lower jaw extends significantly forward; brutal scarred features. On his head, a tall bronze elven war helmet — narrow teardrop silhouette, smooth curved sides, a high pointed top, large white feathered wings on both sides. He carries a one-handed war pick in his right hand and a round wooden shield with a tree motif on his left arm. The rest is rough barbarian gear: dark leather straps, fur draped over one shoulder, bone trophies, and primitive metal armor pieces. A heavy necklace of large yellowed fangs hangs across his chest.`
      },
      {
        ownerDiscordUserId: '394878699520000020',
        name: 'Therion',
        race: 'Elf',
        classOrRole: 'Wizard',
        appearance:
          `Male elf bladesinger battle mage. Very pale skin; sharp elven features; long pointed ears; sharp glaring dark eyes; messy black spiky hair swept upward and backward. He wears black layered battle robes over fitted duelist clothing, reinforced with engraved silver shoulder armor and silver bracers. High dark scarf at the neck; leather belts; tall black boots; silver trim; a ragged black cloak. One hand holds an open spellbook with blue-white sparks crackling from the pages; the other wields a translucent blue-white force-magic blade in the form of a slim longsword. Body turned mid-motion, blade raised, fierce intense expression.`
      },
      {
        ownerDiscordUserId: '700033531946205255',
        name: 'Leokas Raventel',
        race: 'Elf',
        classOrRole: 'Cleric',
        appearance:
          `Effeminate male elf cleric (reads as male; delicate androgynous beauty). Slim flat-chested male body; long pointed ears; soft masculine facial structure; very fair skin; graceful gentle expression. His hair is long golden-blond, smooth and silky, parted near the middle, falling past the shoulders in loose flowing layers, with soft side strands framing his face — clean and gentle, never spiky, messy, braided, or warrior-tied. He wears elegant soft-yellow ceremonial robes with flowing fabric and green-and-gold vine embroidery along the collar, cuffs, and hem; a wide green-and-gold belt with a sunburst medallion. A small pink flower brooch pinned at the center of his chest. A subtle dim golden aura radiates softly around his body and clothing.`
      },
      {
        ownerDiscordUserId: '1020800023350489108',
        name: 'Kirian',
        race: 'Elf',
        classOrRole: 'Monk',
        appearance:
          `Very young adult male elf monk. Deep bronze-brown skin; long pointed ears; sharp angular elven features; angular cheekbones; lean defined jaw; straight narrow nose; intense amber eyes; white eyebrows. His hair is bright white, short on the sides, spiky and swept upward, with a longer layered back section falling behind the neck. Lean muscular elven body with visible arms and shoulders, strong martial proportions. He wears a rough sleeveless olive-green monk wrap, loose green martial pants, a rope belt, ragged brown cloth panels, wrapped forearms and calves, bare feet. No weapons — only hand-to-hand. Stands in a martial stance, fists clenched at chest height.`
      },
      {
        ownerDiscordUserId: '925758694799572992',
        name: 'Azriel',
        race: 'Elf',
        classOrRole: 'Paladin',
        appearance:
          `Young adult female elf warrior. Fair skin; light blue eyes; long pointed ears; focused brave expression. Her hair is long golden-blond, loose and flowing past her shoulders, with soft strands around her face, and she wears a simple crown of small white flowers and green leaves on her brow. She wears a forest-green sleeveless tunic over a chainmail shirt, with brown leather bracers, a wide leather belt with a side pouch, fitted brown leather trousers, and laced brown leather boots. A longsword in a worn brown scabbard hangs at her left hip; she carries a silver shield with an engraved leaf motif on her left arm. A tiny squirrel pet rides on her right shoulder.`
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
          `Young adult male human cleric. Lightly tanned skin; deep-set dark brown eyes; dark wavy shoulder-length hair; light dark stubble; high cheekbones; serious guarded expression, faint shadows under the eyes. He wears dark traveling clothes, a hooded gray-brown cloak, leather straps across his chest, and field medic gear with small pouches and bandage rolls at his belt. Worn brown boots. Clutches a worn leather-bound journal close to his chest with one hand. A small dull-bronze wasp-shaped Callistria holy symbol pinned at his collar.`
      },
      {
        ownerDiscordUserId: '297531355665793024',
        name: 'Cuervo',
        race: 'Elf',
        classOrRole: 'Gunslinger',
        appearance:
          `Male desert elf gunslinger. Lean, sharp, weathered build; pointed elven ears; sun-darkened skin; intense brown eyes beneath heavy brows; dark stubble; shoulder-length dark hair spilling from beneath a wide-brimmed black leather hat. He wears a long black duster coat over dusty desert travel clothes, red leather bracers, a wide belt with holsters and ammunition straps, fitted brown trousers, and worn brown boots. Carries a long carved fantasy rifle with mystical markings, held across his chest. Small green-glowing alchemical vials clipped to his belt. Stands with feet planted, weight low.`
      },
      {
        ownerDiscordUserId: '698639859304103986',
        name: 'Redflack',
        race: 'Elf',
        classOrRole: 'Ranger',
        appearance:
          `Male jungle elf ranger. Tan skin; sharp elven features; long pointed ears; intense dark eyes with a faint golden shine; long loose black hair falling past the shoulders; two small red horns rising from his upper forehead. He wears a green hooded cape over fitted brown leather armor, brown travel tunic, leather bracers, a wide belt with belt pouches, fitted brown trousers, and sturdy brown boots. Leans slightly forward, eyes scanning, one hand resting near his belt.`
      },
      {
        ownerDiscordUserId: '357479840443793408',
        name: 'Jago',
        race: 'Hobgoblin',
        classOrRole: 'Champion',
        appearance:
          `Male hobgoblin warrior. Ash-gray skin; harsh angular face; heavy brow; sharp cheekbones; amber-yellow eyes; swept-back pointed ears with several small ring piercings; small lower-jaw canine teeth. Long black hair tied in a loose rough topknot. Red tribal war paint across forehead, eyes, and nose, with vertical marks down the face. He wears heavy worn full plate armor in pale steel over dark cloth underlayers, with steel boots. Stands rigid and alert, shoulders squared, expression intense and guarded.`
      },
      {
        ownerDiscordUserId: '394878699520000020',
        name: 'Brok Greystone',
        race: 'Human',
        classOrRole: 'Barbarian',
        appearance:
          `Older male human, retired barbarian. Bald head; thick white beard divided into three Viking-style braids reaching mid-chest; thick white eyebrows; deep wrinkles; light tanned weathered skin; deep-set dark eyes; stern guarded expression. Broad shoulders, stocky powerful build, thick forearms, large calloused hands. He wears dark practical adventuring clothes — black and dark-brown leather, iron buckles, leather straps, metal clasps — and heavy worn brown boots. Stands square with arms loose at his sides, weathered hands visible, scarred forearms.`
      },
      {
        ownerDiscordUserId: '700033531946205255',
        name: 'Tippi Bellyspark',
        race: 'Gnome',
        classOrRole: 'Alchemist',
        appearance:
          `Small male gnome alchemist, ruddy cheeks, bright blue eyes behind small round spectacles, long pointed ears, deep laugh lines. Wild messy multicolored hair in vivid streaks of magenta, purple, teal, green, and gold; a medium-length white beard, slightly singed. He wears a stained brown alchemist coat, goggles pushed up on his forehead, scorched leather gloves, and travel clothes marked with chemical stains. A bright glowing flask in his right hand; vials on his belt; small pouches and handmade bomb components hanging from straps. At his side perches his familiar: a plump tawny squirrel with unusually bright alert eyes, ear tufts pricked forward, watching attentively.`
      },
      {
        ownerDiscordUserId: '1020800023350489108',
        name: 'Brokk Spellforge',
        race: 'Dwarf',
        classOrRole: 'Wizard',
        appearance:
          `Male dwarf wizard. Short, sturdy, compact dwarven build; ruddy weathered skin darkened by forge fires; deep brown eyes. Shoulder-length brown hair; large braided Viking-style brown mustache; one thick central brown beard braid reaching mid-chest. He wears practical leather armor in ochre, bronze, and brown. On his head sits a bronze bear-faced helmet shaped like a crafted bear mask — rounded bear ears, sculpted bear nose-and-brow design, metal cheek guards framing his face. Heavy worn brown boots. He carries a wooden staff topped with a glowing amber crystal, held upright in his right hand.`
      },
      {
        ownerDiscordUserId: '925758694799572992',
        name: 'Sari Nueve-Vidas',
        race: 'Catfolk',
        classOrRole: 'Swashbuckler',
        appearance:
          `Female catfolk adventurer, lithe agile build. Tawny tabby fur with darker stripes across her face, neck, arms, and long expressive tail. Long feline ears with dark tips; small ear piercings; narrow sharp bright green eyes; cheek fur, ear tufts, and visible whiskers; sly relaxed expression. Her head and face are fully feline — natural fur covers her scalp, no human hair, dreadlocks, or braids anywhere on her head (decorative braids or charms appear only on clothing or gear). She wears practical leather adventuring clothes with dark green cloth panels, brown leather straps, fingerless gloves, belt pouches, and a few small hanging charms. A round wooden shield strapped behind her shoulder; a curved dagger at her right hip.`
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
