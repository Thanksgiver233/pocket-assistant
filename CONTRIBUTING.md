# 贡献指南

感谢你愿意参与。这个项目有一点特殊：**它的价值不在功能数量，而在几条不能被破坏的
不变量。** 所以贡献流程围绕"保护不变量"设计，而不是围绕"加功能"设计。

## 环境准备

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/personal-agent.git
cd personal-agent/packages/personal

node --test "test/**/*.test.mjs"   # 必须全绿（当前 254 条）
node test/selfcheck.mjs            # 6/6
```

要求：Node ≥ 22.19，零运行时依赖——**不要添加 npm 依赖**，这是刻意的设计
（供应链面 = 攻击面）。

## 三条硬规矩

### 1. 动治理代码必须带测试

以下文件里的每一行行为变化，都需要一条会红的测试：

| 文件 | 不变量 |
| --- | --- |
| `src/services/consent.mjs` | 裁决顺序、fail-closed、grant 收窄语义 |
| `src/runtime/loop-adapter.mjs` | 决策→记账→预算→钩子→调用的顺序 |
| `src/services/audit.mjs` | 哈希链可验证、外部锚点 |
| `src/server/http-server.mjs` | 鉴权、D2 脱敏、无策略逻辑渗入 |

"我手动试过了，没问题"不构成依据。

### 2. fail-closed 不可协商

遇到未知、过期、歧义、缺字段，正确的行为永远是拒绝或要求确认。
任何把"静默放行"当作修复手段的 PR 都会被拒——即使它修的 bug 是真的。

### 3. 测试与实现冲突时，先问设计

对照 `docs/04`（设计）与 `docs/06`（契约）：如果实现符合设计，改测试；
如果实现违背设计，改实现。最坏的选择是"两边都改到测试变绿为止"。

## 提交规范

- 分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
- 提交信息：一行中文说明 + 必要时的动机（为什么改，而不只是改了什么）
- **换行统一 LF**（Windows 下用编辑器配置或 `.gitattributes`，已有）
- 打包产物（`dist/`、`*.exe`、`*.apk`）永远不入库，`.gitignore` 已覆盖

## 本地验证清单

提交前跑一遍，缺一不可：

```bash
cd packages/personal
node --test "test/**/*.test.mjs"        # 全绿
node test/selfcheck.mjs                  # 6/6

cd ../.. 
node deploy/budget-check.mjs             # 改了 deploy/ 才需要

cd apps/desktop
npm run dist:dir                         # 改了桌面壳才需要
```

## 需要帮忙的方向（按性价比排序）

1. **连接器失败模式**：超时、限流、部分成功的测试与处理（当前只有"抛错=失败"）
2. **playbook 提取**（docs/10 D3）：从审批 diff 固化可复用做法
3. **记忆体检周报**（D4）：生成器 + 导出
4. **语音速记**：浏览器 Web Speech API 先行，服务端 ASR 后补
5. **文档**：`docs/` 里任何读不通的段落，改了直接提 PR

## 行为准则

见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。简言之：对事不对人，
安全讨论以证据为准，不嘲讽"这也要防？"——是的，这也要防。
