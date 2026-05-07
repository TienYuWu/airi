import { nanoid } from 'nanoid'
import { onUnmounted } from 'vue'

import { useChatSessionStore } from '../stores/chat/session-store'
import { useAutoTtsStore } from '../stores/modules/auto-tts'

const DEFAULT_AIRI_API_URL: string
  = (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.VITE_AIRI_API_URL)
  || 'http://localhost:6112'

interface SystemMessageEvent {
  text: string
  voice?: string
  source?: string
}

/**
 * Subscribe to the airi server's `/api/events/system-messages` SSE stream and
 * route each event to (a) the local chat session as an assistant message and
 * (b) the browser's auto-tts player.
 *
 * Use when:
 * - stage-web boots a kiosk and wants person_detector greetings / proxy
 *   canned responses / main_task_node feedback to surface in the same chat
 *   UI and audio output as locally-generated LLM responses.
 *
 * Auto-cleanup:
 * - Closes the EventSource on `onUnmounted` of the calling component.
 *
 * Limitations:
 * - The injected assistant message is appended to the *active* local session
 *   (whichever one is currently focused in stage-web) rather than the
 *   persisted server-side chat. Refreshing the page won't restore them.
 *   Acceptable for kiosk usage; address with a chat-history pull if needed.
 */
export function useSystemMessageSse(options?: { apiUrl?: string }) {
  const apiUrl = options?.apiUrl ?? DEFAULT_AIRI_API_URL
  const chatSession = useChatSessionStore()
  const autoTts = useAutoTtsStore()

  const url = `${apiUrl.replace(/\/$/, '')}/api/events/system-messages`
  // withCredentials so the airi cors+auth-cookie path is consistent with
  // /api/v1/openai/chat/completions calls the chat already uses.
  const source = new EventSource(url, { withCredentials: true })

  source.addEventListener('system-message', (rawEvent) => {
    let payload: SystemMessageEvent
    try {
      payload = JSON.parse((rawEvent as MessageEvent).data) as SystemMessageEvent
    }
    catch (err) {
      console.warn('[system-message-sse] bad payload', err)
      return
    }
    if (!payload?.text)
      return

    const sessionId = chatSession.activeSessionId
    if (sessionId) {
      chatSession.appendSessionMessage(sessionId, {
        role: 'assistant',
        content: payload.text,
        slices: [{ type: 'text', text: payload.text }],
        tool_results: [],
        id: nanoid(),
        createdAt: Date.now(),
      } as any)
    }

    void autoTts.play(payload.text)
  })

  source.addEventListener('error', (err) => {
    // Browsers auto-reconnect on transient errors; we just log.
    console.debug('[system-message-sse] connection error (will retry)', err)
  })

  function dispose() {
    source.close()
  }

  onUnmounted(dispose)

  return { dispose }
}
