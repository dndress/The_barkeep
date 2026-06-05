// Zod schema mirroring CHRONICLER_HANDOFF.md (v2). This is the contract
// between Chronicler and Barkeep. If Chronicler ever evolves the payload,
// update here first, then propagate downstream.
import { z } from 'zod';

export const ChroniclerWebhookSchema = z.object({
  recordingId: z.string().min(1),
  chapterIndex: z.number().int().nonnegative(),
  isFinalChapter: z.boolean(),
  discordGuildId: z.string().min(1),
  discordChannelId: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  rawFiles: z.object({
    data: z.string().min(1),
    header1: z.string().min(1),
    header2: z.string().min(1),
    users: z.string().min(1),
    info: z.string().min(1)
  })
});

export type ChroniclerWebhookPayload = z.infer<typeof ChroniclerWebhookSchema>;
