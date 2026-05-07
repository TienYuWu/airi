import type Redis from 'ioredis'

import type { HonoEnv } from '../../types/hono'

import { useLogger } from '@guiiai/logg'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

const logger = useLogger('events:system-messages')

const TTS_REQUEST_CHANNEL = 'tts:request'
const HEARTBEAT_MS = 30_000

interface SystemMessageEvent {
  text: string
  voice?: string
  source?: string
}

/**
 * Server-Sent Events stream of every TTS request the airi server publishes.
 *
 * Use when:
 * - Stage-web (or any browser tab) wants to hear and display "robot says X"
 *   events that originate outside the local LLM stream — e.g. person_detector
 *   greetings, ros2_adapter canned responses, main_task_node feedback. They
 *   all arrive via `POST /api/system-message` with `tts: true`, which makes
 *   the server publish `tts:request` on Redis.
 *
 * Why SSE rather than `/ws/chat` Eventa:
 * - SSE is a simple GET that piggybacks on the same auth/CORS setup the REST
 *   API already has. The Eventa client wiring on the browser is non-trivial
 *   and requires session token plumbing we'd rather avoid for the kiosk path.
 *
 * Wire format:
 * - Each message is emitted as an `event: system-message` SSE entry whose
 *   `data` field is a JSON `{ text, voice?, source? }` envelope.
 * - A `heartbeat` event is sent every 30s to keep proxies / load balancers
 *   from closing the idle stream.
 */
export function createSystemMessageEventsRoute(redis: Redis) {
  return new Hono<HonoEnv>()
    .get('/', (c) => {
      return streamSSE(c, async (stream) => {
        // Each connection gets its own subscriber; ioredis requires a
        // dedicated client for subscribe-mode operations.
        const sub = redis.duplicate()

        sub.on('message', async (channel: string, message: string) => {
          if (channel !== TTS_REQUEST_CHANNEL)
            return
          try {
            const parsed = JSON.parse(message) as Partial<SystemMessageEvent>
            if (typeof parsed?.text !== 'string' || parsed.text.trim().length === 0)
              return
            const event: SystemMessageEvent = {
              text: parsed.text,
              voice: typeof parsed.voice === 'string' ? parsed.voice : undefined,
              source: typeof parsed.source === 'string' ? parsed.source : undefined,
            }
            await stream.writeSSE({
              event: 'system-message',
              data: JSON.stringify(event),
            })
          }
          catch (err) {
            logger.withError(err as Error).warn('Failed to forward tts:request event')
          }
        })

        try {
          await sub.subscribe(TTS_REQUEST_CHANNEL)
        }
        catch (err) {
          logger.withError(err as Error).error('Failed to subscribe to tts:request')
        }

        stream.onAbort(() => {
          sub.disconnect()
        })

        while (!stream.aborted) {
          await stream.sleep(HEARTBEAT_MS)
          if (stream.aborted)
            break
          try {
            await stream.writeSSE({ event: 'heartbeat', data: '' })
          }
          catch {
            break
          }
        }
      })
    })
}
