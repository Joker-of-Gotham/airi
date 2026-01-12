<script setup lang="ts">
import type { SpeechIntentCancelPayload, SpeechIntentEndPayload, SpeechIntentStartPayload, SpeechIntentTokenPayload } from '../../services/speech/bus'
import type { VoiceTraceLlmDeltaPayload, VoiceTraceLlmEndPayload, VoiceTraceLlmStartPayload, VoiceTraceOutputLevelPayload } from '../../services/voice-trace/bus'

import { Button, FieldCheckbox, FieldRange } from '@proj-airi/ui'
import { useBroadcastChannel, useLocalStorage } from '@vueuse/core'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import { useAudioAnalyzer } from '../../composables/audio/audio-analyzer'
import {
  getSpeechBusContext,
  speechIntentCancelEvent,
  speechIntentEndEvent,
  speechIntentFlushEvent,
  speechIntentLiteralEvent,
  speechIntentSpecialEvent,
  speechIntentStartEvent,
  speechStopAllEvent,
} from '../../services/speech/bus'
import { getVoiceTraceBusContext, voiceTraceLlmDeltaEvent, voiceTraceLlmEndEvent, voiceTraceLlmStartEvent, voiceTraceOutputLevelEvent, voiceTraceOverlayDragEvent } from '../../services/voice-trace/bus'

type CaptionChannelEvent
  = | { type: 'caption-speaker', text: string }
    | { type: 'caption-assistant', text: string }

interface RingBufferOptions {
  size: number
}
function createRingBuffer(options: RingBufferOptions) {
  const buf = ref<number[]>([])
  function push(v: number) {
    const next = [...buf.value, v]
    if (next.length > options.size)
      next.splice(0, next.length - options.size)
    buf.value = next
  }
  return { buf, push }
}

function clamp(v: number, min: number, max: number) {
  if (Number.isNaN(v))
    return min
  return Math.max(min, Math.min(max, v))
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

const STORAGE_KEY = 'devtools/voice-trace-overlay'

// Read-only (or one-click toggle) settings via localStorage keys.
// This keeps the overlay independent from stage Pinia stores/state graph.
const stageMicEnabled = useLocalStorage<boolean>('settings/audio/input/enabled', false)
const stageMicDeviceId = useLocalStorage<string>('settings/audio/input', '')
const sttProviderId = useLocalStorage<string>('settings/hearing/active-provider', '')
const sttModelId = useLocalStorage<string>('settings/hearing/active-model', '')
const speechRate = useLocalStorage<number>('settings/speech/rate', 1)

const sttText = ref('')
const lastCaption = ref<{ type: string, len: number, at: number } | null>(null)
const llmStatus = ref<'idle' | 'sending' | 'streaming' | 'done' | 'error'>('idle')
const llmError = ref<string>('')
const llmOutput = ref('')
const llmTokenCount = ref(0)

// Mic monitoring is fully self-contained: independent page gets its own MediaStream + AudioContext.
const { startAnalyzer, stopAnalyzer, onAnalyzerUpdate, volumeLevel: inputVolumeLevel } = useAudioAnalyzer()
const micMonitoring = ref(false)
const inputHistory = createRingBuffer({ size: 60 })
let offAnalyzerUpdate: (() => void) | undefined
let micStream: MediaStream | null = null
let micAudioContext: AudioContext | null = null
let micSourceNode: MediaStreamAudioSourceNode | null = null

async function askPermission() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // stop immediately; we just want the permission gate
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }
  catch {}
}

function enableStageMic() {
  // If user never selected a device, prefer "default" so stage can start stream.
  if (!stageMicDeviceId.value)
    stageMicDeviceId.value = 'default'
  stageMicEnabled.value = true
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'A', location: 'packages/stage-ui/src/components/devtools/voice-trace-overlay.vue:enableStageMic', message: 'enable stage mic via localStorage', data: { stageMicDeviceId: stageMicDeviceId.value }, timestamp: Date.now() }) }).catch(() => {})
  // #endregion
}

async function startMicMonitoring() {
  // Start monitoring should also start the full stage pipeline (privacy-friendly toggle).
  if (!stageMicEnabled.value)
    enableStageMic()
  if (micMonitoring.value)
    return
  micMonitoring.value = true

  if (!offAnalyzerUpdate) {
    offAnalyzerUpdate = onAnalyzerUpdate((v) => {
      inputHistory.push(clamp(v / 100, 0, 1))
    })
  }

  if (!micStream)
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  if (!micAudioContext)
    micAudioContext = new AudioContext({ latencyHint: 'interactive' })

  try {
    micSourceNode?.disconnect()
  }
  catch {}
  micSourceNode = micAudioContext.createMediaStreamSource(micStream)
  const analyser = startAnalyzer(micAudioContext)
  if (analyser)
    micSourceNode.connect(analyser)
}

function stopMicMonitoring() {
  micMonitoring.value = false
  try {
    micSourceNode?.disconnect()
  }
  catch {}
  micSourceNode = null

  stopAnalyzer()

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }
  if (micAudioContext) {
    void micAudioContext.close().catch(() => {})
    micAudioContext = null
  }

  // Stop monitoring MUST stop the full stage pipeline too.
  stageMicEnabled.value = false
  // Stop any ongoing speech output immediately (barge-out).
  try {
    const speechBus = getSpeechBusContext()
    speechBus.emit(speechStopAllEvent, { originId: 'overlay', reason: 'stop-monitoring' })
  }
  catch {}

  // Clear observed text to avoid confusing stale UI.
  sttText.value = ''
  llmOutput.value = ''
  llmTokenCount.value = 0
  llmStatus.value = 'idle'
}
const llmStartedAt = ref<number | null>(null)
const lastModelCall = ref<{ provider?: string, model?: string }>({ provider: '(unknown)', model: '(unknown)' })

const outputLevel = ref(0)
const outputHistory = createRingBuffer({ size: 60 })

const { data: captionEvent } = useBroadcastChannel<CaptionChannelEvent, CaptionChannelEvent>({ name: 'airi-caption-overlay' })
watch(captionEvent, (evt) => {
  if (!evt)
    return
  if (evt.type === 'caption-speaker')
    sttText.value = evt.text
  lastCaption.value = { type: evt.type, len: typeof (evt as any).text === 'string' ? (evt as any).text.length : 0, at: Date.now() }
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'pre-fix', hypothesisId: 'C', location: 'packages/stage-ui/src/components/devtools/voice-trace-overlay.vue:captionEvent', message: 'caption event received', data: { type: evt.type, len: typeof (evt as any).text === 'string' ? (evt as any).text.length : 0 }, timestamp: Date.now() }) }).catch(() => {})
  // #endregion
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'run3', hypothesisId: 'C', location: 'packages/stage-ui/src/components/devtools/voice-trace-overlay.vue:captionEvent', message: 'caption->sttText update', data: { sttTextLen: sttText.value.length, lastCaption: lastCaption.value }, timestamp: Date.now() }) }).catch(() => {})
  // #endregion
  // caption-assistant is emitted from Stage playback events; LLM output should be observed via voice-trace bus.
})

watch(sttText, (v) => {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/783cccc2-5b30-488c-830d-4d552308c88b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'debug-session', runId: 'run3', hypothesisId: 'C', location: 'packages/stage-ui/src/components/devtools/voice-trace-overlay.vue:watch(sttText)', message: 'sttText changed', data: { len: v.length, preview: v.slice(0, 30) }, timestamp: Date.now() }) }).catch(() => {})
  // #endregion
})

const voiceTrace = getVoiceTraceBusContext()
const voiceTraceDisposers: Array<() => void> = []
voiceTraceDisposers.push(voiceTrace.on(voiceTraceLlmStartEvent, (evt) => {
  const payload = (evt as any)?.body as VoiceTraceLlmStartPayload | undefined
  if (!payload)
    return
  llmStatus.value = 'sending'
  llmError.value = ''
  llmOutput.value = ''
  llmTokenCount.value = 0
  llmStartedAt.value = payload.at
  lastModelCall.value = {
    provider: payload.meta?.providerId ?? '(unknown)',
    model: payload.meta?.model ?? '(unknown)',
  }
}))
voiceTraceDisposers.push(voiceTrace.on(voiceTraceLlmDeltaEvent, (evt) => {
  const payload = (evt as any)?.body as VoiceTraceLlmDeltaPayload | undefined
  if (!payload)
    return
  llmStatus.value = 'streaming'
  llmTokenCount.value += payload.delta.length
  llmOutput.value += payload.delta
}))
voiceTraceDisposers.push(voiceTrace.on(voiceTraceLlmEndEvent, (evt) => {
  const payload = (evt as any)?.body as VoiceTraceLlmEndPayload | undefined
  if (!payload)
    return
  llmStatus.value = 'done'
}))
voiceTraceDisposers.push(voiceTrace.on(voiceTraceOutputLevelEvent, (evt) => {
  const payload = (evt as any)?.body as VoiceTraceOutputLevelPayload | undefined
  if (!payload)
    return
  outputLevel.value = clamp(payload.level, 0, 1)
  outputHistory.push(outputLevel.value)
}))

const speechEvents = ref<Array<{ at: number, type: string, detail: string }>>([])
function pushSpeechEvent(type: string, detail: string) {
  speechEvents.value = [
    { at: Date.now(), type, detail },
    ...speechEvents.value,
  ].slice(0, 50)
}

const speechBus = getSpeechBusContext()
const speechBusDisposers: Array<() => void> = []
speechBusDisposers.push(speechBus.on(speechIntentStartEvent, (evt) => {
  const p = (evt as any)?.body as SpeechIntentStartPayload | undefined
  if (!p)
    return
  pushSpeechEvent('intent:start', `${p.intentId} / ${p.streamId} (${p.behavior ?? 'queue'})`)
}))
speechBusDisposers.push(speechBus.on(speechIntentLiteralEvent, (evt) => {
  const p = (evt as any)?.body as SpeechIntentTokenPayload | undefined
  if (!p)
    return
  pushSpeechEvent('token:literal', `${p.intentId} +${(p.value ?? '').length}`)
}))
speechBusDisposers.push(speechBus.on(speechIntentSpecialEvent, (evt) => {
  const p = (evt as any)?.body as SpeechIntentTokenPayload | undefined
  if (!p)
    return
  pushSpeechEvent('token:special', `${p.intentId} ${p.value ?? ''}`)
}))
speechBusDisposers.push(speechBus.on(speechIntentFlushEvent, (evt) => {
  const p = (evt as any)?.body as SpeechIntentTokenPayload | undefined
  if (!p)
    return
  pushSpeechEvent('token:flush', `${p.intentId}`)
}))
speechBusDisposers.push(speechBus.on(speechIntentEndEvent, (evt) => {
  const p = (evt as any)?.body as SpeechIntentEndPayload | undefined
  if (!p)
    return
  pushSpeechEvent('intent:end', `${p.intentId}`)
}))
speechBusDisposers.push(speechBus.on(speechIntentCancelEvent, (evt) => {
  const p = (evt as any)?.body as SpeechIntentCancelPayload | undefined
  if (!p)
    return
  pushSpeechEvent('intent:cancel', `${p.intentId} (${p.reason ?? ''})`)
}))

const state = reactive({
  minimized: false,
  opacity: 0.78,
  fontScale: 1.0,
  showSpeechEvents: true,
  showRaw: false,
  position: { x: 24, y: 24 },
})

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return
    const parsed = JSON.parse(raw) as Partial<typeof state> | undefined
    if (!parsed)
      return
    if (typeof parsed.minimized === 'boolean')
      state.minimized = parsed.minimized
    if (typeof parsed.opacity === 'number')
      state.opacity = clamp(parsed.opacity, 0.15, 0.98)
    if (typeof parsed.fontScale === 'number')
      state.fontScale = clamp(parsed.fontScale, 0.85, 1.25)
    if (typeof parsed.showSpeechEvents === 'boolean')
      state.showSpeechEvents = parsed.showSpeechEvents
    if (typeof parsed.showRaw === 'boolean')
      state.showRaw = parsed.showRaw
    if (parsed.position && typeof parsed.position.x === 'number' && typeof parsed.position.y === 'number') {
      state.position.x = parsed.position.x
      state.position.y = parsed.position.y
    }
  }
  catch {}
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
  catch {}
}

watch(() => ({ ...state, position: { ...state.position } }), () => saveState(), { deep: true })

const drag = reactive({
  dragging: false,
  startX: 0,
  startY: 0,
  originX: 0,
  originY: 0,
})

function onHeaderPointerDown(e: PointerEvent) {
  // Avoid starting drag when clicking control buttons inside the header.
  const target = e.target as HTMLElement | null
  if (target?.closest?.('[data-no-drag="true"]'))
    return
  if (e.button !== 0)
    return
  drag.dragging = true
  drag.startX = e.clientX
  drag.startY = e.clientY
  drag.originX = state.position.x
  drag.originY = state.position.y
  ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)

  // Notify desktop click-through controller that we are dragging.
  voiceTrace.emit(voiceTraceOverlayDragEvent, { originId: 'overlay', at: Date.now(), dragging: true })
}

function onPointerMove(e: PointerEvent) {
  if (!drag.dragging)
    return
  const dx = e.clientX - drag.startX
  const dy = e.clientY - drag.startY
  state.position.x = Math.max(8, drag.originX + dx)
  state.position.y = Math.max(8, drag.originY + dy)
}

function onPointerUp() {
  if (drag.dragging) {
    drag.dragging = false
    voiceTrace.emit(voiceTraceOverlayDragEvent, { originId: 'overlay', at: Date.now(), dragging: false })
  }
}

const panelStyle = computed(() => {
  return {
    left: `${state.position.x}px`,
    top: `${state.position.y}px`,
    backgroundColor: `rgba(10, 10, 12, ${state.opacity})`,
    fontSize: `${Math.round(14 * state.fontScale)}px`,
  }
})

const inputBars = computed(() => {
  const values = inputHistory.buf.value
  const want = 48
  const pad = Math.max(0, want - values.length)
  return [...Array.from({ length: pad }).map(() => 0), ...values].slice(-want)
})

const outputBars = computed(() => {
  const values = outputHistory.buf.value
  const want = 48
  const pad = Math.max(0, want - values.length)
  return [...Array.from({ length: pad }).map(() => 0), ...values].slice(-want)
})

const llmLatencyMs = computed(() => {
  if (!llmStartedAt.value)
    return null
  return Date.now() - llmStartedAt.value
})

onMounted(() => {
  loadState()
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
})

onUnmounted(() => {
  stopMicMonitoring()
  voiceTraceDisposers.forEach(dispose => dispose?.())
  speechBusDisposers.forEach(dispose => dispose?.())
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})
</script>

<template>
  <!-- Teleport to body so the overlay is not clipped by the stage container (overflow/transform). -->
  <Teleport to="body">
    <div
      id="airi-voice-trace-overlay"
      :style="panelStyle"
      :class="[
        'fixed z-9999',
        'w-[420px] max-w-[92vw]',
        'max-h-[85vh]',
        'overflow-hidden',
        'flex flex-col',
        'rounded-2xl',
        'b b-white/10',
        'shadow-xl shadow-black/40',
        'backdrop-blur-md',
        'text-white',
        'select-none',
      ]"
    >
      <div
        :class="[
          'flex items-center justify-between gap-2',
          'px-3 py-2',
          'rounded-t-2xl',
          'b-b b-white/10',
          'cursor-move',
        ]"
        @pointerdown="onHeaderPointerDown"
      >
        <div class="flex items-center gap-2">
          <div class="h-2 w-2 rounded-full bg-green-400" />
          <div class="font-600">
            Voice Trace Overlay
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            :class="[
              'h-7 w-7',
              'rounded-lg',
              'b b-white/15',
              'hover:bg-white/10',
              'flex items-center justify-center',
            ]"
            data-no-drag="true"
            title="Minimize"
            @pointerdown.stop
            @click.stop="state.minimized = !state.minimized"
          >
            <div :class="[state.minimized ? 'i-solar:alt-arrow-down-line-duotone' : 'i-solar:alt-arrow-up-line-duotone']" />
          </button>
        </div>
      </div>

      <div v-if="!state.minimized" class="min-h-0 flex-1 select-text overflow-auto px-3 py-3">
        <div :class="['grid gap-3', 'grid-cols-1', 'min-w-0']">
          <div :class="['rounded-xl b b-white/10', 'p-3', 'bg-white/5']">
            <div class="flex items-center justify-between gap-2">
              <div class="min-w-0 text-sm font-600">
                舞台链路状态（是否真的在跑 STT）
              </div>
              <div class="shrink-0 text-xs text-white/70">
                stageMicEnabled: {{ stageMicEnabled ? 'true' : 'false' }}
              </div>
            </div>
            <div class="grid mt-2 gap-2 text-xs text-white/70">
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1">
                  STT provider/model：
                  <span class="break-all text-white/90">{{ sttProviderId || '(empty)' }}</span>
                  /
                  <span class="break-all text-white/90">{{ sttModelId || '(empty)' }}</span>
                </div>
                <Button class="shrink-0" size="sm" variant="secondary" @click="enableStageMic">
                  一键启用舞台麦克风
                </Button>
              </div>
              <div v-if="!stageMicEnabled" class="text-amber-200/90">
                提示：当前舞台麦克风未启用（enabled=false），所以 VAD/STT 不会触发，字幕必然为空。
              </div>
              <div v-else-if="!sttProviderId || !sttModelId" class="text-amber-200/90">
                提示：STT provider/model 为空，舞台即使录音也无法转写。请先在设置里选择 Hearing 的转写 provider 与模型。
              </div>
              <div class="flex items-center justify-between gap-3">
                <div class="shrink-0">
                  发声语速：{{ (Math.round((speechRate || 1) * 100) / 100).toFixed(2) }}x
                </div>
                <FieldRange
                  v-model="speechRate"
                  class="min-w-0 flex-1"
                  :min="0.8"
                  :max="1.5"
                  :step="0.05"
                />
              </div>
            </div>
          </div>

          <div :class="['rounded-xl b b-white/10', 'p-3', 'bg-white/5']">
            <div class="flex items-center justify-between gap-2">
              <div class="text-sm font-600">
                1) 麦克风输入（音量/波形）
              </div>
              <div class="flex items-center gap-2">
                <Button size="sm" variant="ghost" @click="askPermission()">
                  申请权限
                </Button>
                <Button
                  size="sm"
                  :variant="micMonitoring ? 'primary' : 'secondary'"
                  @click="micMonitoring ? stopMicMonitoring() : startMicMonitoring()"
                >
                  {{ micMonitoring ? '停止监测' : '开始监测' }}
                </Button>
              </div>
            </div>

            <div class="mt-2 flex items-center gap-3">
              <div class="text-xs text-white/70">
                Level: {{ Math.round(inputVolumeLevel) }}%
              </div>
              <div class="h-10 flex flex-1 items-end gap-[2px]">
                <div
                  v-for="(v, i) in inputBars"
                  :key="i"
                  :style="{ height: `${Math.max(2, Math.round(v * 100))}%` }"
                  :class="[
                    'w-[6px]',
                    'rounded-sm',
                    'bg-gradient-to-t',
                    v > 0.6 ? 'from-green-500/80 to-green-200/90' : 'from-white/20 to-white/60',
                  ]"
                />
              </div>
            </div>
          </div>

          <div :class="['rounded-xl b b-white/10', 'p-3', 'bg-white/5']">
            <div class="text-sm font-600">
              2) 输入文本（STT/字幕）
            </div>
            <div class="mt-1 text-xs text-white/60">
              debug: sttTextLen={{ sttText.length }} · lastCaption={{ lastCaption ? `${lastCaption.type}/${lastCaption.len}` : '(none)' }}
            </div>
            <div class="mt-2 max-h-28 min-w-0 overflow-auto whitespace-pre-wrap break-words text-sm text-white/90">
              {{ sttText || '（等待语音输入…）' }}
            </div>
          </div>

          <div :class="['rounded-xl b b-white/10', 'p-3', 'bg-white/5']">
            <div class="flex items-center justify-between gap-2">
              <div class="text-sm font-600">
                3) 模型调用与输出（LLM）
              </div>
              <div class="max-w-[55%] min-w-0 truncate text-right text-xs text-white/70">
                {{ lastModelCall.provider }} / {{ lastModelCall.model }}
              </div>
            </div>
            <div class="mt-2 flex items-center gap-2 text-xs text-white/70">
              <div>
                状态：{{ llmStatus }}
              </div>
              <div v-if="llmLatencyMs != null">
                · 已用时：{{ llmLatencyMs }}ms
              </div>
              <div>
                · token(chars)：{{ llmTokenCount }}
              </div>
            </div>
            <div v-if="llmStatus === 'error'" class="mt-2 whitespace-pre-wrap break-words text-sm text-red-300">
              {{ llmError || 'Unknown error' }}
            </div>
            <div class="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words text-sm text-white/90">
              {{ llmOutput || '（等待模型输出…）' }}
            </div>
          </div>

          <div :class="['rounded-xl b b-white/10', 'p-3', 'bg-white/5']">
            <div class="flex items-center justify-between gap-2">
              <div class="text-sm font-600">
                4) 语音输出（强度/波形代理）
              </div>
              <div class="text-xs text-white/70">
                outputLevel: {{ outputLevel.toFixed(3) }}
              </div>
            </div>

            <div class="mt-2 flex items-center gap-3">
              <div class="text-xs text-white/70">
                Level: {{ Math.round(outputLevel * 100) }}%
              </div>
              <div class="h-10 flex flex-1 items-end gap-[2px]">
                <div
                  v-for="(v, i) in outputBars"
                  :key="i"
                  :style="{ height: `${Math.max(2, Math.round(v * 100))}%` }"
                  :class="[
                    'w-[6px]',
                    'rounded-sm',
                    'bg-gradient-to-t',
                    v > 0.45 ? 'from-sky-500/80 to-sky-200/90' : 'from-white/20 to-white/60',
                  ]"
                />
              </div>
            </div>

            <div v-if="state.showSpeechEvents" class="mt-3">
              <div class="flex items-center justify-between">
                <div class="text-xs text-white/80 font-600">
                  TTS/Speech Bus 事件（用于确认文本→语音链路在跑）
                </div>
                <div class="text-[11px] text-white/60">
                  最近 {{ speechEvents.length }} 条
                </div>
              </div>
              <div class="mt-2 max-h-28 overflow-auto text-[12px] text-white/80 leading-relaxed space-y-1">
                <div v-for="(e, idx) in speechEvents" :key="idx" class="flex gap-2">
                  <div class="w-20 shrink-0 text-white/50">
                    {{ new Date(e.at).toLocaleTimeString() }}
                  </div>
                  <div class="w-28 shrink-0 text-white/70">
                    {{ e.type }}
                  </div>
                  <div class="min-w-0 break-words">
                    {{ e.detail }}
                  </div>
                </div>
                <div v-if="speechEvents.length === 0" class="text-white/50">
                  （等待语音输出事件…）
                </div>
              </div>
            </div>
          </div>
        </div>

        <div :class="['rounded-xl b b-white/10', 'p-3', 'bg-white/5']">
          <div class="text-sm font-600">
            5) 窗口设置
          </div>
          <div class="grid mt-3 gap-3">
            <FieldRange
              v-model="state.opacity"
              :min="0.15"
              :max="0.98"
              :step="0.01"
              label="背景透明度"
              layout="vertical"
              :format-value="(v: number) => `${Math.round(v * 100)}%`"
            />
            <FieldRange
              v-model="state.fontScale"
              :min="0.85"
              :max="1.25"
              :step="0.01"
              label="字体缩放"
              layout="vertical"
              :format-value="(v: number) => `${Math.round(v * 100)}%`"
            />
            <div class="grid gap-2 md:grid-cols-2">
              <FieldCheckbox
                v-model="state.showSpeechEvents"
                label="显示 TTS/Speech Bus 事件"
                description="用于确认文本→语音链路事件在跑"
              />
              <FieldCheckbox
                v-model="state.showRaw"
                label="显示 Raw（调试）"
                description="展示一些内部状态（仅调试用）"
              />
            </div>
            <div v-if="state.showRaw" class="whitespace-pre-wrap break-words text-xs text-white/70">
              {{ safeJson({ micMonitoring, inputVolumeLevel, outputLevel, lastModelCall }) }}
            </div>
          </div>
        </div>
      </div>

      <div v-else class="px-3 py-2 text-xs text-white/80">
        已最小化：拖拽标题栏移动，点箭头展开。
      </div>
    </div>
  </Teleport>
</template>
