import { prisma } from "./prisma";
import { coerceConversationState, type ConversationState } from "./conversation-state";

/**
 * Storage for the conversation-state manager.
 *
 * The policy itself — what the states are, which one the room is in, and
 * whether the moderator may speak — lives in `conversation-state.ts`, which is
 * free of server-only imports so the room's UI can read it too. This module
 * only deals with keeping the state on the discussion row, so every browser in
 * the room shows the same thing.
 */

export * from "./conversation-state";

/**
 * Stores the state the engine settled on, but only when it actually changed, so
 * a room that is simply ticking along does not write to the database every few
 * seconds just to say so.
 */
export async function persistConversationState(
  discussionId: string,
  next: ConversationState,
  current: string | null | undefined,
): Promise<boolean> {
  if (next === coerceConversationState(current)) return false;
  await prisma.discussion.update({
    where: { id: discussionId },
    data: { conversationState: next, conversationStateAt: new Date() },
  });
  return true;
}
