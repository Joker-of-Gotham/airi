<script setup lang="ts">
import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import {
  Alert,
  TranscriptionPlayground,
  TranscriptionProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'

const hearingStore = useHearingStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)

const providerId = 'voice-clone-stack-transcription'
const defaultModel = 'whisper-base'
const syncedProviderId = 'voice-clone-stack'

// Local service usually doesn't require API key; keep playground usable by default.
const apiKeyConfigured = computed(() => true)

function normalizeBaseUrl(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw)
    return ''
  return raw.endsWith('/') ? raw : `${raw}/`
}

const syncedBaseUrl = computed(() => {
  return normalizeBaseUrl(providers.value[syncedProviderId]?.baseUrl)
    || (providersStore.getProviderMetadata(providerId)?.defaultOptions?.().baseUrl as string | undefined)
    || 'http://localhost:8000/'
})

function syncBaseUrlToVcsTts() {
  if (!providers.value[providerId])
    providers.value[providerId] = {}
  providers.value[providerId].baseUrl = syncedBaseUrl.value
}

onMounted(() => {
  // Make STT baseUrl follow the same VCS baseUrl as TTS to avoid mismatch/mistyping.
  syncBaseUrlToVcsTts()
})

watch(() => providers.value[syncedProviderId]?.baseUrl, () => {
  syncBaseUrlToVcsTts()
})

async function handleGenerateTranscription(
  file: File,
  options?: { language?: string, responseFormat?: 'json' | 'verbose_json' | 'text' },
) {
  const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, any>>(providerId)
  if (!provider)
    throw new Error('Failed to initialize transcription provider')

  const providerConfig = providersStore.getProviderConfig(providerId)
  const model = (providerConfig.model as string | undefined) || defaultModel

  return await hearingStore.transcription(
    providerId,
    provider,
    model,
    file,
    options?.responseFormat || 'json',
    {
      language: options?.language,
    },
  )
}
</script>

<template>
  <TranscriptionProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
    placeholder="（可选）本地服务一般不需要 API Key"
  >
    <template #playground>
      <Alert type="info">
        <template #title>
          本地语音转文本（Voice Clone Stack）
        </template>
        <template #content>
          <div class="whitespace-pre-wrap break-words">
            该转写 Provider 会自动跟随「Voice Clone Stack（TTS）」的 Base URL：
            <div class="mt-1">
              <code class="break-all">{{ syncedBaseUrl }}</code>
            </div>

            需要提供的端点：
            <div class="mt-1 space-y-1">
              <div><code class="break-all">GET {{ syncedBaseUrl }}health</code></div>
              <div><code class="break-all">GET {{ syncedBaseUrl }}api/stt/models</code></div>
              <div><code class="break-all">POST {{ syncedBaseUrl }}audio/transcriptions</code></div>
            </div>
          </div>
        </template>
      </Alert>

      <TranscriptionPlayground
        :generate-transcription="handleGenerateTranscription"
        :api-key-configured="apiKeyConfigured"
      />
    </template>
  </TranscriptionProviderSettings>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
