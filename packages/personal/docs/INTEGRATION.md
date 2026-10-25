# 集成指南：把 PIA 挂到 Pi / PIagent 上

> 目标读者：要把 `@piagent/personal` 接进 PIagent 基座的工程师。
> 对应设计：[`docs/04`](../../docs/04-PersonalAgent框架设计.md) §6、[`docs/06`](../../docs/06-附录-接口契约与Schema.md)。
> 基座版本基准：Piagent v1.38.1，Pi host pin `@earendil-works/pi-coding-agent@1.3.0`。

---

## 1. PIA 在基座里的位置

```
Pi host (agent loop / tools / session)          ← 不改
  └─ @piagent/platform   (governance: profile, guard, MCP approval, context)
       └─ @piagent/personal  (PIA: consent, audit, journal, memory, connectors)  ← 本包
```

PIA **不 fork Pi、不改 platform 判定**，只做加法：

| 我们加的东西 | 怎么加 | 基座对应 |
| --- | --- | --- |
| 6 个钩子处理器 | `host.registerHook(name, fn)` | `runtime/hooks/`（session-start / input / agent-start / tool-call / tool-result / completion） |
| 3 个新 checker | 挂在 `tool_call` 钩子里 | 基座 guard 之后、工具执行之前 |
| 个人工具 | `host.registerTool({id, manifest, invoke})` | `runtime/tools` + capabilities |
| personal 检索 lane | `host.registerLane(name, fn)`（基座暴露时） | Context Engine adaptive planner |
| 状态目录 | `<workspace>/.pi/pa-state/` | 与 `.pi/piagent-state/` 同级、同纪律（本地、不入 git） |

---

## 2. 挂载三步

### 2.1 声明扩展（可提交）

`.pi/settings.json`（与 platform 并列，不覆盖）：

```json
{
  "extensions": {
    "npm:@piagent/platform": "1.38.1",
    "npm:@piagent/personal": "0.1.0-p0"
  }
}
```

### 2.2 扩展入口

Pi 加载扩展时会调用 `activate(pi, options)`：

```js
import activate from '@piagent/personal';

export default async function (pi) {
  const { api, dispose } = await activate(pi, {
    workspaceRoot: process.env.PA_WORKSPACE ?? process.cwd(),
    homeDir: process.env.HOME,            // 机器级：grants / vault
    masterKey: await readKeystoreKey(),    // 必须来自 OS keystore（Keychain/DPAPI/libsecret）
    logger: console
  });
  process.once('SIGINT', () => { void dispose(); });
  return api;
}
```

**硬性要求**：

- `workspaceRoot` 下必须已有 `.pi/pa-profile.json`（先跑 `pa-init`）。缺失时 compose 直接抛 `CONFIG_INVALID`，**不会用默认值继续跑**——未配置的 personal agent 不允许启动。
- `masterKey` 缺失时 vault 不启用（`api.services.vault === null`），需要凭据的 connector 应拒绝注册。
- `masterKey` 绝不能从 workspace、git、环境变量明文派生。

### 2.3 首启自检

```bash
pa-doctor <workspace>                     # 退出码 0 = 可运行
pa-run    <workspace> -p "今天有什么安排"  # 只读链路
pa-grant  <workspace> list                # 看现有授权（空是正常的）
```

`pa-doctor` 的 12 项检查：profile / grants / audit_chain / tools / connectors / memory /
context_lane / journal / budget / delivery / state_paths / machine_home。

`pa-grant` 是授权生命周期的唯一入口：

```bash
pa-grant <ws> issue  --connector gmail --actions mail.send --data-classes D2 --ttl 24
pa-grant <ws> list
pa-grant <ws> revoke --id <grant_id>
```

`issue` 的 digest 从运行时注册表读取，**不接受命令行传入** —— 否则"授权绑定连接器定义"这条纪律就失效了。

---

## 3. 钩子契约（只允许用这 6 个）

| 钩子 | PIA 做什么 | 失败语义 |
| --- | --- | --- |
| `session_start` | 传递（grants 已在 compose 时加载） | 不阻塞 |
| `input` | 把 `untrusted` 标记补到 `turn` 上 | 不阻塞 |
| `agent_start` | 传递（预算在每次工具调用前 reserve） | 不阻塞 |
| `tool_call` | 校验工具已注册、非 R4、doc 不含 D3；未知工具抛 `PolicyError` | **抛异常 = 否决该次调用**（fail-closed） |
| `tool_result` | 只回传 `{ok}`，不落原始内容 | 不阻塞 |
| `completion` | 传递（journal/ledger 已在 loop 内落盘） | 不阻塞（即使抛错也不让 run 失败） |

> 注意：`tool_call` 钩子里的否决是**兜底**。主判定在 `consent.check(action)`，因为只有 action 层知道"这个动作的语义、数据分级、是否出网、来源是否可信"。

---

## 4. 权限语义：`min(mode, grants)`

| 基座 mode（session 级） | 允许的最高风险 | 谁决定的 |
| --- | --- | --- |
| `read-only` | R0 | 基座 `/permission` |
| `workspace-write` | R1 | 基座 `/permission` |
| `full-access` | R2（R3 仍需双确认 + 身份校验） | 基座 `/permission` |

个人授权（grant，机器级、`~/.pi/pa/grants.json`）只能**收窄**，不能放宽：

- grant 覆盖 `action + data_class` 且未过期 → R0/R1 自动放行；
- 无 grant 但动作涉及 D2 → 直接 `deny(data_class_blocked)`；
- R3（支付/删除/代签）**任何 mode + 任何 grant 都不能自动执行**；
- 来源不可信 + 出网 → `deny(tainted_egress)`，确认也不能放行。

排查"为什么它不让我做 X"：`/permission status` 看档位 → `pa-doctor` 看 grants → 审计账本看 `decision.reason`。

---

## 5. 状态布局（所有权纪律照抄基座）

| 路径 | 内容 | 可提交 |
| --- | --- | --- |
| `<ws>/.pi/pa-profile.json` | 策略（persona / autonomy / budget / connectors 白名单 / memory / privacy） | ✅ |
| `<ws>/.pi/pa-state/journal/` | Run/Step checkpoint | ❌ |
| `<ws>/.pi/pa-state/memory/` | facts / episodes | ❌ |
| `<ws>/.pi/pa-state/index/` | personal 检索索引 | ❌ |
| `<ws>/.pi/pa-state/audit/ledger.jsonl` | 追加式哈希链账本 | ❌ |
| `<ws>/.pi/pa-state/delivery/` | 投递计数与摘要队列 | ❌ |
| `~/.pi/pa/grants.json` | 授权决定（仓库不能自我授权） | ❌ |
| `~/.pi/pa/vault.enc` | AES-256-GCM 凭证库 | ❌ |

`.pi/.gitignore` 必须包含 `pa-state/`（`pa-init` 会写）。

---

## 6. 接入一个新连接器（MCP 或 native）

```js
// 1) 一个连接器 = 一组带 manifest 的工具
const connector = {
  id: 'notion',
  kind: 'mcp',
  digest: digestOf(toolManifests),   // 变了就要重新授权
  dataClasses: ['D1', 'D2'],
  tools: [
    {
      manifest: {
        id: 'notion.search',
        connector: 'notion',
        kind: 'mcp',
        risk: 'R0',
        reversible: true,
        data_in: ['D1'],
        data_out: 'D1',
        egress: false,
        idempotent: true,
        cost_hint: { tokens: 300, usd: 0 },
        approval: { default: 'auto' },
        summary: '搜索 Notion'
      },
      async invoke(args, ctx) { /* 通过 MCP client 调用 */ }
    }
  ],
  async healthCheck() { return { ok: true }; }
};
```

规则：

1. **风险只能报高不能报低**：`deriveRisk()` 会把 `egress` 抬到 R2、`reversible:false` 抬到 R2、D2 抬到 R1。
2. R4 工具必须不注册，注册了也不会被调用（registry 双重拦截）。
3. 写操作尽量给 `undo`（`snapshot_restore` / `compensating_action`），因为可撤销能把 R2 降为 R1 的审批体验。
4. 读 D2 的工具需要用户先签发 grant：
   `pa-grant . issue --connector notion --actions notion.search --data-classes D2`
   （digest 由 registry 提供，TTL 受 `profile.tools.standing_grant_max_ttl_h` 夹紧）。

---

## 7. 与基座的生命周期协作

| 场景 | 做法 |
| --- | --- |
| Pi 升级（host 版本变化） | 只依赖 6 个钩子 + `registerTool` + 可选 `registerLane`；升级前跑 `pa-doctor` |
| platform 的 MCP 审批门升级 | PIA 不复制其逻辑；连接器授权是**同构但独立**的文件（`~/.pi/pa/grants.json`），避免双写冲突 |
| 企业模式（Agent Studio） | PIA 的 `budget` 可映射到 Studio 的每日用量；`privacy.telemetry: company` 时禁用 D2 记忆（profile 层已强制） |
| 多设备（P3） | 只同步 `memory/facts.json` 与 `journal` 元数据，不同步原始数据；密钥轮换独立 |

---

## 8. 已知边界（P0 明确不做）

1. **没有主动性调度**：`scheduler.start` 是 no-op（P2），触发器 schema 已冻结。
2. **没有真实 MCP 传输**：三个 P0 连接器是 native + 内存 transport（可注入 `transport` 替换为真 MCP client）。
3. **intent 是规则引擎不是模型**：11 条规则 + 兜底 `assistant.reply`；接 Pi 的模型 loop 后由 loop 决定动作，规则只作为"保守初判"。
4. **多设备同步未实现**（P3）。
5. **vault 需要宿主提供 masterKey**：没有 keystore 时故意不可用，而不是退化成明文。
