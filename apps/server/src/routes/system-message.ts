import type Redis from 'ioredis'

import type { ChatService } from '../services/chats'
import type { HonoEnv } from '../types/hono'

import process from 'node:process'

import { useLogger } from '@guiiai/logg'
import { Hono } from 'hono'
import { boolean, literal, minLength, object, optional, pipe, safeParse, string, union } from 'valibot'

import { deliverPushedMessages, pushOrCreateChat } from '../services/chat-delivery'
import { createBadRequestError } from '../utils/error'
import { nanoid } from '../utils/id'

const logger = useLogger('system-message')

/**
 * Inbound payload for `POST /api/system-message`.
 *
 * Designed so any of the helper services (person_detector, ros2 proxy,
 * voice_capture, ROS task feedback) can inject a one-shot message into the
 * shared chat with a single REST call.
 */
const SystemMessageSchema = object({
  /** The displayed message body. */
  text: pipe(string(), minLength(1)),
  /**
   * Speaker role. Defaults to `assistant` so the message renders as the
   * robot speaking; pass `user` for transcribed STT utterances coming from
   * voice_capture, or `system` for protocol/error notices.
   */
  role: optional(union([literal('assistant'), literal('user'), literal('system')])),
  /** Override the target chat. Defaults to the env-configured greeting chat. */
  chatId: optional(string()),
  /** Override the target user. Defaults to the env-configured greeting user. */
  userId: optional(string()),
  /**
   * If true, additionally publish a `tts:request` redis message so a TTS
   * player (edgetts orchestrator, person_detector, ...) can speak it aloud.
   * @default false
   */
  tts: optional(boolean()),
  /** Free-form origin tag for logs/observability (e.g. `person-detector`). */
  source: optional(string()),
})

const TTS_REQUEST_CHANNEL = 'tts:request'
const DEFAULT_TTS_VOICE = 'zh-TW-HsiaoChenNeural'

/**
 * Build the `/api/system-message` Hono sub-app.
 *
 * Use when:
 * - Wiring routes in `app.ts`. Mount under `/api/system-message`.
 *
 * Expects:
 * - `chatService` is the shared chat service (DB-backed).
 * - `redis` is the primary connected client; the sub-app reuses it for
 *   broadcast publish and the optional TTS request publish.
 *
 * Returns:
 * - A Hono sub-app exposing `POST /` (mounted as `/api/system-message`).
 */
export function createSystemMessageRoutes(chatService: ChatService, redis: Redis) {
  return new Hono<HonoEnv>()
    .post('/', async (c) => {
      const raw = await c.req.json().catch(() => null)
      if (raw === null)
        throw createBadRequestError('Body must be JSON', 'INVALID_REQUEST')

      const parsed = safeParse(SystemMessageSchema, raw)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const { text, role, chatId, userId, tts, source } = parsed.output

      // Defaults match greeting.ts so person_detector switching from
      // /api/greeting to /api/system-message lands in the same chat.
      const resolvedRole = role ?? 'assistant'
      const resolvedUserId = userId ?? process.env.GREETING_DEFAULT_USER_ID ?? 'system'
      const resolvedChatId = chatId ?? process.env.GREETING_DEFAULT_CHAT_ID ?? 'default-chat'

      const messages = [{
        id: nanoid(),
        role: resolvedRole,
        content: text,
      }]

      const pushResult = await pushOrCreateChat(
        chatService,
        resolvedUserId,
        resolvedChatId,
        messages,
      )

      // Fan out to every connected browser (this instance + every other
      // airi instance via the redis broadcast channel).
      await deliverPushedMessages(
        chatService,
        redis,
        resolvedUserId,
        resolvedChatId,
        pushResult,
        null,
      )

      if (tts) {
        const payload = JSON.stringify({
          text,
          voice: DEFAULT_TTS_VOICE,
          source: source ?? 'system-message',
        })
        redis.publish(TTS_REQUEST_CHANNEL, payload).catch((err) => {
          logger.withError(err as Error).warn('Failed to publish tts:request')
        })
      }

      logger
        .withFields({ userId: resolvedUserId, chatId: resolvedChatId, source: source ?? 'unknown', tts: tts === true })
        .log('System message injected')

      return c.json({
        success: true,
        fromSeq: pushResult.fromSeq,
        toSeq: pushResult.toSeq,
      }, 201)
    })
}

