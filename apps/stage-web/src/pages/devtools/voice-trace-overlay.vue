<script setup lang="ts">
import VoiceTraceOverlay from '@proj-airi/stage-ui/components/devtools/voice-trace-overlay.vue'
</script>

<template>
  <div class="relative min-h-[100dvh]">
    <div class="p-4 text-sm text-neutral-500 dark:text-neutral-400">
      打开麦克风并在另一窗口/标签页运行对话后，本页会通过 BroadcastChannel/Eventa 显示端到端链路状态。
    </div>
    <VoiceTraceOverlay />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
