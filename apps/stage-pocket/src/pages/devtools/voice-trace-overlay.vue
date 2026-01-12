<script setup lang="ts">
import VoiceTraceOverlay from '@proj-airi/stage-ui/components/devtools/voice-trace-overlay.vue'
</script>

<template>
  <div class="relative min-h-[100dvh]">
    <div class="p-4 text-sm text-neutral-500 dark:text-neutral-400">
      Voice Trace Overlay（用于端到端语音链路可视化）。
    </div>
    <VoiceTraceOverlay />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
