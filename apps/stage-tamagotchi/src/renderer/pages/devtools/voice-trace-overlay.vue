<script setup lang="ts">
import VoiceTraceOverlay from '@proj-airi/stage-ui/components/devtools/voice-trace-overlay.vue'
</script>

<template>
  <div class="relative min-h-[100dvh]">
    <div class="p-4 text-sm text-neutral-500 dark:text-neutral-400">
      Voice Trace Overlay（用于端到端语音链路可视化）。可与主舞台窗口并行打开，通过 BroadcastChannel 同步字幕与语音事件。
    </div>
    <VoiceTraceOverlay />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
