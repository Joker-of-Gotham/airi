<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import {
  Alert,
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { computed, onMounted, watch } from 'vue'

const providerId = 'voice-clone-stack'
const defaultModel = 'indextts2'

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()

// Local service usually doesn't require API key; keep playground usable by default.
const apiKeyConfigured = true

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] || []
})

onMounted(async () => {
  await speechStore.loadVoicesForProvider(providerId)
})

watch(
  () => providersStore.configuredProviders[providerId],
  async (configured) => {
    if (configured)
      await speechStore.loadVoicesForProvider(providerId)
  },
  { immediate: true },
)

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance<SpeechProvider>(providerId)
  if (!provider)
    throw new Error('Failed to initialize speech provider')

  const providerConfig = providersStore.getProviderConfig(providerId)
  const model = (providerConfig.model as string | undefined) || defaultModel

  return await speechStore.speech(
    provider,
    model,
    input,
    voiceId,
    {
      ...providerConfig,
      // Ensure VCS receives wav output (server contract only allows wav).
      responseFormat: 'wav',
    },
  )
}
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
    placeholder="（可选）本地服务一般不需要 API Key"
  >
    <template #playground>
      <Alert type="info">
        <template #title>
          本地语音服务（Voice Clone Stack）
        </template>
        <template #content>
          <div class="whitespace-pre-wrap break-words">
            请先启动你的本地语音服务，并确保提供：GET /health、GET /models、GET /audio/voices、POST /audio/speech。
            Base URL 示例：http://localhost:8000/
          </div>
        </template>
      </Alert>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        default-text="你好，这是 AIRI 的语音测试。"
      />
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
