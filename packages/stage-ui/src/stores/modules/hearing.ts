import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { WithUnknown } from '@xsai/shared'
import type { StreamTranscriptionResult, StreamTranscriptionOptions as XSAIStreamTranscriptionOptions } from '@xsai/stream-transcription'

import { tryCatch } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { generateTranscription } from '@xsai/generate-transcription'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import vadWorkletUrl from '../../workers/vad/process.worklet?worker&url'

import { useProvidersStore } from '../providers'
import { streamAliyunTranscription } from '../providers/aliyun/stream-transcription'
import { streamWebSpeechAPITranscription } from '../providers/web-speech-api'
import { useSettings } from '../settings'

export interface StreamTranscriptionFileInputOptions extends Omit<XSAIStreamTranscriptionOptions, 'file' | 'fileName'> {
  file: Blob
  fileName?: string
}

export interface StreamTranscriptionStreamInputOptions extends Omit<XSAIStreamTranscriptionOptions, 'file' | 'fileName'> {
  inputAudioStream: ReadableStream<ArrayBuffer>
}

export type StreamTranscription = (options: WithUnknown<StreamTranscriptionFileInputOptions | StreamTranscriptionStreamInputOptions>) => StreamTranscriptionResult

type GenerateTranscriptionResponse = Awaited<ReturnType<typeof generateTranscription>>
type TranscriptionResponseFormat = 'json' | 'verbose_json' | 'text'
type HearingTranscriptionGenerateResult = (GenerateTranscriptionResponse & { mode: 'generate', responseFormat: Exclude<TranscriptionResponseFormat, 'text'> }) | { mode: 'generate', responseFormat: 'text', text: string }
type HearingTranscriptionStreamResult = StreamTranscriptionResult & { mode: 'stream' }
export type HearingTranscriptionResult = HearingTranscriptionGenerateResult | HearingTranscriptionStreamResult

type HearingTranscriptionInput = File | {
  file?: File
  inputAudioStream?: ReadableStream<ArrayBuffer>
}

interface HearingTranscriptionInvokeOptions {
  providerOptions?: Record<string, unknown>
  /**
   * Hint language for STT backend. Common values:
   * - 'auto'
   * - 'zh' | 'en' | 'ja'
   */
  language?: string
}

const STREAM_TRANSCRIPTION_EXECUTORS: Record<string, StreamTranscription> = {
  'aliyun-nls-transcription': streamAliyunTranscription,
  // Web Speech API is handled specially in transcribeForMediaStream since it works directly with MediaStream
}

export const useHearingStore = defineStore('hearing-store', () => {
  const providersStore = useProvidersStore()
  const { allAudioTranscriptionProvidersMetadata } = storeToRefs(providersStore)

  // State
  const activeTranscriptionProvider = useLocalStorageManualReset('settings/hearing/active-provider', '')
  const activeTranscriptionModel = useLocalStorageManualReset('settings/hearing/active-model', '')
  const activeCustomModelName = useLocalStorageManualReset('settings/hearing/active-custom-model', '')
  const transcriptionModelSearchQuery = refManualReset<string>('')
  const autoSendEnabled = useLocalStorageManualReset<boolean>('settings/hearing/auto-send-enabled', false)
  const autoSendDelay = useLocalStorageManualReset<number>('settings/hearing/auto-send-delay', 2000) // Default 2 seconds

  // Computed properties
  const availableProvidersMetadata = computed(() => allAudioTranscriptionProvidersMetadata.value)

  // Computed properties
  const supportsModelListing = computed(() => {
    return providersStore.getProviderMetadata(activeTranscriptionProvider.value)?.capabilities.listModels !== undefined
  })

  const providerModels = computed(() => {
    return providersStore.getModelsForProvider(activeTranscriptionProvider.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    return providersStore.isLoadingModels[activeTranscriptionProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    return providersStore.modelLoadError[activeTranscriptionProvider.value] || null
  })

  async function loadModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  // Keep provider model list fresh when user switches provider in Hearing settings UI.
  watch(activeTranscriptionProvider, async (providerId) => {
    if (providerId) {
      // Persist provider selection so it doesn't disappear from the Hearing page selector.
      providersStore.markProviderAdded(providerId)
      await loadModelsForProvider(providerId)
    }
  }, { immediate: true })

  async function getModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  const configured = computed(() => {
    if (!activeTranscriptionProvider.value)
      return false

    // Web Speech API doesn't strictly need a model selected (it has a default)
    // but we still check to maintain consistency
    if (activeTranscriptionProvider.value === 'browser-web-speech-api') {
      return true // Web Speech API is ready if provider is selected and available
    }

    // For OpenAI Compatible providers, check provider config as fallback
    let hasProviderModel = false
    if (activeTranscriptionProvider.value === 'openai-compatible-audio-transcription') {
      const providerConfig = providersStore.getProviderConfig(activeTranscriptionProvider.value)
      hasProviderModel = !!providerConfig?.model
    }

    return !!activeTranscriptionModel.value || hasProviderModel
  })

  function resetState() {
    activeTranscriptionProvider.reset()
    activeTranscriptionModel.reset()
    activeCustomModelName.reset()
    transcriptionModelSearchQuery.reset()
    autoSendEnabled.reset()
    autoSendDelay.reset()
  }

  async function transcription(
    providerId: string,
    provider: TranscriptionProviderWithExtraOptions<string, any>,
    model: string,
    input: HearingTranscriptionInput,
    format?: TranscriptionResponseFormat,
    options?: HearingTranscriptionInvokeOptions,
  ): Promise<HearingTranscriptionResult> {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:useHearingStore.transcription', message: 'enter transcription()', data: { providerId, model, format: format ?? 'default', hasFile: input instanceof File || !!(input as any)?.file, hasStream: !!(input as any)?.inputAudioStream }, timestamp: Date.now() }) }).catch(() => {})
    // #endregion
    const normalizedInput = (input instanceof File ? { file: input } : input ?? {}) as {
      file?: File
      inputAudioStream?: ReadableStream<ArrayBuffer>
    }
    const features = providersStore.getTranscriptionFeatures(providerId)
    const streamExecutor = STREAM_TRANSCRIPTION_EXECUTORS[providerId]

    if (features.supportsStreamOutput && streamExecutor) {
      // TODO: integrate VAD-driven silence detection to stop and restart realtime sessions based on silence thresholds.
      const request = provider.transcription(model, options?.providerOptions)

      if (features.supportsStreamInput && normalizedInput.inputAudioStream) {
        const streamResult = streamExecutor({
          ...request,
          inputAudioStream: normalizedInput.inputAudioStream,
        } as Parameters<typeof streamExecutor>[0])
        return {
          mode: 'stream',
          ...streamResult,
        }
      }

      if (!features.supportsStreamInput && normalizedInput.file) {
        const streamResult = streamExecutor({
          ...request,
          file: normalizedInput.file,
        } as Parameters<typeof streamExecutor>[0])
        return {
          mode: 'stream',
          ...streamResult,
        }
      }

      if (features.supportsStreamInput && !normalizedInput.inputAudioStream && normalizedInput.file) {
        const streamResult = streamExecutor({
          ...request,
          file: normalizedInput.file,
        } as Parameters<typeof streamExecutor>[0])
        return {
          mode: 'stream',
          ...streamResult,
        }
      }

      if (!features.supportsGenerate || !normalizedInput.file) {
        throw new Error('No compatible input provided for streaming transcription.')
      }
    }

    if (!normalizedInput.file) {
      throw new Error('File input is required for transcription.')
    }

    const resolvedFormat: TranscriptionResponseFormat = format || 'json'

    // NOTE: @xsai/generate-transcription currently supports only json / verbose_json.
    // For response_format=text (VCS contract), we do a minimal multipart request manually,
    // still using the provider's baseURL / headers / apiKey and returning a compatible shape.
    if (resolvedFormat === 'text') {
      const request = provider.transcription(model, options?.providerOptions) as {
        baseURL: string | URL
        apiKey?: string
        headers?: Headers | Record<string, string>
        fetch?: typeof globalThis.fetch
      }

      const baseURL = request.baseURL
      const url = typeof baseURL === 'string'
        ? `${baseURL}audio/transcriptions`
        : new URL('audio/transcriptions', baseURL).toString()

      const formData = new FormData()
      formData.append('file', normalizedInput.file, (normalizedInput.file as any).name || 'audio.wav')
      formData.append('model', model)
      if (options?.language)
        formData.append('language', options.language)
      formData.append('response_format', 'text')

      const fetchImpl = request.fetch || globalThis.fetch
      const headers: Record<string, string> = {}
      if (request.headers instanceof Headers) {
        request.headers.forEach((value, key) => {
          // Avoid forcing content-type for multipart
          if (key.toLowerCase() !== 'content-type')
            headers[key] = value
        })
      }
      else if (request.headers && typeof request.headers === 'object') {
        for (const [k, v] of Object.entries(request.headers)) {
          if (k.toLowerCase() !== 'content-type')
            headers[k] = v
        }
      }
      if (request.apiKey)
        headers.Authorization = `Bearer ${request.apiKey}`

      const abortSignal = (options?.providerOptions as any)?.abortSignal as AbortSignal | undefined

      const res = await fetchImpl(url as any, {
        method: 'POST',
        headers,
        body: formData,
        signal: abortSignal,
      })

      if (!res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase()
        if (ct.includes('application/json')) {
          const err = await res.json().catch(() => ({} as any))
          throw new Error(err?.error?.message || `HTTP ${res.status} ${res.statusText}`)
        }
        const detail = await res.text().catch(() => '')
        throw new Error(detail || `HTTP ${res.status} ${res.statusText}`)
      }

      const text = await res.text()
      return {
        mode: 'generate',
        responseFormat: 'text',
        text,
      }
    }

    const req = provider.transcription(model, options?.providerOptions) as any
    const base = typeof req?.baseURL === 'string'
      ? req.baseURL
      : req?.baseURL instanceof URL
        ? req.baseURL.toString()
        : ''
    const normalizeBaseUrlForLog = (input: string) => {
      try {
        const u = new URL(input)
        return `${u.protocol}//${u.host}${u.pathname}`
      }
      catch {
        return input
      }
    }
    const baseUrlForLog = base ? normalizeBaseUrlForLog(base) : '(unknown)'
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:useHearingStore.transcription', message: 'about to call generateTranscription', data: { providerId, model, responseFormat: resolvedFormat, baseURL: baseUrlForLog }, timestamp: Date.now() }) }).catch(() => {})
    // #endregion

    let response: any
    try {
      response = await generateTranscription({
        ...req,
        file: normalizedInput.file,
        language: options?.language,
        responseFormat: resolvedFormat === 'verbose_json' ? 'verbose_json' : 'json',
      } as any)
    }
    catch (e) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:useHearingStore.transcription', message: 'generateTranscription threw', data: { providerId, model, error: String((e as any)?.message ?? e) }, timestamp: Date.now() }) }).catch(() => {})
      // #endregion
      throw e
    }

    return {
      mode: 'generate',
      responseFormat: resolvedFormat === 'verbose_json' ? 'verbose_json' : 'json',
      ...response,
    }
  }

  return {
    activeTranscriptionProvider,
    activeTranscriptionModel,
    availableProvidersMetadata,
    activeCustomModelName,
    transcriptionModelSearchQuery,
    autoSendEnabled,
    autoSendDelay,

    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    configured,

    transcription,
    loadModelsForProvider,
    getModelsForProvider,
    resetState,
  }
})

export const useHearingSpeechInputPipeline = defineStore('modules:hearing:speech:audio-input-pipeline', () => {
  const error = ref<string>()

  const hearingStore = useHearingStore()
  const { activeTranscriptionProvider, activeTranscriptionModel } = storeToRefs(hearingStore)
  const providersStore = useProvidersStore()
  const settingsStore = useSettings()
  const { language: uiLanguage } = storeToRefs(settingsStore)

  const languageHint = computed(() => {
    const lang = (uiLanguage.value || navigator.language || '').toLowerCase()
    if (lang.startsWith('zh'))
      return 'zh'
    if (lang.startsWith('ja'))
      return 'ja'
    if (lang.startsWith('ko'))
      return 'ko'
    // Let provider decide for other languages / auto-detect.
    return undefined
  })
  const streamingSession = shallowRef<{
    audioContext: AudioContext | Record<string, never>
    workletNode: AudioWorkletNode | Record<string, never>
    mediaStreamSource: MediaStreamAudioSourceNode | Record<string, never>
    audioStreamController?: ReadableStreamDefaultController<ArrayBuffer>
    abortController: AbortController
    result?: HearingTranscriptionResult & { recognition?: any }
    idleTimer?: ReturnType<typeof setTimeout>
    providerId?: string
    callbacks?: {
      onSentenceEnd?: (delta: string) => void
      onSpeechEnd?: (text: string) => void
    }
  }>()

  const supportsStreamInput = computed(() => {
    const providerId = activeTranscriptionProvider.value
    if (!providerId)
      return false

    // Web Speech API always supports stream input when available
    if (providerId === 'browser-web-speech-api') {
      return typeof window !== 'undefined'
        && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
    }

    return providersStore.getTranscriptionFeatures(providerId).supportsStreamInput
  })

  const DEFAULT_SAMPLE_RATE = 16000
  const DEFAULT_STREAM_IDLE_TIMEOUT = 15000

  function float32ToInt16(buffer: Float32Array) {
    const output = new Int16Array(buffer.length)
    for (let i = 0; i < buffer.length; i++) {
      const value = Math.max(-1, Math.min(1, buffer[i]))
      output[i] = value < 0 ? value * 0x8000 : value * 0x7FFF
    }

    return output
  }

  async function createAudioStreamFromMediaStream(stream: MediaStream, sampleRate = DEFAULT_SAMPLE_RATE, onActivity?: () => void) {
    const audioContext = new AudioContext({ sampleRate, latencyHint: 'interactive' })
    await audioContext.audioWorklet.addModule(vadWorkletUrl)
    const workletNode = new AudioWorkletNode(audioContext, 'vad-audio-worklet-processor')

    let audioStreamController: ReadableStreamDefaultController<ArrayBuffer> | undefined
    const audioStream = new ReadableStream<ArrayBuffer>({
      start(controller) {
        audioStreamController = controller
      },
      cancel: () => {
        audioStreamController = undefined
      },
    })

    workletNode.port.onmessage = ({ data }: MessageEvent<{ buffer?: Float32Array }>) => {
      const buffer = data?.buffer
      if (!buffer || !audioStreamController)
        return

      const pcm16 = float32ToInt16(buffer)
      // Clone buffer to avoid retaining underlying ArrayBuffer references
      audioStreamController.enqueue(pcm16.buffer.slice(0))
      onActivity?.()
    }

    const mediaStreamSource = audioContext.createMediaStreamSource(stream)
    mediaStreamSource.connect(workletNode)

    // Sink to avoid feedback/echo
    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    workletNode.connect(silentGain)
    silentGain.connect(audioContext.destination)

    return {
      audioContext,
      workletNode,
      mediaStreamSource,
      audioStream,
      get controller() {
        return audioStreamController
      },
    }
  }

  async function stopStreamingTranscription(abort?: boolean, disposeProviderId?: string) {
    const session = streamingSession.value
    if (!session)
      return

    // Special handling for Web Speech API
    if (session.providerId === 'browser-web-speech-api') {
      try {
        const reason = new DOMException(abort ? 'Aborted' : 'Stopped', 'AbortError')
        if (!session.abortController.signal.aborted) {
          session.abortController.abort(reason)
        }

        // Stop Web Speech API recognition if it exists
        const result = session.result as any
        if (result?.recognition) {
          try {
            result.recognition.stop()
          }
          catch (err) {
            console.warn('Error stopping Web Speech API recognition:', err)
          }
        }
      }
      catch (err) {
        console.error('Error stopping Web Speech API session:', err)
      }

      if (session.idleTimer)
        clearTimeout(session.idleTimer)

      streamingSession.value = undefined

      if (session.result?.mode === 'stream') {
        try {
          const text = await session.result.text
          return text
        }
        catch (err) {
          error.value = err instanceof Error ? err.message : String(err)
          console.error('Error getting transcription result:', error.value)
        }
      }

      return
    }

    try {
      const reason = new DOMException(abort ? 'Aborted' : 'Stopped', 'AbortError')
      // Ensure provider transports (e.g., Aliyun NLS) are signaled to stop over websocket.
      if (!session.abortController.signal.aborted) {
        session.abortController.abort(reason)
      }

      if (abort)
        session.audioStreamController?.error(reason)
      else
        session.audioStreamController?.close()
    }
    catch {}

    await tryCatch(() => {
      session.mediaStreamSource.disconnect()
      session.workletNode.port.onmessage = null
      session.workletNode.disconnect()
    })
    await tryCatch(() => session.audioContext.close())

    if (session.idleTimer)
      clearTimeout(session.idleTimer)

    streamingSession.value = undefined

    if (session.result?.mode === 'stream') {
      try {
        const text = await session.result.text

        if (disposeProviderId) {
          await providersStore.disposeProviderInstance(disposeProviderId)
        }

        return text
      }
      catch (err) {
        error.value = err instanceof Error ? err.message : String(err)
        console.error('Error generating transcription:', error.value)
      }
    }

    const text = session.result?.text
    if (disposeProviderId)
      await providersStore.disposeProviderInstance(disposeProviderId)

    return text
  }

  async function transcribeForMediaStream(stream: MediaStream, options?: {
    sampleRate?: number
    providerOptions?: Record<string, unknown>
    idleTimeoutMs?: number
    onSentenceEnd?: (delta: string) => void
    onSpeechEnd?: (text: string) => void
  }) {
    console.info('[Hearing Pipeline] transcribeForMediaStream called', {
      supportsStreamInput: supportsStreamInput.value,
      hasStream: !!stream,
      providerId: activeTranscriptionProvider.value,
      hasCallbacks: !!(options?.onSentenceEnd || options?.onSpeechEnd),
    })

    if (!supportsStreamInput.value) {
      console.warn('[Hearing Pipeline] Stream input not supported')
      return
    }

    try {
      const providerId = activeTranscriptionProvider.value
      if (!providerId) {
        error.value = 'No transcription provider selected'
        console.error('[Hearing Pipeline] No transcription provider selected')
        return
      }

      console.info('[Hearing Pipeline] Using provider:', providerId)
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:transcribeForMediaStream', message: 'enter transcribeForMediaStream', data: { providerId, model: activeTranscriptionModel.value, supportsStreamInput: supportsStreamInput.value, hasExistingSession: !!streamingSession.value }, timestamp: Date.now() }) }).catch(() => {})
      // #endregion

      // Special handling for Web Speech API - it works directly with MediaStream
      if (providerId === 'browser-web-speech-api') {
        // Check if Web Speech API is available
        const isAvailable = typeof window !== 'undefined'
          && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)

        if (!isAvailable) {
          error.value = 'Web Speech API is not available in this browser'
          console.error('Web Speech API is not available')
          return
        }

        // Check if session already exists and reuse it
        const existingSession = streamingSession.value
        if (existingSession && existingSession.providerId === 'browser-web-speech-api') {
          // For Web Speech API, if callbacks are provided and different, we need to restart
          // because recognition instance callbacks are set once and can't be changed
          // However, if no new callbacks are provided, we can just reuse the session
          const hasNewCallbacks = !!(options?.onSentenceEnd || options?.onSpeechEnd)

          if (hasNewCallbacks) {
            // We need to restart to use new callbacks, but only if they're actually different
            // Since we can't compare functions, we'll just always restart if new callbacks are provided
            // This ensures callbacks are always up-to-date
            console.info('Web Speech API: New callbacks provided, restarting session to use them')
            await stopStreamingTranscription(false, existingSession.providerId)
            // Continue to create new session below
            // Note: stopStreamingTranscription already clears streamingSession.value and waits for async cleanup
          }
          else {
            // No new callbacks - just bump idle timer and reuse existing session
            const idleTimeout = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT
            if (existingSession.idleTimer) {
              clearTimeout(existingSession.idleTimer)
              existingSession.idleTimer = setTimeout(async () => {
                await stopStreamingTranscription(false, existingSession.providerId)
              }, idleTimeout)
            }

            console.info('Web Speech API session already active, reusing existing session (no callback changes)')
            return
          }
        }

        // Auto-select default model if not selected
        if (!activeTranscriptionModel.value) {
          // Try to get models for the provider and select the first one
          const models = await providersStore.getModelsForProvider(providerId)
          if (models.length > 0) {
            activeTranscriptionModel.value = models[0].id
            console.info('Auto-selected Web Speech API model:', models[0].id)
          }
          else {
            // Fallback to default model ID
            activeTranscriptionModel.value = 'web-speech-api'
            console.info('Auto-selected Web Speech API default model')
          }
        }

        const abortController = new AbortController()

        // Get provider config for language settings
        const providerConfig = providersStore.getProviderConfig(providerId) || {}
        const language = (options?.providerOptions?.language as string)
          || (providerConfig.language as string)
          || 'en-US'

        // Web Speech API in continuous mode should run indefinitely - no idle timeout
        // Only stop when explicitly requested (e.g., microphone disabled)
        const idleTimeout = options?.idleTimeoutMs ?? 0 // 0 = disabled
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const bumpIdle = () => {
          if (idleTimeout > 0) {
            if (idleTimer)
              clearTimeout(idleTimer)
            idleTimer = setTimeout(async () => {
              await stopStreamingTranscription(false, providerId)
            }, idleTimeout)
          }
        }

        const result = streamWebSpeechAPITranscription(stream, {
          language,
          continuous: (options?.providerOptions?.continuous as boolean) ?? (providerConfig.continuous as boolean) ?? true,
          interimResults: (options?.providerOptions?.interimResults as boolean) ?? (providerConfig.interimResults as boolean) ?? true,
          maxAlternatives: (options?.providerOptions?.maxAlternatives as number) ?? (providerConfig.maxAlternatives as number) ?? 1,
          abortSignal: abortController.signal,
          onSentenceEnd: (delta) => {
            bumpIdle() // Bump idle timer on activity (only if enabled)
            // Call the options callback
            options?.onSentenceEnd?.(delta)
          },
          onSpeechEnd: (text) => {
            // Call the options callback
            options?.onSpeechEnd?.(text)
          },
        })

        // Store session info for cleanup
        const recognitionInstance = (result as any).recognition
        streamingSession.value = {
          audioContext: {} as AudioContext, // Not used for Web Speech API
          workletNode: {} as AudioWorkletNode, // Not used for Web Speech API
          mediaStreamSource: {} as MediaStreamAudioSourceNode, // Not used for Web Speech API
          audioStreamController: undefined,
          abortController,
          result: { ...result, mode: 'stream' as const, recognition: recognitionInstance },
          idleTimer,
          providerId,
          callbacks: {
            onSentenceEnd: options?.onSentenceEnd,
            onSpeechEnd: options?.onSpeechEnd,
          },
        } as any // Type assertion needed because recognition is extra

        // Initial idle timer (only if enabled)
        bumpIdle()

        // Stream out text deltas
        if (result.textStream) {
          void (async () => {
            try {
              const reader = result.textStream.getReader()

              while (true) {
                const { done } = await reader.read()
                if (done)
                  break
                // onSentenceEnd is already called from the recognition.onresult handler
                // Note: onSpeechEnd is called from web-speech-api/index.ts recognition.onend handler
                // (line 332 for non-continuous mode, line 271 for errors)
                // We don't call it here to avoid duplicate calls
              }
            }
            catch (err) {
              console.error('Error reading text stream:', err)
            }
          })()
        }

        return
      }
      const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, any>>(providerId)
      if (!provider) {
        throw new Error('Failed to initialize speech provider')
      }

      const idleTimeout = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT

      // If a session exists, reuse it unless new callbacks are provided.
      // The stream reader captures callbacks at creation time, so updated callbacks
      // require restarting the session to create a new reader.
      const existingSession = streamingSession.value
      if (existingSession) {
        const hasNewCallbacks
          = options?.onSentenceEnd !== undefined
            || options?.onSpeechEnd !== undefined

        if (hasNewCallbacks) {
          console.info('[Hearing Pipeline] New callbacks provided, restarting session')
          await stopStreamingTranscription(false, existingSession.providerId)
          // Fall through to create a new session with updated callbacks
        }
        else {
          // No callback changes: refresh idle timer and reuse session
          if (existingSession.idleTimer) {
            clearTimeout(existingSession.idleTimer)
            existingSession.idleTimer = setTimeout(async () => {
              await stopStreamingTranscription(false, existingSession.providerId)
            }, idleTimeout)
          }
          return
        }
      }

      const abortController = new AbortController()
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const bumpIdle = () => {
        if (idleTimer)
          clearTimeout(idleTimer)
        idleTimer = setTimeout(async () => {
          await stopStreamingTranscription(false, providerId)
        }, idleTimeout)
      }

      const session = await createAudioStreamFromMediaStream(
        stream,
        options?.sampleRate ?? DEFAULT_SAMPLE_RATE,
        () => bumpIdle(),
      )

      if (session.audioContext.state === 'suspended')
        await session.audioContext.resume()

      bumpIdle()

      const model = activeTranscriptionModel.value
      const result = await hearingStore.transcription(
        providerId,
        provider,
        model,
        { inputAudioStream: session.audioStream },
        undefined,
        {
          providerOptions: {
            abortSignal: abortController.signal,
            ...options?.providerOptions,
          },
          language: languageHint.value,
        },
      )

      streamingSession.value = {
        audioContext: session.audioContext,
        workletNode: session.workletNode,
        mediaStreamSource: session.mediaStreamSource,
        audioStreamController: session.controller,
        abortController,
        result,
        idleTimer,
        providerId,
        callbacks: {
          onSentenceEnd: options?.onSentenceEnd,
          onSpeechEnd: options?.onSpeechEnd,
        },
      }

      // Stream out text deltas to caller without tearing down the session.
      if (result.mode === 'stream' && result.textStream) {
        void (async () => {
          // Capture callbacks from the session at the time the reader is created
          // This prevents cross-session leakage if the session is restarted before
          // this reader finishes (e.g., when navigating between pages or callbacks change)
          const sessionCallbacks = {
            onSentenceEnd: streamingSession.value?.callbacks?.onSentenceEnd,
            onSpeechEnd: streamingSession.value?.callbacks?.onSpeechEnd,
          }

          let fullText = ''
          let loggedFirst = false
          try {
            const reader = result.textStream.getReader()

            while (true) {
              const { done, value } = await reader.read()
              if (done)
                break
              if (value) {
                fullText += value
                if (!loggedFirst) {
                  loggedFirst = true
                  // #region agent log
                  fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:transcribeForMediaStream', message: 'first text delta received', data: { providerId, deltaLen: value.length }, timestamp: Date.now() }) }).catch(() => {})
                  // #endregion
                }
                // Use captured callbacks to avoid cross-session leakage
                sessionCallbacks.onSentenceEnd?.(value)
              }
            }
          }
          catch (err) {
            console.error('Error reading text stream:', err)
          }
          finally {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:transcribeForMediaStream', message: 'stream ended', data: { providerId, fullLen: fullText.length }, timestamp: Date.now() }) }).catch(() => {})
            // #endregion
            // Use captured callbacks to avoid cross-session leakage
            sessionCallbacks.onSpeechEnd?.(fullText)
          }
        })()
      }
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      console.error('Error generating transcription:', error.value)
    }
  }

  async function transcribeForRecording(recording: Blob | null | undefined) {
    if (!recording)
      return

    try {
      if (recording && recording.size > 0) {
        const providerId = activeTranscriptionProvider.value
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:transcribeForRecording', message: 'enter transcribeForRecording', data: { providerId, model: activeTranscriptionModel.value, blobSize: recording.size }, timestamp: Date.now() }) }).catch(() => {})
        // #endregion
        const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, any>>(providerId)
        if (!provider) {
          throw new Error('Failed to initialize speech provider')
        }

        // Get model from configuration or use default
        const model = activeTranscriptionModel.value
        const result = await hearingStore.transcription(
          providerId,
          provider,
          model,
          new File([recording], 'recording.wav'),
          undefined,
          {
            providerOptions: providersStore.getProviderConfig(providerId),
            language: languageHint.value,
          },
        )
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:transcribeForRecording', message: 'transcription result received', data: { providerId, mode: result.mode, textLen: (result as any)?.text ? String((result as any).text).length : 0 }, timestamp: Date.now() }) }).catch(() => {})
        // #endregion
        return result.mode === 'stream' ? await result.text : result.text
      }
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'B', location: 'packages/stage-ui/src/stores/modules/hearing.ts:transcribeForRecording', message: 'transcribeForRecording failed', data: { error: error.value }, timestamp: Date.now() }) }).catch(() => {})
      // #endregion
      console.error('Error generating transcription:', error.value)
    }
  }

  return {
    error,

    transcribeForRecording,
    transcribeForMediaStream,
    stopStreamingTranscription,
    supportsStreamInput,
  }
})
