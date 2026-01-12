<script setup lang="ts">
import type { HearingTranscriptionResult } from '../../../stores/modules/hearing'

import { Button, FieldRange, FieldSelect } from '@proj-airi/ui'
import { until } from '@vueuse/core'
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAudioAnalyzer } from '../../../composables/audio/audio-analyzer'
import { useAudioRecorder } from '../../../composables/audio/audio-recorder'
import { useAudioDevice } from '../../../composables/audio/device'
import { LevelMeter, TestDummyMarker, ThresholdMeter } from '../../gadgets'

const props = defineProps<{
  // Provider-specific handlers (provided from parent)
  generateTranscription: (input: File, options?: { language?: string, responseFormat?: 'json' | 'verbose_json' | 'text' }) => Promise<HearingTranscriptionResult>
  // Current state
  apiKeyConfigured?: boolean
}>()

const { t } = useI18n()
const { audioInputs, selectedAudioInput, stream, stopStream, startStream } = useAudioDevice()
const { volumeLevel, stopAnalyzer, startAnalyzer } = useAudioAnalyzer()
const { startRecord, stopRecord, onStopRecord } = useAudioRecorder(stream)

const speakingThreshold = ref(25) // 0-100 (for volume-based fallback)
const isMonitoring = ref(false)
const isSpeaking = ref(false)

const errorMessage = ref<string>('')

const audioContext = shallowRef<AudioContext>()
const dataArray = ref<Uint8Array<ArrayBuffer>>()
const animationFrame = ref<number>()

// Keep only ONE latest recording + transcription in the playground (no history list)
const audioBlob = shallowRef<Blob>()
const audioUrl = ref<string>('')
const transcriptionText = ref<string>('')

watch(audioBlob, (blob, _old, onCleanup) => {
  if (audioUrl.value) {
    URL.revokeObjectURL(audioUrl.value)
    audioUrl.value = ''
  }
  if (!blob)
    return
  const url = URL.createObjectURL(blob)
  audioUrl.value = url
  onCleanup(() => URL.revokeObjectURL(url))
})

const selectedLanguage = ref<'auto' | 'zh' | 'en' | 'ja'>('auto')
const responseFormat = ref<'json' | 'verbose_json' | 'text'>('json')

watch(selectedAudioInput, async () => {
  if (isMonitoring.value) {
    await setupAudioMonitoring()
  }
})

watch(audioInputs, () => {
  if (!selectedAudioInput.value && audioInputs.value.length > 0) {
    selectedAudioInput.value = audioInputs.value.find(input => input.deviceId === 'default')?.deviceId || audioInputs.value[0].deviceId
  }
})

async function setupAudioMonitoring() {
  try {
    await stopAudioMonitoring()

    await startStream()
    await until(stream).toBeTruthy()

    // Create audio context
    audioContext.value = new AudioContext()
    const source = audioContext.value.createMediaStreamSource(stream.value!)
    const analyzer = startAnalyzer(audioContext.value)
    source.connect(analyzer!)

    // Set up data array for analysis
    const bufferLength = analyzer!.frequencyBinCount
    dataArray.value = new Uint8Array(bufferLength)
  }
  catch (error) {
    console.error('Error setting up audio monitoring:', error)
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function stopAudioMonitoring() {
  // Stop animation frame
  if (animationFrame.value) {
    cancelAnimationFrame(animationFrame.value)
    animationFrame.value = undefined
  }
  if (stream.value) {
    stream.value.getTracks().forEach(track => track.stop())
    stream.value = undefined
  }
  if (audioContext.value) {
    await audioContext.value.close()
    audioContext.value = undefined
  }

  await stopRecord()
  await stopStream()
  await stopAnalyzer()

  dataArray.value = undefined
  isSpeaking.value = false
}

onStopRecord(async (recording) => {
  try {
    if (recording && recording.size > 0) {
      audioBlob.value = recording
      const result = await props.generateTranscription(
        new File([recording], 'recording.wav'),
        {
          language: selectedLanguage.value === 'auto' ? 'auto' : selectedLanguage.value,
          responseFormat: responseFormat.value,
        },
      )
      const text = result.mode === 'stream'
        ? await result.text
        : result.text
      transcriptionText.value = text
    }
  }
  catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
    console.error('Error generating transcription:', errorMessage.value)
  }
})

// Monitoring toggle
async function toggleMonitoring() {
  if (!isMonitoring.value) {
    await setupAudioMonitoring()
    await startRecord()
    isMonitoring.value = true
  }
  else {
    // stopAudioMonitoring already calls stopRecord internally
    await stopAudioMonitoring()
    isMonitoring.value = false
  }
}

// Speaking indicator with enhanced VAD visualization
const speakingIndicatorClass = computed(() => {
  // Volume-based: simple green/white
  return isSpeaking.value
    ? 'bg-green-500 shadow-lg shadow-green-500/50'
    : 'bg-white dark:bg-neutral-900 border-2 border-neutral-300 dark:border-neutral-600'
})

onUnmounted(() => {
  stopAudioMonitoring()
  if (audioUrl.value) {
    URL.revokeObjectURL(audioUrl.value)
    audioUrl.value = ''
  }
})
</script>

<template>
  <div w-full pt-1>
    <h2 class="mb-4 text-lg text-neutral-500 md:text-2xl dark:text-neutral-400" w-full>
      <div class="inline-flex items-center gap-4">
        <TestDummyMarker />
        <div>
          {{ t('settings.pages.providers.provider.transcriptions.playground.title') }}
        </div>
      </div>
    </h2>

    <div mb-2 grid="~ cols-1 md:cols-2 gap-3">
      <FieldSelect
        v-model="selectedLanguage"
        :label="t('settings.pages.providers.provider.transcriptions.playground.language.label')"
        :description="t('settings.pages.providers.provider.transcriptions.playground.language.description')"
        :options="[
          { label: t('settings.pages.providers.provider.transcriptions.playground.language.options.auto'), value: 'auto' },
          { label: t('settings.pages.providers.provider.transcriptions.playground.language.options.zh'), value: 'zh' },
          { label: t('settings.pages.providers.provider.transcriptions.playground.language.options.en'), value: 'en' },
          { label: t('settings.pages.providers.provider.transcriptions.playground.language.options.ja'), value: 'ja' },
        ]"
        layout="vertical"
        h-fit w-full
      />
      <FieldSelect
        v-model="responseFormat"
        :label="t('settings.pages.providers.provider.transcriptions.playground.response_format.label')"
        :description="t('settings.pages.providers.provider.transcriptions.playground.response_format.description')"
        :options="[
          { label: t('settings.pages.providers.provider.transcriptions.playground.response_format.options.json'), value: 'json' },
          { label: t('settings.pages.providers.provider.transcriptions.playground.response_format.options.verbose_json'), value: 'verbose_json' },
          { label: t('settings.pages.providers.provider.transcriptions.playground.response_format.options.text'), value: 'text' },
        ]"
        layout="vertical"
        h-fit w-full
      />
    </div>

    <!-- Audio Input Selection -->
    <div mb-2>
      <FieldSelect
        v-model="selectedAudioInput"
        :label="t('settings.pages.providers.provider.transcriptions.playground.audio_input_device.label')"
        :description="t('settings.pages.providers.provider.transcriptions.playground.audio_input_device.description')"
        :options="audioInputs.map(input => ({
          label: input.label || input.deviceId,
          value: input.deviceId,
        }))"
        :placeholder="t('settings.pages.providers.provider.transcriptions.playground.audio_input_device.placeholder')"
        layout="vertical"
        h-fit w-full
      />
    </div>

    <Button class="my-4" w-full @click="toggleMonitoring">
      {{ isMonitoring ? 'Stop Monitoring' : 'Start Monitoring' }}
    </Button>

    <div>
      <audio v-if="audioUrl" :src="audioUrl" controls class="mb-2 w-full" />
      <div v-if="transcriptionText" class="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        {{ transcriptionText }}
      </div>
    </div>

    <!-- Audio Level Visualization -->
    <div class="space-y-3">
      <!-- Volume Meter -->
      <LevelMeter :level="volumeLevel" label="Input Level" />

      <!-- VAD Probability Meter (when VAD model is active) -->
      <ThresholdMeter
        :value="volumeLevel / 100"
        :threshold="speakingThreshold / 100"
        label="Probability of Speech"
        below-label="Silence"
        above-label="Speech"
        threshold-label="Detection threshold"
      />

      <div class="space-y-3">
        <FieldRange
          v-model="speakingThreshold"
          label="Sensitivity"
          description="Adjust the threshold for speech detection"
          :min="1"
          :max="80"
          :step="1"
          :format-value="value => `${value}%`"
        />
      </div>

      <!-- Speaking Indicator -->
      <div class="flex items-center gap-3">
        <div
          class="h-4 w-4 rounded-full transition-all duration-200"
          :class="speakingIndicatorClass"
        />
        <span class="text-sm font-medium">
          {{ isSpeaking ? 'Speaking Detected' : 'Silence' }}
        </span>
      </div>
    </div>
  </div>
</template>
