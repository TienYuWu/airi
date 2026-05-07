import type { OutboundEventa } from '@moeru/eventa'
import type Redis from 'ioredis'

import type { HonoWsInvocableEventContext } from '../libs/eventa-hono-adapter'
import type { ChatService } from './chats'

import { useLogger } from '@guiiai/logg'
import { newMessages } from '@proj-airi/server-sdk-shared'

import {
  type ChatBroadcastPayload,
  createChatBroadcastMessage,
  parseChatBroadcastMessage,
} from '../utils/chat-broadcast'
import { createInternalError } from '../utils/error'
import { userChatBroadcastRedisKey } from '../utils/redis-keys'

const log = useLogger('chat-delivery').useGlobalConfig()

// Per-process connection registry. Multiple sources (chat-ws RPC and the
// new /api/system-message route) share this map so any push can reach all
// connected browsers on this instance regardless of which entry point
// produced the message.
const userConnections = new Map<string, Set<HonoWsInvocableEventContext>>()

/**
 * Register a connection for a user. Called from the chat-ws onContext hook
 * when a browser opens /ws/chat.
 */
export function addConnection(userId: string, ctx: HonoWsInvocableEventContext) {
  let conns = userConnections.get(userId)
  if (!conns) {
    conns = new Set()
    userConnections.set(userId, conns)
  }
  conns.add(ctx)
}

/**
 * Drop a connection from the registry. Called from the wsDisconnected hook.
 */
export function removeConnection(userId: string, ctx: HonoWsInvocableEventContext) {
  const conns = userConnections.get(userId)
  if (!conns)
    return
  conns.delete(ctx)
  if (conns.size === 0)
    userConnections.delete(userId)
}

/**
 * Returns true if at least one local WS connection currently belongs to userId.
 * Used by the cross-instance subscribe gate.
 */
export function hasLocalConnections(userId: string): boolean {
  return userConnections.has(userId)
}

/**
 * Push a chat broadcast payload to every locally-connected device of `userId`,
 * optionally skipping `excludeCtx` (the originating WS connection on RPC paths).
 */
export function broadcastToLocalDevices(
  userId: string,
  excludeCtx: HonoWsInvocableEventContext | null,
  payload: ChatBroadcastPayload,
) {
  const conns = userConnections.get(userId)
  if (!conns)
    return

  for (const ctx of conns) {
    if (ctx !== excludeCtx)
      ctx.emit(newMessages, payload)
  }
}

/**
 * Emit a non-chat outbound event to every locally-connected device, regardless
 * of which user owns the connection.
 *
 * Use when:
 * - System-wide signals (conversation state, vision presence, TTS playback)
 *   need to reach every connected web client. Chat events still use the
 *   user-scoped `broadcastToLocalDevices`.
 *
 * Expects:
 * - `event` is an outbound Eventa token; `payload` matches the token's shape.
 *
 * Returns:
 * - void.
 */
export function broadcastToAllLocalConnections<P>(event: OutboundEventa<P>, payload: P) {
  for (const conns of userConnections.values()) {
    for (const ctx of conns)
      ctx.emit(event, payload)
  }
}

/**
 * Publish a chat broadcast on the user's redis pub/sub channel so other
 * instances behind the load balancer can deliver to their local connections.
 *
 * Use when:
 * - You have just pushed a batch of messages and want every airi instance
 *   (not only the one that handled the request) to forward to its WS clients.
 *
 * Expects:
 * - `redis` is connected; the publish is fire-and-forget with error logged.
 *
 * Returns:
 * - void (errors are logged, not thrown).
 */
export function publishBroadcast(redis: Redis, userId: string, payload: ChatBroadcastPayload) {
  const channel = userChatBroadcastRedisKey(userId)
  const message = createChatBroadcastMessage(userId, payload)
  redis.publish(channel, JSON.stringify(message)).catch((err) => {
    log.withError(err).error('Failed to publish broadcast message')
  })
}

interface PushResult {
  fromSeq: number
  toSeq: number
}

/**
 * Deliver a freshly-pushed batch of messages to every chat member across
 * every airi instance.
 *
 * Use when:
 * - You called `chatService.pushMessages(senderUserId, chatId, ...)` and need
 *   to fan the new tail out over WebSocket. Both the chat-ws RPC handler and
 *   the REST injection routes (system-message, greeting) share this path.
 *
 * Expects:
 * - `pushResult` carries `fromSeq` and `toSeq` from `pushMessages`.
 * - `senderUserId` is the user id used for `pushMessages`; it scopes the
 *   pull-back read and is the only id we suppress local echo for.
 * - `excludeCtx` is the WS connection that initiated this push (RPC path) and
 *   should not receive its own echo. Pass `null` for REST-initiated pushes.
 *
 * Returns:
 * - The broadcast payload (so callers can log / count messages).
 */
export async function deliverPushedMessages(
  chatService: ChatService,
  redis: Redis,
  senderUserId: string,
  chatId: string,
  pushResult: PushResult,
  excludeCtx: HonoWsInvocableEventContext | null = null,
): Promise<ChatBroadcastPayload> {
  const wireMessages = await chatService.pullMessages(
    senderUserId,
    chatId,
    pushResult.fromSeq - 1,
    pushResult.toSeq - pushResult.fromSeq + 1,
  )

  const broadcastPayload: ChatBroadcastPayload = {
    chatId,
    messages: wireMessages.messages,
    fromSeq: pushResult.fromSeq,
    toSeq: pushResult.toSeq,
  }

  const members = await chatService.getMembers(chatId)
  const memberUserIds = members
    .filter(m => m.memberType === 'user' && m.userId != null)
    .map(m => m.userId!)

  for (const memberUserId of memberUserIds) {
    const localExclude = memberUserId === senderUserId ? excludeCtx : null
    broadcastToLocalDevices(memberUserId, localExclude, broadcastPayload)
    publishBroadcast(redis, memberUserId, broadcastPayload)
  }

  return broadcastPayload
}

/**
 * Build the per-instance redis subscriber that listens on every connected
 * user's broadcast channel and re-emits to local WS connections.
 *
 * Use when:
 * - Wiring up chat-ws at app startup. Call once per process; share the
 *   returned `ensureSubscribed` / `maybeUnsubscribe` from the WS lifecycle.
 *
 * Expects:
 * - `redis` is the primary client; this factory will `duplicate()` it for the
 *   subscribe-mode connection (ioredis requires a separate client).
 *
 * Returns:
 * - `{ ensureSubscribed, maybeUnsubscribe }` connection-lifecycle hooks and
 *   the underlying `sub` client (exposed for tests/teardown).
 */
export function createCrossInstanceSubscriber(redis: Redis) {
  const sub = redis.duplicate()

  sub.on('message', (_channel: string, message: string) => {
    try {
      const data = parseChatBroadcastMessage(message)
      // Cross-instance path: the originating connection is on a different
      // process, so we never need to suppress echo here.
      broadcastToLocalDevices(data.userId, null, data.payload)
    }
    catch (err) {
      log.withError(err).error('Failed to parse broadcast message')
    }
  })

  function ensureSubscribed(userId: string) {
    const channel = userChatBroadcastRedisKey(userId)
    sub.subscribe(channel).catch((err) => {
      log.withError(err).error('Failed to subscribe to broadcast channel')
    })
  }

  function maybeUnsubscribe(userId: string) {
    if (!hasLocalConnections(userId)) {
      const channel = userChatBroadcastRedisKey(userId)
      sub.unsubscribe(channel).catch((err) => {
        log.withError(err).error('Failed to unsubscribe from broadcast channel')
      })
    }
  }

  return { ensureSubscribed, maybeUnsubscribe, sub }
}

const ROBOT_CHARACTER_ID = 'robot'

interface PushMessageInput {
  id: string
  role: string
  content: string
}

/**
 * Push a batch into a chat, lazily creating the chat on first hit.
 *
 * Use when:
 * - REST injection routes (system-message, greeting) need to write into a
 *   shared bot chat that may not yet exist when the first message arrives.
 *
 * Expects:
 * - `userId` will be added as a member of the bot chat at create time so
 *   subsequent membership-checked pushes succeed.
 *
 * Returns:
 * - The push result with `seq`, `fromSeq`, `toSeq`.
 */
export async function pushOrCreateChat(
  chatService: ChatService,
  userId: string,
  chatId: string,
  messages: PushMessageInput[],
) {
  try {
    return await chatService.pushMessages(userId, chatId, messages)
  }
  catch (firstErr) {
    log.withError(firstErr as Error).warn('Push to chat failed, creating chat and retrying')

    try {
      await chatService.createChat(userId, {
        id: chatId,
        type: 'bot',
        title: 'Robot Assistant',
        members: [
          { type: 'user', userId },
          { type: 'character', characterId: ROBOT_CHARACTER_ID },
        ],
      })
      return await chatService.pushMessages(userId, chatId, messages)
    }
    catch (createErr) {
      log.withError(createErr as Error).error('Failed to create chat for injection')
      throw createInternalError('Failed to inject message')
    }
  }
}
