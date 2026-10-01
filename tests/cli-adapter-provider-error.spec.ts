import assert from 'node:assert/strict'
import test from 'node:test'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'

const EMPTY_RESPONSE = 'CODINGNS_PROVIDER_EMPTY_RESPONSE'

/**
 * 回归防护：曾经安装到 desktop profile 的本地补丁必须留在源码里。
 *
 * DSH 原生 Provider 在正文前失败时只发 `finish(error)`，取消时只发 `finish(aborted)`。
 * 旧实现只在收到有效正文事件时才透传终态，于是把真实失败改写成
 * `CODINGNS_PROVIDER_EMPTY_RESPONSE`，用户看不到 HTTP 状态、额度或取消原因。
 */
async function runNativeStream(chunks) {
  const table = new CodingNsRpcTable()
  let listener
  const events = {
    on(_name, next) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature())
  await features.start('cliAdapters')
  const received = []
  try {
    for await (const chunk of listener({ sessionId: 'native-provider-error', provider: 'deepseek-official' }, async function* () {
      for (const chunk of chunks) yield chunk
    })) received.push(chunk)
  } finally {
    await features.disable('cliAdapters')
  }
  return received
}

test('只有 finish(error) 时保留 Provider 原始错误，不伪装成空响应', async () => {
  const reason = { kind: 'error', failure: { message: 'HTTP 401 unauthorized', code: 'PROVIDER_ERROR' } }
  const chunks = await runNativeStream([{ type: 'finish', reason }])
  assert.deepEqual(chunks, [{ type: 'finish', reason }])
  assert.equal(JSON.stringify(chunks).includes(EMPTY_RESPONSE), false)
})

test('只有 finish(aborted) 时保留取消原因', async () => {
  const reason = { kind: 'aborted' }
  const chunks = await runNativeStream([{ type: 'finish', reason }])
  assert.deepEqual(chunks, [{ type: 'finish', reason }])
  assert.equal(JSON.stringify(chunks).includes(EMPTY_RESPONSE), false)
})

test('正文或用量到达后仍原样透传错误终态', async () => {
  const reason = { kind: 'error', failure: { message: '上游 503', code: 'PROVIDER_ERROR' } }
  const partial = await runNativeStream([
    { type: 'text-delta', text: '部分回答' },
    { type: 'finish', reason },
  ])
  assert.deepEqual(partial, [{ type: 'text-delta', text: '部分回答' }, { type: 'finish', reason }])

  const usageOnly = await runNativeStream([
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'aborted' } },
  ])
  assert.deepEqual(usageOnly.at(-1), { type: 'finish', reason: { kind: 'aborted' } })
  assert.equal(JSON.stringify(usageOnly).includes(EMPTY_RESPONSE), false)
})

test('确实是空正常终态时仍然报空响应错误', async () => {
  const chunks = await runNativeStream([{ type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && String(chunk.text).includes(EMPTY_RESPONSE)), true)
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: DSH Provider 未返回任何有效事件。', code: 'PROVIDER_ERROR' } },
  })
})
