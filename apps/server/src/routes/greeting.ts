import type Redis from 'ioredis'

import type { ChatService } from '../services/chats'
import type { HonoEnv } from '../types/hono'

import process from 'node:process'

import { useLogger } from '@guiiai/logg'
import { Hono } from 'hono'
import { object, optional, safeParse, string } from 'valibot'

import { deliverPushedMessages, pushOrCreateChat } from '../services/chat-delivery'
import { createBadRequestError } from '../utils/error'
import { nanoid } from '../utils/id'

const logger = useLogger('greeting')

const GreetingSchema = object({
  text: string(),
  userId: optional(string()),
  chatId: optional(string()),
})

/**
 * Backward-compatible alias for `POST /api/system-message` with role=assistant
 * and tts disabled. Originally introduced for person_detector; new callers
 * should use `/api/system-message` directly so they can opt into TTS playback.
 */
export function createGreetingRoutes(chatService: ChatService, redis: Redis) {
  return new Hono<HonoEnv>()
    .post('/', async (c) => {
      const raw = await c.req.json().catch(() => null)
      if (raw === null)
        throw createBadRequestError('Body must be JSON', 'INVALID_REQUEST')

      const parsed = safeParse(GreetingSchema, raw)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const { text, userId, chatId } = parsed.output
      if (text.trim().length === 0)
        throw createBadRequestError('text must not be empty', 'INVALID_REQUEST')

      const resolvedUserId = userId ?? process.env.GREETING_DEFAULT_USER_ID ?? 'system'
      const resolvedChatId = chatId ?? process.env.GREETING_DEFAULT_CHAT_ID ?? 'default-chat'

      const messages = [{
        id: nanoid(),
        role: 'assistant',
        content: text,
      }]

      const pushResult = await pushOrCreateChat(chatService, resolvedUserId, resolvedChatId, messages)
      await deliverPushedMessages(chatService, redis, resolvedUserId, resolvedChatId, pushResult, null)

      logger.withFields({ userId: resolvedUserId, chatId: resolvedChatId }).log('Greeting injected')
      return c.json({ success: true, fromSeq: pushResult.fromSeq, toSeq: pushResult.toSeq }, 201)
    })
}
