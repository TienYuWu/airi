import type Redis from 'ioredis'

import { useLogger } from '@guiiai/logg'
import {
  conversationState,
  type ConversationStateValue,
  ttsRequest,
  type TtsRequestPayload,
  ttsState,
  type TtsStateValue,
  visionPersonPresent,
} from '@proj-airi/server-sdk-shared'

import { broadcastToAllLocalConnections } from './chat-delivery'

const log = useLogger('conversation-state-bridge').useGlobalConfig()

const CHANNEL_CONVERSATION_STATE = 'conversation:state'
const CHANNEL_TTS_STATE = 'tts:state'
const CHANNEL_VISION_PERSON_PRESENT = 'vision:person_present'
const CHANNEL_TTS_REQUEST = 'tts:request'

const VALID_CONVERSATION_STATES = new Set<ConversationStateValue>([
  'idle',
  'listening',
  'thinking',
  'speaking',
])

const VALID_TTS_STATES = new Set<TtsStateValue>(['speaking', 'ready'])

/**
 * Producers (Python services) sometimes publish a JSON envelope like
 * `{"state": "speaking"}` and sometimes a bare string. Accept both so the
 * bridge stays compatible no matter which dialect the publisher uses.
 */
function extractStateField(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { state?: unknown }
      if (typeof parsed.state === 'string')
        return parsed.state
    }
    catch {
      // fall through to plain-string handling
    }
  }
  return trimmed
}

function parseBoolean(raw: string): boolean | null {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes')
    return true
  if (trimmed === 'false' || trimmed === '0' || trimmed === 'no')
    return false
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { present?: unknown }
      if (typeof parsed.present === 'boolean')
        return parsed.present
    }
    catch {
      // fall through
    }
  }
  return null
}

/**
 * Subscribe to the robot-side Redis state channels and forward each event
 * to every locally-connected web client.
 *
 * Use when:
 * - Wiring app startup. Call once per process; the bridge keeps a dedicated
 *   subscriber connection alive for the lifetime of the server.
 *
 * Expects:
 * - `redis` is the primary connected client; a duplicated connection is used
 *   for subscribe-mode (ioredis requirement).
 *
 * Returns:
 * - `{ sub }` — the subscriber client, primarily for tests/teardown.
 */
export function createConversationStateBridge(redis: Redis) {
  const sub = redis.duplicate()

  sub.on('message', (channel: string, message: string) => {
    try {
      switch (channel) {
        case CHANNEL_CONVERSATION_STATE: {
          const value = extractStateField(message) as ConversationStateValue
          if (!VALID_CONVERSATION_STATES.has(value)) {
            log.withFields({ channel, message }).warn('Unknown conversation state')
            return
          }
          broadcastToAllLocalConnections(conversationState, { state: value })
          break
        }
        case CHANNEL_TTS_STATE: {
          const value = extractStateField(message) as TtsStateValue
          if (!VALID_TTS_STATES.has(value)) {
            log.withFields({ channel, message }).warn('Unknown TTS state')
            return
          }
          broadcastToAllLocalConnections(ttsState, { state: value })
          break
        }
        case CHANNEL_VISION_PERSON_PRESENT: {
          const value = parseBoolean(message)
          if (value === null) {
            log.withFields({ channel, message }).warn('Unparseable vision presence value')
            return
          }
          broadcastToAllLocalConnections(visionPersonPresent, { present: value })
          break
        }
        case CHANNEL_TTS_REQUEST: {
          // Producers always send a JSON envelope (system-message route does it
          // explicitly; future producers should match). Drop malformed payloads
          // rather than emit half-empty events.
          let payload: TtsRequestPayload
          try {
            const parsed = JSON.parse(message) as Partial<TtsRequestPayload>
            if (typeof parsed?.text !== 'string' || parsed.text.trim().length === 0) {
              log.withFields({ channel, message }).warn('tts:request missing text')
              return
            }
            payload = {
              text: parsed.text,
              voice: typeof parsed.voice === 'string' ? parsed.voice : undefined,
              source: typeof parsed.source === 'string' ? parsed.source : undefined,
            }
          }
          catch {
            log.withFields({ channel, message }).warn('Unparseable tts:request value')
            return
          }
          broadcastToAllLocalConnections(ttsRequest, payload)
          break
        }
        default:
          break
      }
    }
    catch (err) {
      log.withError(err as Error).withFields({ channel, message }).error('Failed to bridge state event')
    }
  })

  sub
    .subscribe(
      CHANNEL_CONVERSATION_STATE,
      CHANNEL_TTS_STATE,
      CHANNEL_VISION_PERSON_PRESENT,
      CHANNEL_TTS_REQUEST,
    )
    .catch((err) => {
      log.withError(err as Error).error('Failed to subscribe to robot state channels')
    })

  return { sub }
}
