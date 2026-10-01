import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliSessionRecord,
} from '../../shared/contracts/cli-adapter.js'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import { archiveCliSession, callCliRpc, errorMessage, listCliSessions, restoreCliSession } from '../cli-catalog.js'
import { dshFormRootStyle, dshPopupSurfaceStyle, dshSettingsButtonStyle, dshSettingsListRowStyle, dshThemeColor } from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'
import { backdropPointerDownHandler } from '../popup-dismiss.js'
import { registerExternalToolStreamUi } from '../external-tool-stream.js'
import { startContextBreakdownDom } from '../context-breakdown-dom.js'
import { fetchSessionAdapters, replaceSessionAdapters, sessionAdapterId } from '../session-adapter-cache.js'
import { CliAdapterDefaultsPanel } from './cli-adapter-defaults-panel.js'

/** 外部 Agent 集成模块。Agent 进程在 Host 运行，浏览器只读取目录和状态。 */
export const cliAdaptersFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'cliAdapters',
    version: '0.1.1',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '外部Agent集成',
      description: '管理外部 Agent',
      labelKey: 'feature.cliAdapters.label',
      descriptionKey: 'feature.cliAdapters.description',
      order: 30,
      defaultOpen: false,
    },
  },
  start: async (context) => {
    // 外部 Agent 的上下文由 Agent 自己组装，上下文面板的启发式构成与真实用量
    // 不同源；对这类适配器的会话隐藏构成明细，只保留百分比与总量。
    const contextBreakdownDom = startContextBreakdownDom({
      adapterIdForSession: sessionAdapterId,
      refreshAdapters: async () => {
        replaceSessionAdapters(await fetchSessionAdapters(context.services.rpc))
      },
    })
    context.resources.add(() => contextBreakdownDom.dispose())
    const slots = context.services.slots
    if (slots === undefined) return
    context.resources.add(registerExternalToolStreamUi(context.services))
    // CLI Slot 带有浏览器图片资源，启用模块时再加载，避免 Node 侧读取 Client 元数据时解析图片。
    const { registerCliConversationSlots } = await import('../cli-slots.js')
    const disposeSlots = registerCliConversationSlots(slots, context.services.rpc, context.services.locale)
    context.resources.add(disposeSlots)
  },
  settingsPanel: CliAdaptersPanel,
}

/** 设置页中的 Agent 列表和详情模态框。 */
export function CliAdaptersPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [catalog, setCatalog] = useState<readonly CodingNsCliAdapterDescriptor[]>([])
  const [selected, setSelected] = useState<CodingNsCliAdapterDescriptor | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyAdapterId, setBusyAdapterId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<readonly CodingNsCliSessionRecord[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(null)
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null)
  const disabled = !enabled

  useEffect(() => {
    if (disabled) return
    let active = true
    setLoading(true)
    void callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(services.rpc, 'catalog', {})
      .then((value) => { if (active) setCatalog(value) })
      .catch((error: unknown) => { if (active) notify({ kind: 'error', message: errorMessage(error) }) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [disabled, services.rpc])

  useEffect(() => {
    if (disabled) {
      setSessions([])
      return
    }
    let active = true
    setSessionsLoading(true)
    void listCliSessions(services.rpc)
      .then((value) => { if (active) setSessions(value) })
      .catch((error: unknown) => { if (active) notify({ kind: 'error', message: errorMessage(error) }) })
      .finally(() => { if (active) setSessionsLoading(false) })
    return () => { active = false }
  }, [disabled, services.rpc])

  const rowStyle = dshSettingsListRowStyle
  const buttonStyle = { ...dshSettingsButtonStyle, cursor: disabled ? 'not-allowed' : 'pointer' }
  const toggleAdapter = async (adapter: CodingNsCliAdapterDescriptor, next: boolean): Promise<void> => {
    setBusyAdapterId(adapter.id)
    try {
      await callCliRpc(services.rpc, 'adapter/set', { adapterId: adapter.id, enabled: next })
      const refreshed = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(services.rpc, 'catalog', {})
      setCatalog(refreshed)
      notify({ kind: 'success', message: next ? `已启用 ${adapter.name}` : `已停用 ${adapter.name}` })
    } catch (error) {
      notify({ kind: 'error', message: errorMessage(error) })
    } finally {
      setBusyAdapterId(null)
    }
  }

  const restoreSession = async (record: CodingNsCliSessionRecord): Promise<void> => {
    setRestoringSessionId(record.dshSessionId)
    try {
      await restoreCliSession(services.rpc, record)
      notify({ kind: 'success', message: `已打开 ${record.title ?? record.adapterId} 会话` })
    } catch (error) {
      notify({ kind: 'error', message: errorMessage(error) })
    } finally {
      setRestoringSessionId(null)
    }
  }

  const archiveSession = async (record: CodingNsCliSessionRecord): Promise<void> => {
    setArchivingSessionId(record.dshSessionId)
    try {
      await archiveCliSession(services.rpc, record.dshSessionId)
      setSessions((current) => current.filter((item) => item.dshSessionId !== record.dshSessionId))
      notify({ kind: 'success', message: `已移除 ${record.title ?? record.adapterId} 会话` })
    } catch (error) {
      notify({ kind: 'error', message: errorMessage(error) })
    } finally {
      setArchivingSessionId(null)
    }
  }

  return createElement(
    'div',
    { 'aria-disabled': disabled, style: { ...dshFormRootStyle, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' } },
    loading && createElement('div', { role: 'status' }, t('cli.readingAgents')),
    !loading && catalog.length === 0 && createElement('div', { role: 'status', style: { opacity: 0.7 } }, t('cli.noAgents')),
    createElement('div', undefined,
      ...catalog.map((adapter) => createElement('div', { key: adapter.id, style: rowStyle },
        createElement('button', {
          type: 'button',
          onClick: () => setSelected(adapter),
          style: { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: 0, border: 0, color: 'inherit', textAlign: 'left', background: 'transparent', cursor: 'pointer' },
          'aria-label': t('cli.viewDetails', { name: adapter.name }),
        },
          createElement('span', { style: { flex: '1 1 auto', minWidth: 0, fontWeight: 600 } }, adapter.name),
          createElement('span', { style: { color: adapter.installed ? dshThemeColor.success : dshThemeColor.labelTertiary } }, adapter.installed ? t('cli.installed') : t('cli.notInstalled')),
          createElement('span', { style: { minWidth: 70, color: dshThemeColor.labelTertiary } }, adapter.version ?? t('cli.notDetectedVersion')),
        ),
        createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' } },
          createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': t('cli.adapterToggle', { name: adapter.name }), checked: adapter.enabled, disabled: !adapter.installed || busyAdapterId === adapter.id, onChange: (event: { currentTarget: { checked: boolean } }) => { void toggleAdapter(adapter, event.currentTarget.checked) }, style: { accentColor: dshThemeColor.accent } }),
          createElement('span', undefined, adapter.enabled ? t('cli.enabled') : t('cli.disabled')),
        ),
      )),
    ),
    createElement(CliSessionList, {
      sessions,
      loading: sessionsLoading,
      restoringSessionId,
      archivingSessionId,
      onRestore: (record) => { void restoreSession(record) },
      onArchive: (record) => { void archiveSession(record) },
      t,
    }),
    selected !== null && createElement(AdapterDetailsDialog, {
      adapter: selected,
      services,
      snapshot,
      notify,
      onClose: () => setSelected(null),
      buttonStyle,
      t,
    }),
  )
}

interface CliSessionListProps {
  readonly sessions: readonly CodingNsCliSessionRecord[]
  readonly loading: boolean
  readonly restoringSessionId: string | null
  readonly archivingSessionId: string | null
  readonly onRestore: (record: CodingNsCliSessionRecord) => void
  readonly onArchive: (record: CodingNsCliSessionRecord) => void
  readonly t: ReturnType<typeof useCodingNsTranslator>
}

/** 外部会话索引入口；打开后交给 DSH 原生会话页面渲染消息。 */
function CliSessionList({ sessions, loading, restoringSessionId, archivingSessionId, onRestore, onArchive, t }: CliSessionListProps): ReactElement {
  return createElement('section', { 'aria-labelledby': 'codingns-cli-session-title', style: { marginTop: 20 } },
    createElement('h4', { id: 'codingns-cli-session-title', style: { margin: '0 0 8px' } }, t('cli.sessions')),
    loading && createElement('div', { role: 'status' }, t('cli.readingSessions')),
    !loading && sessions.length === 0 && createElement('div', { style: { opacity: 0.7 } }, t('cli.noSessions')),
    !loading && sessions.length > 0 && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      ...sessions.map((record) => createElement('div', {
        key: record.dshSessionId,
        style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${dshThemeColor.border}` },
      },
        createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          createElement('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, record.title ?? t('cli.session', { id: record.adapterId })),
          createElement('div', {
            title: record.providerStateReason,
            style: { marginTop: 2, color: record.providerState === 'missing' ? dshThemeColor.error : dshThemeColor.labelTertiary, fontSize: 12 },
          }, `${record.adapterId} · ${sessionStatusLabel(record, t)}`),
        ),
        createElement('button', {
          type: 'button',
          onClick: () => onRestore(record),
          disabled: restoringSessionId !== null,
          'aria-label': `${t('cli.open')} ${record.title ?? t('cli.session', { id: record.adapterId })}`,
          style: { ...dshSettingsButtonStyle, flex: '0 0 auto', cursor: restoringSessionId === null ? 'pointer' : 'not-allowed' },
        }, restoringSessionId === record.dshSessionId ? t('cli.opening') : t('cli.open')),
        record.providerState === 'missing' && createElement('button', {
          type: 'button',
          onClick: () => onArchive(record),
          disabled: archivingSessionId !== null,
          'aria-label': t('cli.removeFromSidebar', { name: record.title ?? t('cli.session', { id: record.adapterId }) }),
          style: { ...dshSettingsButtonStyle, flex: '0 0 auto', color: dshThemeColor.error, cursor: archivingSessionId === null ? 'pointer' : 'not-allowed' },
        }, archivingSessionId === record.dshSessionId ? t('cli.removing') : t('cli.remove')),
      )),
    ),
  )
}

function sessionStatusLabel(record: CodingNsCliSessionRecord, t: ReturnType<typeof useCodingNsTranslator>): string {
  if (record.providerState === 'missing') return t('cli.statusMissing')
  if (record.providerState === 'corrupt') return t('cli.statusCorrupt')
  if (record.providerState === 'unreachable') return t('cli.statusUnreachable')
  if (record.providerState === 'ephemeral') return t('cli.statusEphemeral')
  if (record.status === 'active') return t('cli.statusActive')
  if (record.status === 'error') return t('cli.statusError')
  if (record.status === 'archived') return t('cli.statusArchived')
  return t('cli.statusPaused')
}

interface AdapterDetailsDialogProps {
  readonly adapter: CodingNsCliAdapterDescriptor
  readonly services: FeaturePanelProps['services']
  readonly snapshot: FeaturePanelProps['snapshot']
  readonly notify: FeaturePanelProps['notify']
  readonly onClose: () => void
  readonly buttonStyle: CSSProperties
  readonly t: ReturnType<typeof useCodingNsTranslator>
}

function AdapterDetailsDialog({ adapter, services, snapshot, notify, onClose, buttonStyle, t }: AdapterDetailsDialogProps): ReactElement {
  return createElement('div', {
    role: 'presentation',
    onPointerDown: backdropPointerDownHandler(onClose),
    style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: dshThemeColor.overlay },
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'codingns-cli-adapter-title',
      style: { ...dshPopupSurfaceStyle, width: 'min(100%, 620px)', maxHeight: 'min(720px, 90vh)', overflow: 'auto', boxSizing: 'border-box', padding: 24, borderRadius: 8 },
    },
      createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
        createElement('h3', { id: 'codingns-cli-adapter-title', style: { margin: 0, fontSize: 18 } }, adapter.name),
      createElement('button', { type: 'button', onClick: onClose, style: buttonStyle, 'aria-label': t('cli.closeDetails') }, t('cli.closeDetails')),
      ),
      createElement('dl', { style: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', margin: '20px 0' } },
        createElement('dt', undefined, t('cli.installStatus')), createElement('dd', { style: { margin: 0 } }, adapter.installed ? t('cli.installed') : t('cli.notInstalled')),
        createElement('dt', undefined, t('cli.enabledStatus')), createElement('dd', { style: { margin: 0 } }, adapter.enabled ? t('cli.enabled') : t('cli.disabled')),
        createElement('dt', undefined, t('cli.version')), createElement('dd', { style: { margin: 0 } }, adapter.version ?? t('cli.notDetectedVersion')),
        createElement('dt', undefined, t('cli.commandPath')), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.command ?? t('cli.notDetectedCommand')),
        createElement('dt', undefined, t('cli.protocol')), createElement('dd', { style: { margin: 0 } }, adapter.protocol ?? t('cli.undeclared')),
        createElement('dt', undefined, t('cli.capabilities')), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.capabilities?.join('、') ?? t('cli.undeclared')),
      ),
      createElement(CliAdapterDefaultsPanel, { key: adapter.id, adapter, services, snapshot, notify }),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 20 } },
        createElement('button', { type: 'button', onClick: onClose, style: buttonStyle }, t('cli.closeConfig')),
      ),
    ),
  )
}
