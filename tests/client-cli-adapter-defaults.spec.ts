import assert from 'node:assert/strict'
import test from 'node:test'
import type { CodingNsCliModelCatalog } from '../data/build/dist/shared/contracts/cli-adapter.js'
import type { CodingNsSettings, CodingNsCliAdapterDefaults } from '../data/build/dist/shared/contracts/config.js'
import type { CodingNsSettingsOperation, CodingNsSettingsStore } from '../data/build/dist/dsh-capabilities/settings-store.js'
import { clearCliAdapterDefaults, compatibleEffort, mergeCustomModelCatalog, parseCustomModelIds, saveCliAdapterDefaults, scanCliAdapterModels } from '../data/build/dist/client/cli-adapter-defaults.js'
import { createCodingNsSettingsBridge } from '../data/build/dist/client/settings-bridge.js'
import { CODINGNS_RPC_CHANNEL } from '../data/build/dist/shared/contracts/transport.js'

const scanned: CodingNsCliModelCatalog = {
  groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'provider-a/model-a', name: 'Model A', efforts: ['low', 'high'] }] }],
  currentModel: 'provider-a/model-a', currentEffort: 'low',
}

test('自定义目录保留完整提供商 ID，逐行去空去重且不修改扫描目录', () => {
  const ids = parseCustomModelIds(' provider-a/model-a\r\n\nprovider-b/Model-B\nprovider-b/Model-B\n model:latest ')
  assert.deepEqual(ids, ['provider-a/model-a', 'provider-b/Model-B', 'model:latest'])
  const merged = mergeCustomModelCatalog(scanned, ids, '自定义')
  assert.deepEqual(merged.groups.flatMap((group) => group.models.map((model) => model.id)), ids)
  assert.deepEqual(merged.groups[1]?.models[0]?.efforts, [])
  assert.equal(scanned.groups.length, 1)
  assert.equal(merged.currentModel, scanned.currentModel)
})

test('扫描带refresh调用真实CLI目录，保留Host扫描限制信息并合并手动目录', async () => {
  const catalog = { ...scanned, scanError: 'CLI 当前未提供完整目录' }
  const rpc = { call: async (channel: string, endpoint: string, payload: unknown) => {
    assert.equal(channel, CODINGNS_RPC_CHANNEL)
    assert.equal(endpoint, 'cli/models')
    assert.deepEqual(payload, { adapterId: 'codex', refresh: true })
    return { ok: true as const, value: catalog }
  } }
  const result = await scanCliAdapterModels(rpc, 'codex', true)
  const merged = mergeCustomModelCatalog(result, ['custom/new-model'], '自定义')
  assert.equal(merged.scanError, catalog.scanError)
  assert.equal(merged.groups[1]?.models[0]?.id, 'custom/new-model')
})

test('删除自定义目录条目即时移除Host旧目录，同时保留真实CLI同名分组', () => {
  const base: CodingNsCliModelCatalog = { ...scanned, groups: [
    ...scanned.groups,
    { id: 'codingns-custom', name: 'Host旧目录', models: [{ id: 'removed/model', name: '旧条目', efforts: [] }] },
    { id: 'custom', name: '真实CLI分组', models: [{ id: 'cli/custom-model', name: 'CLI模型', efforts: [] }] },
  ] }
  const merged = mergeCustomModelCatalog(base, ['replacement/model'], '自定义')
  assert.deepEqual(merged.groups.flatMap((group) => group.models.map((model) => model.id)), ['provider-a/model-a', 'cli/custom-model', 'replacement/model'])
})

test('扫描路由不支持时沿用HTTP回退，初次目录读取不强制刷新', async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  const rpc = { call: async (channel: string, endpoint: string, payload: unknown) => {
    calls.push({ channel, endpoint, payload })
    if (calls.length === 1) throw new Error('HTTP 404')
    return { ok: true as const, value: scanned }
  } }
  assert.deepEqual(await scanCliAdapterModels(rpc, 'codex', false), scanned)
  assert.deepEqual(calls[1], { channel: '/api', endpoint: 'codingns/cli/models', payload: { adapterId: 'codex' } })
})

test('扫描报错不消费或修改手动目录与默认模型草稿', async () => {
  const draft = { modelId: 'provider-b/manual', effortId: '', customModelText: 'provider-b/manual' }
  const rpc = { call: async () => ({ ok: false as const, error: { code: 'SCAN_UNAVAILABLE', message: 'CLI 不可用' } }) }
  await assert.rejects(scanCliAdapterModels(rpc, 'missing-cli', true), /CLI 不可用/u)
  const store = memorySettingsStore()
  assert.equal(await saveCliAdapterDefaults(store, 'missing-cli', draft, null), true)
  assert.deepEqual(store.getSnapshot().value?.agentAdapterDefaults?.['missing-cli'], { modelId: 'provider-b/manual', customModelIds: ['provider-b/manual'] })
  assert.equal(draft.modelId, 'provider-b/manual')
})

test('切换模型只保留CLI实际支持的强度，未知自定义模型不伪造强度', () => {
  assert.equal(compatibleEffort(scanned, 'provider-a/model-a', 'high'), 'high')
  assert.equal(compatibleEffort(scanned, 'provider-a/model-a', 'ultra'), '')
  assert.equal(compatibleEffort(scanned, 'custom/model', 'high'), '')
  assert.equal(compatibleEffort(null, 'custom/model', 'high'), '')
})

test('保存固定默认不改变最近选择，清除默认保留已保存目录与其他Agent', async () => {
  const store = memorySettingsStore()
  const recent = { modelId: 'previous/model', effortId: 'low' }
  store.getSnapshot().value!.agentAdapterPreferences = { codex: recent }
  await saveCliAdapterDefaults(store, 'other-cli', { modelId: 'other/model', effortId: '', customModelText: 'other/model' }, null)
  await saveCliAdapterDefaults(store, 'codex', { modelId: ' provider-a/model-a ', effortId: 'high', customModelText: 'custom/model\ncustom/model' }, scanned)
  assert.deepEqual(store.getSnapshot().value?.agentAdapterDefaults?.codex, { modelId: 'provider-a/model-a', effortId: 'high', customModelIds: ['custom/model'] })
  await clearCliAdapterDefaults(store, 'codex')
  assert.deepEqual(store.getSnapshot().value?.agentAdapterDefaults?.codex, { customModelIds: ['custom/model'] })
  assert.deepEqual(store.getSnapshot().value?.agentAdapterDefaults?.['other-cli'], { modelId: 'other/model', customModelIds: ['other/model'] })
  assert.deepEqual(store.getSnapshot().value?.agentAdapterPreferences?.codex, recent)
})

test('Host拒绝保存或写入报错时不会修改草稿，调用者能继续重试', async () => {
  const draft = { modelId: ' manual/model ', effortId: '', customModelText: 'custom/model' }
  const before = { ...draft }
  const store = memorySettingsStore()
  store.mutate = async () => false
  assert.equal(await saveCliAdapterDefaults(store, 'codex', draft, null), false)
  assert.deepEqual(draft, before)
  store.mutate = async () => { throw new Error('Host write failed') }
  await assert.rejects(saveCliAdapterDefaults(store, 'codex', draft, null), /Host write failed/u)
  assert.deepEqual(draft, before)
})

test('远程设置桥保存后新建桥仍能读取配置，扫描不覆盖持久目录', async () => {
  const store = memorySettingsStore()
  const rpc = { call: async (_channel: string, endpoint: string, payload: unknown) => {
    if (endpoint === 'settings/set') await store.mutate((payload as { ops: CodingNsSettingsOperation[] }).ops)
    return { ok: true as const, value: { value: store.getSnapshot().value, revision: 1 } }
  } }
  const bridge = createCodingNsSettingsBridge(undefined, rpc)
  await bridge.load()
  await saveCliAdapterDefaults(bridge, 'codex', { modelId: 'manual/model', effortId: '', customModelText: 'custom/model' }, null)
  bridge.dispose()
  const reopened = createCodingNsSettingsBridge(undefined, rpc)
  await reopened.load()
  assert.deepEqual(reopened.getSnapshot().value?.agentAdapterDefaults?.codex, { modelId: 'manual/model', customModelIds: ['custom/model'] })
  mergeCustomModelCatalog(scanned, ['custom/model'], '自定义')
  assert.deepEqual(reopened.getSnapshot().value?.agentAdapterDefaults?.codex?.customModelIds, ['custom/model'])
  reopened.dispose()
})

/** 模拟持久设置文档，断言跨界写入不会触碰其他字段。 */
function memorySettingsStore(): CodingNsSettingsStore<CodingNsSettings> {
  const value = { agentAdapterDefaults: {}, agentAdapterPreferences: {} } as CodingNsSettings
  return {
    getSnapshot: () => ({ value, revision: 1, writable: true, status: 'ready' }),
    subscribe: () => () => undefined,
    set: async () => true,
    unset: async () => true,
    mutate: async (ops) => {
      for (const op of ops) {
        assert.equal(op.path[0], 'agentAdapterDefaults')
        const adapterId = op.path[1]!
        if (op.op === 'set') value.agentAdapterDefaults![adapterId] = op.value as CodingNsCliAdapterDefaults
        else {
          const entry = value.agentAdapterDefaults?.[adapterId]
          if (entry !== undefined) delete (entry as Record<string, unknown>)[op.path[2]!]
        }
      }
      return true
    },
  }
}
