import { defineInvokeEventa, defineOutboundEventa } from '@moeru/eventa'

export interface WireMessage {
  id: string
  chatId: string
  senderId: string | null
  role: 'system' | 'user' | 'assistant' | 'tool' | 'error'
  content: string
  seq: number
}

export type MessageRole = WireMessage['role']

export interface SendMessagesRequest {
  chatId: string
  messages: { id: string, role: string, content: string }[]
}

export interface SendMessagesResponse {
  seq: number
}

export interface PullMessagesRequest {
  chatId: string
  afterSeq: number
  limit?: number
}

export interface PullMessagesResponse {
  messages: WireMessage[]
  seq: number
}

export interface NewMessagesPayload {
  chatId: string
  messages: WireMessage[]
  fromSeq: number
  toSeq: number
}

export const sendMessages = defineInvokeEventa<SendMessagesResponse, SendMessagesRequest>('chat:send-messages')
export const pullMessages = defineInvokeEventa<PullMessagesResponse, PullMessagesRequest>('chat:pull-messages')
export const newMessages = defineOutboundEventa<NewMessagesPayload>('chat:new-messages')

// ---------------------------------------------------------------------------
// Robot-side conversation/perception state. Pushed from the airi server to
// every connected web client so UI can gate the mic indicator and surface
// "listening / speaking / no person detected" hints. Producers are the
// drink_airi side services (voice_capture, person_detector, edgetts player)
// which publish on Redis pub/sub channels; the airi server bridges those
// channels to these outbound events.
// ---------------------------------------------------------------------------

export type ConversationStateValue = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface ConversationStatePayload {
  state: ConversationStateValue
}

export type TtsStateValue = 'speaking' | 'ready'

export interface TtsStatePayload {
  state: TtsStateValue
}

export interface VisionPersonPresentPayload {
  present: boolean
}

export const conversationState = defineOutboundEventa<ConversationStatePayload>('robot:conversation-state')
export const ttsState = defineOutboundEventa<TtsStatePayload>('robot:tts-state')
export const visionPersonPresent = defineOutboundEventa<VisionPersonPresentPayload>('robot:vision-person-present')

/**
 * Robot-side TTS request. Producers (proxy.py canned response, person_detector
 * greeting, future main_task_node feedback) POST `/api/system-message` with
 * `tts: true`; the server then publishes on the `tts:request` redis channel.
 * The bridge re-emits as this ws event so the browser tab can fetch synthesis
 * and play through its own `<audio>` element — keeping AEC inside one process.
 */
export interface TtsRequestPayload {
  text: string
  voice?: string
  source?: string
}

export const ttsRequest = defineOutboundEventa<TtsRequestPayload>('robot:tts-request')
