import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { useAudioDevice } from '../../composables/audio'

export const useSettingsAudioDevice = defineStore('settings-audio-devices', () => {
  const { audioInputs, deviceConstraints, selectedAudioInput: selectedAudioInputNonPersist, startStream, stopStream, stream, askPermission } = useAudioDevice()

  const selectedAudioInputPersist = useLocalStorageManualReset<string>('settings/audio/input', selectedAudioInputNonPersist.value)
  const selectedAudioInputEnabledPersist = useLocalStorageManualReset<boolean>('settings/audio/input/enabled', false)

  watch(selectedAudioInputPersist, (newValue) => {
    selectedAudioInputNonPersist.value = newValue
  })

  watch(selectedAudioInputEnabledPersist, (val) => {
    if (val) {
      startStream()
    }
    else {
      stopStream()
    }
  }, { immediate: true })

  const requestedPermissionOnce = ref(false)
  watch([selectedAudioInputEnabledPersist, audioInputs, selectedAudioInputPersist], ([enabled, inputs, selected]) => {
    if (!enabled)
      return

    if (inputs.length === 0) {
      if (!requestedPermissionOnce.value) {
        requestedPermissionOnce.value = true
        askPermission()
      }
      return
    }

    const hasSelectedInList = !!selected && inputs.some(device => device.deviceId === selected)
    if (!hasSelectedInList) {
      selectedAudioInputPersist.value = inputs.find(device => device.deviceId === 'default')?.deviceId ?? inputs[0].deviceId
    }

    startStream()
  }, { immediate: true })

  function initialize() {
    const hasSelectedInput = selectedAudioInputPersist.value
      && audioInputs.value.some(device => device.deviceId === selectedAudioInputPersist.value)

    if (selectedAudioInputEnabledPersist.value && hasSelectedInput) {
      startStream()
    }
    if (selectedAudioInputNonPersist.value && !selectedAudioInputEnabledPersist.value) {
      selectedAudioInputPersist.value = selectedAudioInputNonPersist.value
    }
  }

  function resetState() {
    selectedAudioInputPersist.reset()
    selectedAudioInputNonPersist.value = ''
    selectedAudioInputEnabledPersist.reset()
    requestedPermissionOnce.value = false
    stopStream()
  }

  return {
    audioInputs,
    deviceConstraints,
    selectedAudioInput: selectedAudioInputPersist,
    enabled: selectedAudioInputEnabledPersist,

    stream,

    initialize,

    askPermission,
    startStream,
    stopStream,
    resetState,
  }
})
