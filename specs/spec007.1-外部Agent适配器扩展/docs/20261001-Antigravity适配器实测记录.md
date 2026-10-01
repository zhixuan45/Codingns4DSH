# Antigravity 适配器实测记录

日期：2026-10-01
范围：按 `20260929-适配器接入规范.md` 接入 Google Antigravity CLI（`agy`）。本文件记录每一项能力声明的实测依据，未实测的能力一律不声明。

## 一、环境

- 本机 `agy`：实测开始时为 1.2.1，实测过程中 CLI 自动更新到 1.2.14，两次行为一致。
- 安装位置：`C:\Users\JuziD\AppData\Local\agy\bin\agy.exe`（PATH 上的 `agy`）。
- 会话数据：`~/.gemini/antigravity-cli`（SQLite），不是逐会话 JSONL。

## 二、逐项实测

| 能力 | 命令 / 输入 | 结果 |
| --- | --- | --- |
| 安装探测 | `agy --version` | 输出 `1.2.1` / `1.2.14`，退出码 0 |
| 模型目录 | `agy models` | stdout 逐行 `id<TAB>显示名`（实测 14 条，如 `gemini-3.8-flash-high`）；进度提示与错误在 stderr |
| 流式输出 | `agy --output-format stream-json --print="…"` | NDJSON：`init` / `step_update` / `result`，`step_update.text_delta` 是增量正文 |
| stdin 输入 | `agy --input-format stream-json --output-format stream-json` + stdin 一行 `{"event":"user","message":{"content":[{"type":"text","text":"…"}]}}` | 成功；缺 `event` 字段报 `stream input message is missing the "event" field`，`{"type":"user",…}` 被拒 |
| 会话恢复 | 上一轮 `init.conversation_id` + `--conversation <id>` | `init` 返回同一个 `conversation_id`，模型能答出上一轮内容 |
| 指定模型 | `--model gemini-3.8-flash-medium` | 成功；未知模型退出码 1，`result.status=ERROR` 并列出可用模型 |
| 工具事件 | `step_update` 且 `step_type=tool` | `tool_name` + `tool_info{name,parameters,output,error}`；同一 `step_index` 先 `ACTIVE` 后 `DONE`/`ERROR` |
| 用量 | `step_update` 收尾与 `result` | `usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`（两处数值相同，驱动只保留一次） |
| 取消 | 终止子进程 | print 模式没有 cancel 通道，靠 Host 关闭 stdin 后终止进程；驱动按 `finish(cancel)` 收尾 |
| 附件 | prompt 追加 `@路径` + `--add-dir <目录>` | 文件路径随 prompt 下发，目录加入工作区（与 Claude Code 适配器同一策略） |

## 三、明确不声明的能力与依据

| 未声明 | 依据 |
| --- | --- |
| `permission` | `agy` 只有 `--dangerously-skip-permissions` 一个权限开关，headless 不接受双向审批。实测需要审批的 `run_command` 被自动拒绝（`result.denied_actions`），stderr 提示改用 allow 规则或 skip-permissions |
| `questions` | print 模式硬编码跳过 `ask_question`，流里不会出现该工具事件 |
| `reasoning` | 实测流里没有思考增量事件（`thinking_tokens` 只在使用量里出现）；思考强度写在模型 ID 中（如 `gemini-3.8-flash-high`），驱动不传 `--effort` |
| `steer` / `continuable` / `team-proxy` | print 模式每轮一个进程，没有回合中追加或常驻会话通道 |

## 四、实现与登记位置

- 驱动：`src/host/cli-adapters/antigravity-driver.ts`（继承 `StandardStreamDriver`）
- stdin 写入：`src/host/cli-adapters/standard-stream-driver.ts` 新增可覆写的 `stdinPrompt()`；默认返回 `undefined`，其余 8 个适配器行为不变
- 登记：`feature.ts` 驱动数组、`model-catalog.ts` 静态回退目录、`provider-icons.ts` 与 `provider-icon-assets.ts` 图标、`CODINGNS_EXTERNAL_ADAPTER_IDS`、`legacy-session-adapter.ts` 已知 ID
- 测试：`tests/cli-adapters-antigravity.spec.ts`（12 项）

## 五、已知限制

1. 未实现 `probeSession`：会话存在 SQLite 中，规范 §5.3 要求存储格式不是 JSONL 时不得套用 JSONL 校验，因此保持"不探测"（注册表在缺少 `probeSession` 时跳过探测），恢复只依赖 `--conversation`。
2. 首轮以外的轮次依赖 `--conversation` 续接；如果该会话在 Antigravity 侧被删除，CLI 会新建会话并返回新的 `conversation_id`。
3. 驱动默认带 `--dangerously-skip-permissions`（与其它适配器全放行惯例一致），DSH 侧没有对应审批交互；README 已如实标注。

## 六、验证

- 驱动测试 12 项通过（探测、stdin 信封、正文不重复、usage 去重、工具 running/completed/failed、result(error) 保留原始原因、被拒绝工具的可诊断错误、取消、无输出快速失败、模型目录解析、附件参数）。
- 真实 CLI 端到端一轮：`detect()` 返回 1.2.14、`listModels()` 解析出 14 个模型、`executeTurn()` 依次产出 `session-binding` → `text-delta` → `usage` → `finish(stop)`。
- 全量测试 939 项：927 通过、11 失败；与不含本次改动的同环境基线（927 项、915 通过、11 失败）失败集合完全一致。
