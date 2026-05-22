import type Redis from 'ioredis'

import type { EngagementMetrics } from '../../libs/otel'
import type { ChatService } from '../../services/chats'

import { useLogger } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { pullMessages, sendMessages } from '@proj-airi/server-sdk-shared'

import { createPeerHooks, wsDisconnectedEvent } from '../../libs/eventa-hono-adapter'
import {
  addConnection,
  createCrossInstanceSubscriber,
  deliverPushedMessages,
  removeConnection,
} from '../../services/chat-delivery'

const log = useLogger('chat-ws').useGlobalConfig()

export function createChatWsHandlers(
  chatService: ChatService,
  redis: Redis,
  metrics?: EngagementMetrics | null,
) {
  const { ensureSubscribed, maybeUnsubscribe } = createCrossInstanceSubscriber(redis)

  return function setupPeer(userId: string) {
    const { hooks } = createPeerHooks({
      onContext: (ctx) => {
        addConnection(userId, ctx)
        ensureSubscribed(userId)
        log.withFields({ userId }).log('WS connected')
        metrics?.wsConnectionsActive.add(1)

        ctx.on(wsDisconnectedEvent, () => {
          removeConnection(userId, ctx)
          maybeUnsubscribe(userId)
          log.withFields({ userId }).log('WS disconnected')
          metrics?.wsConnectionsActive.add(-1)
        })

        // RPC: send messages
        defineInvokeHandler(ctx, sendMessages, async (req) => {
          log.withFields({ userId, chatId: req!.chatId, count: req!.messages.length }).log('sendMessages')
          const result = await chatService.pushMessages(userId, req!.chatId, req!.messages)
          const payload = await deliverPushedMessages(chatService, redis, userId, req!.chatId, result, ctx)
          metrics?.wsMessagesSent.add(payload.messages.length)

          // Fan out user-role messages to ROS-side consumers (bt_supervisor) over
          // Redis. Single-purpose channel: any subscriber treats this as "the
          // human just said something." Used by the post-pour question wait.
          // Best-effort; never blocks the RPC reply.
          for (const m of req!.messages) {
            if (m.role !== 'user')
              continue
            redis.publish('robot:user-response', JSON.stringify({
              text: m.content,
              userId,
              chatId: req!.chatId,
              at: new Date().toISOString(),
            })).catch(err => log.withFields({ err }).warn('robot:user-response publish failed'))
          }

          return { seq: result.seq }
        })

        // RPC: pull messages
        defineInvokeHandler(ctx, pullMessages, async (req) => {
          log.withFields({ userId, chatId: req!.chatId, afterSeq: req!.afterSeq }).log('pullMessages')
          return chatService.pullMessages(userId, req!.chatId, req!.afterSeq, req!.limit)
        })
      },
    })
    return hooks
  }
}
