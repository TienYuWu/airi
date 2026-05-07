import type { ChatService } from '../services/chats'
import type { HonoEnv } from '../types/hono'

import { Hono } from 'hono'
import { nanoid } from '../utils/id'
import { useLogger } from '@guiiai/logg'

const logger = useLogger('greeting')

export function createGreetingRoutes(chatService: ChatService) {
  return new Hono<HonoEnv>()
    /**
     * Receive greeting from person_detector service and inject into chat.
     * POST /api/greeting
     * Body: { text: string, userId?: string, chatId?: string }
     * 
     * If userId/chatId not provided, uses defaults from environment.
     */
    .post('/', async (c) => {
      try {
        const body = await c.req.json()
        const { text, userId, chatId } = body as {
          text: string
          userId?: string
          chatId?: string
        }

        if (!text || typeof text !== 'string') {
          return c.json({ error: 'Missing or invalid text field' }, 400)
        }

        // Use provided userId/chatId or defaults
        const defaultUserId = process.env.GREETING_DEFAULT_USER_ID || 'system'
        const defaultChatId = process.env.GREETING_DEFAULT_CHAT_ID || 'default-chat'
        
        const resolvedUserId = userId || defaultUserId
        const resolvedChatId = chatId || defaultChatId

        // Create and push the greeting message
        const messages = [
          {
            id: nanoid(),
            role: 'assistant',
            content: text,
          },
        ]

        try {
          await chatService.pushMessages(resolvedUserId, resolvedChatId, messages)
          logger.withFields({ userId: resolvedUserId, chatId: resolvedChatId }).log('Greeting injected')
          return c.json({ success: true, message: 'Greeting injected' }, 201)
        }
        catch (err) {
          // If chat doesn't exist, create it first
          logger.withError(err as Error).warn('Failed to push to existing chat, creating new one')
          
          try {
            await chatService.createChat(resolvedUserId, {
              id: resolvedChatId,
              type: 'bot',
              title: 'Robot Assistant',
              members: [
                { type: 'user', userId: resolvedUserId },
                { type: 'character', characterId: 'robot' },
              ],
            })

            // Now push the message
            await chatService.pushMessages(resolvedUserId, resolvedChatId, messages)
            logger.withFields({ userId: resolvedUserId, chatId: resolvedChatId }).log('Chat created and greeting injected')
            return c.json({ success: true, message: 'Chat created and greeting injected' }, 201)
          }
          catch (createErr) {
            logger.withError(createErr as Error).error('Failed to create chat and inject greeting')
            return c.json({ error: 'Failed to inject greeting' }, 500)
          }
        }
      }
      catch (err) {
        logger.withError(err as Error).error('Error processing greeting request')
        return c.json({ error: 'Invalid request' }, 400)
      }
    })
}
