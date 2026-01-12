import { defineEventa } from '@moeru/eventa'
import { createContext as createBroadcastChannelContext } from '@moeru/eventa/adapters/broadcast-channel'

const BUS_CHANNEL_NAME = 'proj-airi:devtools:voice-trace'

let context: ReturnType<typeof createBroadcastChannelContext>['context'] | undefined
let channel: BroadcastChannel | undefined

function getChannel() {
  if (!channel)
    channel = new BroadcastChannel(BUS_CHANNEL_NAME)
  return channel
}

export function getVoiceTraceBusContext() {
  if (!context)
    context = createBroadcastChannelContext(getChannel()).context
  return context
}

export interface VoiceTraceLlmMeta {
  providerId?: string
  model?: string
  source?: 'voice' | 'text' | 'unknown'
}

export interface VoiceTraceLlmStartPayload {
  originId: string
  at: number
  meta?: VoiceTraceLlmMeta
}

export interface VoiceTraceLlmDeltaPayload {
  originId: string
  at: number
  delta: string
}

export interface VoiceTraceLlmEndPayload {
  originId: string
  at: number
}

export interface VoiceTraceOutputLevelPayload {
  originId: string
  at: number
  /**
   * 0..1 normalized level. In Stage we use mouthOpenSize as a proxy amplitude.
   */
  level: number
}

export interface VoiceTraceOverlayDragPayload {
  originId: string
  at: number
  dragging: boolean
}

export const voiceTraceLlmStartEvent = defineEventa<VoiceTraceLlmStartPayload>('eventa:devtools:voice-trace:llm:start')
export const voiceTraceLlmDeltaEvent = defineEventa<VoiceTraceLlmDeltaPayload>('eventa:devtools:voice-trace:llm:delta')
export const voiceTraceLlmEndEvent = defineEventa<VoiceTraceLlmEndPayload>('eventa:devtools:voice-trace:llm:end')
export const voiceTraceOutputLevelEvent = defineEventa<VoiceTraceOutputLevelPayload>('eventa:devtools:voice-trace:output:level')
export const voiceTraceOverlayDragEvent = defineEventa<VoiceTraceOverlayDragPayload>('eventa:devtools:voice-trace:overlay:drag')
