<script setup lang="ts">
import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { PageHeader } from '@proj-airi/stage-ui/components'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute } from 'vue-router'

import WindowTitleBar from '../components/Window/TitleBar.vue'

import { useRestoreScroll } from '../composables/use-restore-scroll'

const route = useRoute()
const { t } = useI18n()
const providersStore = useProvidersStore()
const scrollContainer = ref<HTMLElement>()
useRestoreScroll(scrollContainer)

const routeMeta = computed(() => route.meta as {
  titleKey?: string
  subtitleKey?: string
  title?: string
  subtitle?: string
})

const routeHeaderMetadataMap = computed(() => {
  const map: Record<string, { subtitle?: string, title: string }> = {
    '/settings/airi-card': {
      subtitle: t('settings.title'),
      title: t('settings.pages.card.title'),
    },
    '/settings/system': {
      subtitle: t('settings.title'),
      title: t('settings.pages.system.title'),
    },
    '/settings/system/general': {
      subtitle: t('settings.title'),
      title: t('settings.pages.system.general.title'),
    },
    '/settings/system/color-scheme': {
      subtitle: t('settings.title'),
      title: t('settings.pages.system.color-scheme.title'),
    },
    '/settings/system/window-shortcuts': {
      subtitle: t('settings.title'),
      title: t('tamagotchi.settings.pages.system.window-shortcuts.title'),
    },
    '/settings/system/developer': {
      subtitle: t('settings.title'),
      title: t('settings.pages.system.developer.title'),
    },
    '/settings/memory': {
      subtitle: t('settings.title'),
      title: t('settings.pages.memory.title'),
    },
    '/settings/models': {
      subtitle: t('settings.title'),
      title: t('settings.pages.models.title'),
    },
    '/settings/modules': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.title'),
    },
    '/settings/modules/consciousness': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.consciousness.title'),
    },
    '/settings/modules/speech': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.speech.title'),
    },
    '/settings/modules/hearing': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.hearing.title'),
    },
    '/settings/modules/memory-short-term': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.memory-short-term.title'),
    },
    '/settings/modules/memory-long-term': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.memory-long-term.title'),
    },
    '/settings/modules/messaging-discord': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.messaging-discord.title'),
    },
    '/settings/modules/x': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.x.title'),
    },
    '/settings/modules/gaming-minecraft': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.gaming-minecraft.title'),
    },
    '/settings/modules/gaming-factorio': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.gaming-factorio.title'),
    },
    '/settings/modules/beat-sync': {
      subtitle: t('settings.title'),
      title: t('settings.pages.modules.beat_sync.title'),
    },
    '/settings/providers': {
      subtitle: t('settings.title'),
      title: t('settings.pages.providers.title'),
    },
    '/settings/data': {
      subtitle: t('settings.title'),
      title: t('settings.pages.data.title'),
    },
    '/settings/connection': {
      subtitle: t('settings.title'),
      title: t('settings.pages.connection.title'),
    },
    '/settings/scene': {
      subtitle: t('settings.title'),
      title: t('settings.pages.scene.title'),
    },
    '/settings': {
      title: t('settings.title'),
    },
  }

  return map
})

const providerTitle = computed(() => {
  if (!route.path.startsWith('/settings/providers/'))
    return undefined

  const segments = route.path.split('/').filter(Boolean)
  const providerId = segments[3]

  if (!providerId)
    return undefined

  try {
    const metadata = providersStore.getProviderMetadata(providerId)
    return t(metadata.nameKey)
  }
  catch {
    return undefined
  }
})

// const activeSettingsTutorial = ref('default')
const routeHeaderMetadata = computed(() => {
  const { titleKey, subtitleKey, title, subtitle } = routeMeta.value
  const resolvedTitle = titleKey ? t(titleKey) : title
  const resolvedSubtitle = subtitleKey ? t(subtitleKey) : subtitle

  if (resolvedTitle || resolvedSubtitle) {
    return {
      title: resolvedTitle,
      subtitle: resolvedSubtitle,
    }
  }

  if (providerTitle.value) {
    return {
      title: providerTitle.value,
      subtitle: t('settings.title'),
    }
  }

  const mapEntry = routeHeaderMetadataMap.value[route.path]
  if (mapEntry)
    return mapEntry

  return undefined
})
</script>

<template>
  <div h-full w-full bg="$bg-color" flex="~ col">
    <WindowTitleBar :title="routeHeaderMetadata?.title ?? ''" icon="i-solar:settings-bold" />
    <div
      :style="{
        paddingTop: `44px`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
      }"

      min-h-0 flex-1
    >
      <div ref="scrollContainer" relative h-full w-full overflow-y-auto scrollbar-none>
        <div flex="~ col" mx-auto h-full max-w-screen-xl>
          <PageHeader
            :title="routeHeaderMetadata?.title ?? ''"
            :subtitle="routeHeaderMetadata?.subtitle ?? ''"
            :disable-back-button="isStageTamagotchi() && route.path === '/settings'"
            px-4
          />
          <div min-h-0 flex-1 px-4>
            <RouterView />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
