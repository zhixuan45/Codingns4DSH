import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsCliAdapterDescriptor, CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'
import type { FeaturePanelProps } from './types.js'
import { findModel, errorMessage } from '../cli-catalog.js'
import { clearCliAdapterDefaults, compatibleEffort, mergeCustomModelCatalog, parseCustomModelIds, saveCliAdapterDefaults, scanCliAdapterModels } from '../cli-adapter-defaults.js'
import { dshFieldStyle, dshSettingsButtonStyle, dshSettingsHelpStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

interface Props {
  readonly adapter: CodingNsCliAdapterDescriptor
  readonly services: FeaturePanelProps['services']
  readonly snapshot: FeaturePanelProps['snapshot']
  readonly notify: FeaturePanelProps['notify']
}

/** 固定默认与目录草稿独立于会话最近选择。 */
export function CliAdapterDefaultsPanel({ adapter, services, snapshot, notify }: Props): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const persisted = snapshot.value?.agentAdapterDefaults?.[adapter.id]
  const [modelId, setModelId] = useState(() => persisted?.modelId ?? '')
  const [effortId, setEffortId] = useState(() => persisted?.effortId ?? '')
  const [customModelText, setCustomModelText] = useState(() => persisted?.customModelIds?.join('\n') ?? '')
  const [catalog, setCatalog] = useState<CodingNsCliModelCatalog | null>(null)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [scanError, setScanError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  const [cleared, setCleared] = useState(false)
  const scanRevision = useRef(0)
  const mounted = useRef(true)
  const modelIdRef = useRef(modelId)
  modelIdRef.current = modelId
  const hydrated = useRef(snapshot.status === 'ready')
  const canScan = adapter.installed && adapter.enabled
  const writable = snapshot.status === 'ready' && snapshot.writable
  const merged = mergeCustomModelCatalog(catalog, parseCustomModelIds(customModelText), t('cli.customModels'))
  const selectedModel = findModel(merged, modelId.trim())
  const efforts = selectedModel?.efforts ?? []

  const scan = async (refresh: boolean): Promise<void> => {
    const revision = ++scanRevision.current
    setScanning(true)
    setScanError('')
    try {
      const next = await scanCliAdapterModels(services.rpc, adapter.id, refresh)
      if (!mounted.current || revision !== scanRevision.current) return
      setCatalog(next)
      setScanError(next.scanError ?? '')
      setEffortId((current) => compatibleEffort(next, modelIdRef.current, current))
    } catch (error) {
      if (mounted.current && revision === scanRevision.current) setScanError(errorMessage(error))
    } finally {
      if (mounted.current && revision === scanRevision.current) setScanning(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    if (canScan) void scan(false)
    return () => { mounted.current = false; scanRevision.current += 1 }
  }, [services.rpc, adapter.id, canScan])

  useEffect(() => {
    if (hydrated.current || snapshot.status !== 'ready') return
    hydrated.current = true
    setModelId(persisted?.modelId ?? '')
    setEffortId(persisted?.effortId ?? '')
    setCustomModelText(persisted?.customModelIds?.join('\n') ?? '')
  }, [snapshot.status, persisted])

  const editModel = (value: string): void => {
    setModelId(value)
    setEffortId((current) => compatibleEffort(merged, value, current))
    setSaved(false)
    setCleared(false)
  }
  const save = async (clear = false): Promise<void> => {
    if (saving || !writable) return
    setSaving(true)
    setSaved(false)
    setSaveError('')
    try {
      const accepted = clear
        ? await clearCliAdapterDefaults(services.settings, adapter.id)
        : await saveCliAdapterDefaults(services.settings, adapter.id, { modelId, effortId, customModelText }, merged)
      if (!accepted) throw new Error(t('settings.moduleWriteRejected'))
      if (!mounted.current) return
      if (clear) { setModelId(''); setEffortId('') }
      else { setModelId(modelId.trim()); setEffortId(compatibleEffort(merged, modelId, effortId)) }
      setSaved(true)
      setCleared(clear)
      notify({ kind: 'success', message: t(clear ? 'cli.defaultsCleared' : 'cli.defaultsSaved') })
    } catch (error) {
      if (mounted.current) { setSaveError(errorMessage(error)); notify({ kind: 'error', message: errorMessage(error) }) }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return createElement('section', { style: { display: 'grid', gap: 10 } },
    createElement('h4', { style: { margin: 0 } }, t('cli.defaultsTitle')),
    createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('cli.defaultsHint')),
    createElement('label', { style: { display: 'grid', gap: 5 } }, t('cli.defaultModel'),
      createElement('input', {
        type: 'text', value: modelId, list: `codingns-models-${adapter.id}`, disabled: !writable || saving,
        'aria-label': t('cli.defaultModel'), placeholder: t('cli.manualModelPlaceholder'), style: { ...dshFieldStyle, width: '100%', boxSizing: 'border-box' },
        onChange: (event: { currentTarget: { value: string } }) => editModel(event.currentTarget.value),
      }),
      createElement('datalist', { id: `codingns-models-${adapter.id}` }, ...merged.groups.flatMap((group) => group.models.map((model) => createElement('option', { key: model.id, value: model.id }, model.name)))),
    ),
    efforts.length > 0 && createElement('label', { style: { display: 'grid', gap: 5 } }, t('cli.defaultThinking'),
      createElement('select', {
        value: efforts.includes(effortId) ? effortId : '', disabled: !writable || saving, 'aria-label': t('cli.defaultThinking'), style: dshFieldStyle,
        onChange: (event: { currentTarget: { value: string } }) => { setEffortId(event.currentTarget.value); setSaved(false) },
      }, createElement('option', { value: '' }, t('cli.followCliDefault')), ...efforts.map((effort) => createElement('option', { key: effort, value: effort }, effort))),
    ),
    createElement('label', { style: { display: 'grid', gap: 5 } }, t('cli.customModels'),
      createElement('textarea', {
        value: customModelText, rows: 4, disabled: !writable || saving, 'aria-label': t('cli.customModels'),
        placeholder: t('cli.customModelsPlaceholder'), style: { ...dshFieldStyle, resize: 'vertical', width: '100%', boxSizing: 'border-box' },
        onChange: (event: { currentTarget: { value: string } }) => { setCustomModelText(event.currentTarget.value); setSaved(false) },
      }),
    ),
    createElement('div', { style: dshSettingsHelpStyle }, t('cli.customModelsHint')),
    createElement('div', { style: dshSettingsHelpStyle }, t('cli.scanCatalogHint')),
    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      createElement('button', { type: 'button', disabled: !canScan || scanning, onClick: () => { void scan(true) }, style: dshSettingsButtonStyle }, t(scanning ? 'cli.scanningModels' : 'cli.scanModels')),
      createElement('button', { type: 'button', disabled: !writable || saving, onClick: () => { void save(true) }, style: dshSettingsButtonStyle }, t('cli.clearDefaults')),
      createElement('button', { type: 'button', disabled: !writable || saving, onClick: () => { void save() }, style: dshSettingsPrimaryButtonStyle }, t(saving ? 'cli.savingDefaults' : 'cli.saveDefaults')),
    ),
    !canScan && createElement('div', { style: dshSettingsHelpStyle }, t(adapter.installed ? 'cli.scanDisabled' : 'cli.scanNotInstalled')),
    scanError && createElement('div', { role: 'alert', style: { color: dshThemeColor.error } }, `${t('cli.scanFailed')} ${scanError}`),
    catalog?.scanNotice && createElement('div', { role: 'status', style: dshSettingsHelpStyle }, catalog.scanNotice),
    saveError && createElement('div', { role: 'alert', style: { color: dshThemeColor.error } }, saveError),
    saved && createElement('div', { role: 'status', style: { color: dshThemeColor.success } }, t(cleared ? 'cli.defaultsClearedHint' : 'cli.defaultsSavedHint')),
    createElement('h4', { style: { margin: '6px 0 0' } }, t('cli.modelCatalog')),
    merged.groups.length === 0 && createElement('div', { style: dshSettingsHelpStyle }, t(scanning ? 'cli.readingModels' : 'cli.noModels')),
    ...merged.groups.map((group) => createElement('div', { key: group.id },
      createElement('div', { style: dshSettingsHelpStyle }, group.name),
      ...group.models.map((model) => createElement('button', {
        key: model.id, type: 'button', disabled: !writable || saving, onClick: () => editModel(model.id),
        style: { ...dshSettingsButtonStyle, display: 'block', width: '100%', textAlign: 'left', marginTop: 4, overflowWrap: 'anywhere' },
      }, `${model.name} (${model.id})`, model.efforts.length > 0 ? ` · ${model.efforts.join(' / ')}` : '')),
    )),
  )
}
