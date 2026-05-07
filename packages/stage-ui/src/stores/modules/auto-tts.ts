import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useSpeakingStore } from '../audio'

/**
 * Default edgetts URL. The compose stack maps `edgetts` container's port 8000
 * to host 5002, and stage-web is served from the same host (port 8080), so a
 * direct same-origin-ish call to localhost:5002 works in dev. For deployment
 * behind a reverse proxy, override via `VITE_EDGETTS_URL` at build time.
 */
const DEFAULT_EDGETTS_URL: string
  = (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.VITE_EDGETTS_URL)
  || 'http://localhost:5002'

const DEFAULT_VOICE = 'zh-TW-HsiaoChenNeural'

/**
 * Browser-side TTS playback utility. v2 owns audio output in the browser tab
 * so the browser's built-in echo cancellation can suppress robot voice from
 * being picked up by Web Speech API on the same tab.
 *
 * Use when:
 * - You have a piece of text the robot should speak NOW. Caller decides
 *   whether to drive this from chat hooks, an SSE subscription, or some
 *   other event source.
 *
 * Why no chat hook subscription in this store:
 * - Stage.vue already registers a speech-pipeline that consumes chat hooks
 *   and plays via the configured TTS provider with lip-sync animation. Adding
 *   another subscriber here would double-play every response.
 *
 * Behaviour:
 * - Calls edgetts → mp3 blob → shared `<audio>` element.
 * - Aborts and replaces in-flight or in-progress playback when a new `play()`
 *   arrives so sequential utterances don't pile up.
 * - Toggles `useSpeakingStore.nowSpeaking` so any UI animation watching it
 *   gets a hint, even if not driven by the lip-sync analyser.
 */
export const useAutoTtsStore = defineStore('modules:auto-tts', () => {
  const enabled = ref(true)
  const edgettsUrl = ref(DEFAULT_EDGETTS_URL)
  const voice = ref(DEFAULT_VOICE)

  let audio: HTMLAudioElement | null = null
  let currentBlobUrl: string | null = null
  let abortController: AbortController | null = null

  function clearBlob() {
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl)
      currentBlobUrl = null
    }
  }

  function ensureAudio(): HTMLAudioElement {
    if (audio)
      return audio

    audio = new Audio()
    const speakingStore = useSpeakingStore()
    audio.addEventListener('ended', () => {
      speakingStore.nowSpeaking = false
      clearBlob()
    })
    audio.addEventListener('error', () => {
      speakingStore.nowSpeaking = false
      clearBlob()
    })
    return audio
  }

  /**
   * Synthesise + play `text`. Aborts any in-flight or in-progress playback so
   * the latest response always wins. Returns when playback has *started*, not
   * when it finishes.
   */
  async function play(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!enabled.value || trimmed.length === 0)
      return

    abortController?.abort()
    abortController = new AbortController()

    const speakingStore = useSpeakingStore()
    const a = ensureAudio()

    if (!a.paused)
      a.pause()
    clearBlob()

    try {
      const resp = await fetch(`${edgettsUrl.value}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: trimmed, voice: voice.value }),
        signal: abortController.signal,
      })

      if (!resp.ok) {
        console.warn('[auto-tts] edgetts returned', resp.status)
        return
      }

      const blob = await resp.blob()
      currentBlobUrl = URL.createObjectURL(blob)
      a.src = currentBlobUrl
      speakingStore.nowSpeaking = true
      await a.play()
    }
    catch (err) {
      if ((err as Error).name === 'AbortError')
        return
      console.warn('[auto-tts] failed to play TTS:', err)
      speakingStore.nowSpeaking = false
      clearBlob()
    }
  }

  function dispose() {
    abortController?.abort()
    abortController = null
    audio?.pause()
    clearBlob()
  }

  return {
    enabled,
    edgettsUrl,
    voice,
    play,
    dispose,
  }
})
