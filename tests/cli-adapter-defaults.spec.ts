import assert from 'node:assert/strict'
import test from 'node:test'
import { CODINGNS_CUSTOM_MODEL_GROUP_ID } from '../data/build/dist/shared/contracts/cli-adapter.js'
import { CLAUDE_CATALOG, CODEX_CATALOG, GEMINI_CATALOG } from '../data/build/dist/host/cli-adapters/model-catalog.js'
import {
  hasMissingPreferences,
  isExternalAdapterId,
  mergeAdapterModels,
  mergePreferenceRecords,
  parseAdapterDefaults,
  preferenceSnapshot,
  resolveAdapterSelection,
} from '../data/build/dist/host/cli-adapters/adapter-defaults.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { createCodingNsSettingsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcError } from '../data/build/dist/host/rpc-table.js'

const EMPTY_CATALOG = { groups: [], currentModel: null, currentEffort: null }

/** 最小驱动：只为默认值取值顺序和目录合并提供输入。 */
function makeDriver(id, options = {}) {
  let calls = 0
  return {
    descriptor: { id, name: id },
    listModels: async () => {
      calls += 1
      if (options.failModels) throw options.failModels
      return options.catalog ?? EMPTY_CATALOG
    },
    get modelCalls() { return calls },
    async detect() { return { installed: true, version: '1.0.0', command: id } },
    async *executeTurn() { yield { type: 'finish', reason: { kind: 'stop' } } },
  }
}

test('取值顺序为调用参数、同适配器已有会话、设置页默认值、最近使用记录', () => {
  const defaults = { modelId: 'default/model', effortId: 'high' }
  const remembered = { modelId: 'remembered/model', effortId: 'low' }
  const previous = { adapterId: 'codex', modelId: 'session/model', effortId: 'medium' }

  assert.deepEqual(
    resolveAdapterSelection({ adapterId: 'codex', modelId: 'explicit/model', effortId: 'xhigh' }, previous, defaults, remembered),
    { modelId: 'explicit/model', effortId: 'xhigh' },
  )
  assert.deepEqual(
    resolveAdapterSelection({ adapterId: 'codex' }, previous, defaults, remembered),
    { modelId: 'session/model', effortId: 'medium' },
  )
  assert.deepEqual(
    resolveAdapterSelection({ adapterId: 'codex' }, undefined, defaults, remembered),
    { modelId: 'default/model', effortId: 'high' },
  )
  assert.deepEqual(
    resolveAdapterSelection({ adapterId: 'codex' }, undefined, undefined, remembered),
    { modelId: 'remembered/model', effortId: 'low' },
  )
  // 清除设置值后按同一条规则回退，不写入猜测的模型名。
  assert.deepEqual(resolveAdapterSelection({ adapterId: 'codex' }, undefined, undefined, undefined), {})
})

test('切换模型不继承另一个模型的思考强度', () => {
  const previous = { adapterId: 'codex', modelId: 'gpt-5.5', effortId: 'xhigh' }
  assert.deepEqual(
    resolveAdapterSelection({ adapterId: 'codex', modelId: 'gpt-5.4' }, previous, undefined, undefined),
    { modelId: 'gpt-5.4' },
  )
  // 默认值指向别的模型时同样不能沿用默认强度。
  assert.deepEqual(
    resolveAdapterSelection({ adapterId: 'codex', modelId: 'gpt-5.4' }, undefined, { modelId: 'gpt-5.5', effortId: 'high' }, undefined),
    { modelId: 'gpt-5.4' },
  )
  // 切回同一适配器的其他会话也不能跨适配器复用选择。
  assert.deepEqual(
    resolveAdapterSelection({ adapterId: 'gemini' }, previous, undefined, undefined),
    {},
  )
})

test('默认值解析拒绝未知字段、非法类型和超长 ID，并归一化自定义目录', () => {
  assert.deepEqual(parseAdapterDefaults({ modelId: ' a/model ', effortId: ' high ', customModelIds: ['x', 'x', ' y '] }), {
    modelId: 'a/model',
    effortId: 'high',
    customModelIds: ['x', 'y'],
  })
  assert.deepEqual(parseAdapterDefaults({ modelId: '   ' }), {})
  assert.throws(() => parseAdapterDefaults({ modelId: 'a', extra: true }), /未知字段/u)
  assert.throws(() => parseAdapterDefaults({ modelId: 42 }), /短字符串/u)
  assert.throws(() => parseAdapterDefaults({ customModelIds: 'not-an-array' }), /数组/u)
  assert.throws(() => parseAdapterDefaults({ modelId: 'a'.repeat(513) }), /短字符串/u)
  assert.throws(() => parseAdapterDefaults({ customModelIds: Array.from({ length: 201 }, (_, index) => `m${index}`) }), /200/u)
  assert.throws(() => parseAdapterDefaults(null), /对象/u)
  assert.equal(isExternalAdapterId('codex'), true)
  assert.equal(isExternalAdapterId('dsh'), false)
  assert.equal(isExternalAdapterId('not-a-cli'), false)
})

test('目录合并保留扫描结果、去重自定义 ID，并标注静态回退来源', () => {
  const merged = mergeAdapterModels('codex', CODEX_CATALOG, { customModelIds: ['gpt-5.5', 'custom/new-model'] })
  assert.equal(merged.groups[0]?.models.filter((model) => model.id === 'gpt-5.5').length, 1)
  const custom = merged.groups.find((group) => group.id === CODINGNS_CUSTOM_MODEL_GROUP_ID)
  assert.deepEqual(custom?.models.map((model) => model.id), ['custom/new-model'])
  // 内置候选不是真实扫描结果，必须给出可诊断提示。
  assert.match(String(merged.scanError), /内置候选/u)
  assert.equal(mergeAdapterModels('codex', EMPTY_CATALOG, undefined).scanError, undefined)
})

test('扫描失败仍保留手动目录，并对不支持强度下发的 CLI 清空档位', () => {
  const failed = mergeAdapterModels('codex', EMPTY_CATALOG, { customModelIds: ['manual/model'] }, new Error('CLI 不可用'))
  assert.equal(failed.scanError, 'CLI 不可用')
  assert.deepEqual(failed.groups.find((group) => group.id === CODINGNS_CUSTOM_MODEL_GROUP_ID)?.models.map((model) => model.id), ['manual/model'])

  for (const adapterId of ['claude-code', 'kimi', 'grok']) {
    const stripped = mergeAdapterModels(adapterId, CLAUDE_CATALOG, undefined)
    assert.deepEqual(stripped.groups.flatMap((group) => group.models.map((model) => model.efforts)), stripped.groups.flatMap((group) => group.models.map(() => [])))
  }
  const kept = mergeAdapterModels('gemini', GEMINI_CATALOG, undefined)
  assert.deepEqual(kept.groups[0]?.models[0]?.efforts, ['low', 'medium', 'high'])
})

test('最近选择的合并与缺失判断在迁移到独立模块后保持原行为', () => {
  const legacy = { codex: { modelId: 'legacy/model', effortId: 'low' }, gemini: { modelId: '  ' } }
  const configured = { codex: { effortId: 'high' }, pi: { modelId: 'pi/model' } }
  // 只有空白的旧记录会归一化成空对象；Registry 的 syncPreferences 会跳过它，
  // 因此不会产生任何默认模型，这里按迁移前的行为固定下来。
  assert.deepEqual(mergePreferenceRecords(legacy, configured), {
    codex: { modelId: 'legacy/model', effortId: 'high' },
    gemini: {},
    pi: { modelId: 'pi/model' },
  })
  // 全部旧字段都已在配置里补齐时不再触发迁移写入；缺一个就要补。
  const cleanLegacy = { codex: { modelId: 'legacy/model', effortId: 'low' } }
  assert.equal(hasMissingPreferences({ codex: { modelId: 'a', effortId: 'b' } }, cleanLegacy), false)
  assert.equal(hasMissingPreferences({ codex: { modelId: 'a' } }, cleanLegacy), true)
  // 只有空白的旧记录同样被判为缺失，与迁移前一致（只触发一次补齐写入）。
  assert.equal(hasMissingPreferences({}, { kimi: { modelId: ' ' } }), true)
  const snapshot = preferenceSnapshot(new Map([['codex', { modelId: 'a' }]]))
  assert.deepEqual(snapshot, { codex: { modelId: 'a' } })
})

test('新会话使用设置页默认值，已有会话不被后续默认值改写', () => {
  const registry = new CodingNsCliAdapterRegistry([makeDriver('codex')])
  registry.syncDefaults({ codex: { modelId: 'gpt-5.5', effortId: 'high' } })
  const created = registry.setSession('session-new', { adapterId: 'codex' })
  assert.equal(created.modelId, 'gpt-5.5')
  assert.equal(created.effortId, 'high')

  const explicit = registry.setSession('session-explicit', { adapterId: 'codex', modelId: 'gpt-5.4', effortId: 'low' })
  assert.equal(explicit.modelId, 'gpt-5.4')
  registry.syncDefaults({ codex: { modelId: 'gpt-5.5', effortId: 'high' } })
  assert.equal(registry.getSession('session-explicit').modelId, 'gpt-5.4')
  assert.equal(registry.getSession('session-explicit').effortId, 'low')
  assert.equal(registry.getSession('session-new').modelId, 'gpt-5.5')
})

test('清除默认值后回退到最近使用记录，且不同 CLI 的默认值互不影响', () => {
  const registry = new CodingNsCliAdapterRegistry([makeDriver('codex'), makeDriver('gemini')])
  registry.syncDefaults({ codex: { modelId: 'gpt-5.5', effortId: 'high' }, gemini: { modelId: 'gemini-2.5-pro' } })
  registry.setSession('codex-1', { adapterId: 'codex' })
  const gemini = registry.setSession('gemini-1', { adapterId: 'gemini' })
  assert.equal(gemini.modelId, 'gemini-2.5-pro')
  assert.equal(gemini.effortId, undefined)
  assert.equal(registry.getSession('codex-1').modelId, 'gpt-5.5')

  registry.syncDefaults({ gemini: { modelId: 'gemini-2.5-pro' } })
  const afterClear = registry.setSession('codex-2', { adapterId: 'codex' })
  // codex 的默认值已清除，回退到仍保留最近使用记录的 gpt-5.5。
  assert.equal(afterClear.modelId, 'gpt-5.5')
  const stillGemini = registry.setSession('gemini-2', { adapterId: 'gemini' })
  assert.equal(stillGemini.modelId, 'gemini-2.5-pro')
})

test('同适配器已有会话选择优先于新保存的默认值', () => {
  const registry = new CodingNsCliAdapterRegistry([makeDriver('codex')])
  registry.setSession('session-1', { adapterId: 'codex', modelId: 'gpt-5.4', effortId: 'low' })
  registry.syncDefaults({ codex: { modelId: 'gpt-5.5', effortId: 'high' } })
  const again = registry.setSession('session-1', { adapterId: 'codex' })
  assert.equal(again.modelId, 'gpt-5.4')
  assert.equal(again.effortId, 'low')
})

test('强制刷新绕过模型缓存，扫描失败时仍返回手动目录', async () => {
  const driver = makeDriver('codex', { catalog: CODEX_CATALOG })
  const registry = new CodingNsCliAdapterRegistry([driver])
  await registry.models('codex')
  await registry.models('codex')
  assert.equal(driver.modelCalls, 1)
  await registry.models('codex', { refresh: true })
  assert.equal(driver.modelCalls, 2)

  const failing = makeDriver('codex', { failModels: new Error('CLI 不可用') })
  const broken = new CodingNsCliAdapterRegistry([failing])
  broken.syncDefaults({ codex: { customModelIds: ['manual/model'] } })
  const catalog = await broken.models('codex', { refresh: true })
  assert.match(String(catalog.scanError), /CLI 不可用/u)
  assert.deepEqual(catalog.groups.find((group) => group.id === CODINGNS_CUSTOM_MODEL_GROUP_ID)?.models.map((model) => model.id), ['manual/model'])
})

test('cli/models 路由返回合并目录，并拒绝非布尔 refresh', async () => {
  const registry = new CodingNsCliAdapterRegistry([makeDriver('codex', { catalog: CODEX_CATALOG })])
  registry.syncDefaults({ codex: { modelId: 'gpt-5.5', customModelIds: ['manual/model'] } })
  const table = new CodingNsRpcTable()
  const events = { on: () => () => undefined }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  const target = table.resolve('cli/models')
  assert.notEqual(target, null)
  const catalog = await target.handler(target.action, { adapterId: 'codex' })
  assert.deepEqual(catalog.groups.find((group) => group.id === CODINGNS_CUSTOM_MODEL_GROUP_ID)?.models.map((model) => model.id), ['manual/model'])
  await assert.rejects(async () => { await target.handler(target.action, { adapterId: 'codex', refresh: 'yes' }) }, /refresh 必须是布尔值/u)
  await features.disable('cliAdapters')
})

/** 复刻 Host 设置提供器，断言浏览器只能写自己的 namespace 与白名单字段。 */
function settingsProvider(initial = { agentAdapterDefaults: {} }) {
  let value = initial
  const writes = []
  const provider = {
    writable: true,
    describe: () => [{ ns: 'codingns', value, revision: 1, writable: true }],
    get: () => value,
    mutate: async (_namespace, operations) => {
      writes.push(operations)
      const next = { ...value, agentAdapterDefaults: { ...value.agentAdapterDefaults } }
      for (const operation of operations) {
        if (operation.op === 'set') next.agentAdapterDefaults[operation.path[1]] = operation.value
        else delete next.agentAdapterDefaults[operation.path[1]]?.[operation.path[2]]
      }
      value = next
    },
  }
  return { provider, writes, read: () => value }
}

test('设置 RPC 接受默认值白名单路径并归一化写入值', async () => {
  const { provider, writes } = settingsProvider()
  const handler = createCodingNsSettingsRpcHandler(provider)
  await handler('set', { ops: [{ op: 'set', path: ['agentAdapterDefaults', 'codex'], value: { modelId: ' gpt-5.5 ', effortId: '', customModelIds: ['a', 'a', 'b'] } }] })
  assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['agentAdapterDefaults', 'codex'], value: { modelId: 'gpt-5.5', customModelIds: ['a', 'b'] } }])

  await handler('set', { ops: [{ op: 'set', path: ['agentAdapterDefaults', 'codex', 'modelId'], value: 'gpt-5.4' }] })
  assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['agentAdapterDefaults', 'codex', 'modelId'], value: 'gpt-5.4' }])

  // 只清除指定 CLI 的字段，不影响其他 CLI。
  await handler('set', { ops: [
    { op: 'unset', path: ['agentAdapterDefaults', 'codex', 'modelId'] },
    { op: 'unset', path: ['agentAdapterDefaults', 'codex', 'effortId'] },
  ] })
  assert.deepEqual(writes.at(-1), [
    { op: 'unset', path: ['agentAdapterDefaults', 'codex', 'modelId'] },
    { op: 'unset', path: ['agentAdapterDefaults', 'codex', 'effortId'] },
  ])
})

test('设置 RPC 拒绝未知适配器、未知字段和非法类型', async () => {
  const { provider } = settingsProvider()
  const handler = createCodingNsSettingsRpcHandler(provider)
  const forbidden = (error) => error instanceof CodingNsRpcError && error.code === 'CODINGNS_SETTINGS_FIELD_FORBIDDEN'
  await assert.rejects(handler('set', { ops: [{ op: 'set', path: ['agentAdapterDefaults', 'not-a-cli'], value: {} }] }), forbidden)
  await assert.rejects(handler('set', { ops: [{ op: 'set', path: ['agentAdapterDefaults', 'dsh'], value: {} }] }), forbidden)
  await assert.rejects(handler('set', { ops: [{ op: 'set', path: ['agentAdapterDefaults', 'codex', 'arbitrary'], value: 'x' }] }), forbidden)
  await assert.rejects(handler('set', { ops: [{ op: 'set', path: ['agentAdapterDefaults', 'codex'], value: { modelId: 42 } }] }), /短字符串/u)
  await assert.rejects(handler('set', { ops: [{ op: 'set', path: ['agentAdapterDefaults', 'codex'], value: { modelId: 'a', unknown: 1 } }] }), /未知字段/u)
})
