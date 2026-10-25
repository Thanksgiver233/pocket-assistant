<div align="center">

# 随身 · Pocket Assistant

**一个跑在你自己机器上的个人助理——更敢交出去的那种。**

![CI](https://github.com/YOUR_GITHUB_USERNAME/personal-agent/actions/workflows/build.yml/badge.svg)

![tests](https://img.shields.io/badge/tests-254%20passing-2dd4bf)

![license](https://img.shields.io/badge/license-MIT-green)

![deps](https://img.shields.io/badge/runtime%20deps-0-blue)

![platform](https://img.shields.io/badge/platform-Web%20%7C%20Windows%20%7C%20Android-9aa8bb)

</div>

---

## 简介

「随身」是一个运行在你自己机器上的个人助理。它不追求"更强的模型"，而是回答一个更难的问题：凭什么把权限交给一个 AI？

它的每一个动作都先经过十三层裁决——高风险先停下来问你，做完给你一张可撤销的小票：读了什么数据、用了哪个连接器、花了多少钱、怎么撤销，一目了然。主动推送受"打扰预算"约束，每日配额用完即静默，绝不因为"重要"而破例。记忆分层存储，可查看、可删除、可一键导出带走——你的数据是你的，不是训练语料，也不是锁定手段。

功能上覆盖三条主线：自然语言改日程与智能提醒、随手记与自动成稿的工作日记、有节制的灵感建议。内核是零依赖的 Node 模块，Web、Windows、Android 三端同构；单用户一年总成本约 263 元，跑在一台 68 元的轻量服务器上。

一句话：**它不是更强的助理，是更敢交出去的助理。**

---

## 和成熟产品比，差在哪、强在哪

| 维度            | 云端 personal agent | 随身                                  |
| ------------- | ----------------- | ----------------------------------- |
| 执行环境          | 厂商云里的虚拟机          | **你自己的机器**（本机 / 68 元/年的轻量服务器）       |
| 权限            | 平台代持凭证，黑箱审批       | **动作级 grant：可签发、可撤销、带 TTL、绑定连接器指纹** |
| 一次动作能否说清"为什么" | 否                 | **是：权限小票**（读了什么 / 判词 / 花费 / 撤销入口）   |
| 主动推送          | 产品侧控制，越多越好        | **用户设定配额，用完即静默**                    |
| 记忆            | 锁定在平台             | **可查看、可删除、可导出 Markdown/JSON 带走**    |
| 花费            | 含在订阅里，不可见         | **每个动作实时计费，超支前降级**                  |
| 断网            | 不可用               | **本地优先：记录、提醒、回答照常**                 |
| 月成本           | ¥150–300/月        | **≈ ¥10/月**（机器摊销 + 模型按量）            |

---

## 功能

### 三条主线

| 主线        | 一句话                    | 现状             |
| --------- | ---------------------- | -------------- |
| 生活安排与智能提醒 | "把周会挪到周五"，冲突先问、改完可撤    | ✅              |
| 工作日记与自动整理 | 随手记 1 秒落盘，晚上自动成三段式草稿   | ✅              |
| 主动灵感与建议   | 每条必须回答"为什么是现在 / 为什么是你" | ✅ 候选引擎，推送通道 P1 |

### 五个差异点

- **权限小票** —— 每次对外动作生成人可读凭据：读了什么数据、用了哪个连接器、判词、花费、60 秒撤销窗口
- **打扰预算** —— 主动推送按 `价值 × 时效 − 打扰成本` 过闸，配额用完即静默，深夜只放行到点提醒
- **接管即教学** —— 你改过一次的草稿会固化为 playbook，同类任务第二次少问一半（P1）
- **记忆体检** —— 每周"我记住了什么"清单 + 置信度标注 + 一键删除（P1）
- **可携带记忆** —— 一键导出 Markdown/JSON，D3 永不入库，反锁定

### 治理内核（这个项目的真正卖点）

- 13 条裁决顺序：`deny` 优先于 `confirm` 优先于 `allow`，污点出网**不可确认**
- 三档权限模式 × 常驻授权取交集：`min(mode, grants)`，谁也放宽不了谁
- 审计哈希链 + 外部锚点：改一条、删尾部都能被发现
- 预算三档（turn / day / kind），审批通过后一次性放行，不漏账
- 仓库不能给自己发授权：机器级状态（grants/vault）落在工作区内直接拒绝启动

---

## 三端

| 端           | 形态                    | 说明                                   |
| ----------- | --------------------- | ------------------------------------ |
| **Web**     | 单文件 HTML，零构建          | `pa-serve` 起本地服务；深色控制台 UI            |
| **Windows** | Electron 便携版          | 内嵌同一套 Node 服务，数据在 `%APPDATA%`，令牌自动注入 |
| **Android** | Capacitor WebView 客户端 | 连接你自建的服务器，`www` 与 Web 版同源同构          |

CI 在每次 push 时跑 254 条测试并产出 exe 与 APK（见 `.github/workflows/build.yml`）。

---

## 快速开始

### Web（1 分钟）

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/personal-agent.git
cd personal-agent/packages/personal

node bin/pa-init.mjs ../.pa-ws
PA_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))") \
  node bin/pa-serve.mjs ../.pa-ws --home ../.pa-home --print-token
# 浏览器打开 http://127.0.0.1:8787，粘贴令牌
```

### Windows 桌面版

```bash
cd apps/desktop
npm install
npm run dist:dir        # 产物：dist/win-unpacked/随身.exe
```

### 服务器部署（阿里云 300 元内）

见 [`docs/11-阿里云部署与预算方案.md`](docs/11-阿里云部署与预算方案.md)：263.2 元/年、技术上线 35 分钟、一键脚本 `deploy/bootstrap.sh`。

### 可选：接入大模型

```bash
# 任意 OpenAI 兼容端点；不配置则使用内置离线回答
PA_LLM_API_KEY=sk-xxx PA_LLM_MODEL=qwen3.8-flash node bin/pa-serve.mjs ...
```

---

## 安全模型

一句话：**默认拒绝，顺序即安全，证据先于执行。**

```
deny（污点出网 / D3 / 超模式）  →  直接终止，不换工具重试
confirm（首次写入 / 出网 / R2）  →  停下来问你，绝不自动批准
allow（有 grant / 模式内 R0）    →  执行，且审计先于结果落盘
```

- 工具不能比审批更强：registry 在调用时二次校验
- `resume` 会重新跑一遍 consent：授权撤销后，批准也执行不了
- D2（高敏）产物在任何出口都被脱敏，journal 只存摘要
- 全部设计条目 → 代码位置 → 测试用例的对照见 [`docs/08-架构方案与符合性核验.md`](docs/08-架构方案与符合性核验.md)

---

## 项目结构

```
packages/personal/   内核：consent / audit / budget / journal / connectors / http-server
apps/desktop/        Electron 桌面版（CJS 主进程 + 内嵌 ESM 服务）
apps/mobile/         Capacitor 安卓工程
deploy/              阿里云部署工件 + 预算校验器
docs/                00 摘要 → 11 部署方案（12 篇）
reviews/             独立源码评审
research/            一手竞品调研（逐条来源标注）
```

---

## 路线图

| 阶段   | 内容                          | 状态 |
| ---- | --------------------------- | -- |
| P0   | 治理内核 + 三连接器 + CLI + Web     | ✅  |
| P0.5 | 提醒 / 日记 / 灵感 + 桌面 + 安卓      | ✅  |
| P1   | 模型规划接入、接管即教学、记忆体检、真实 MCP 传输 | 🚧 |
| P2   | 主动性调度（trigger 已冻结 schema）   | ⏳  |
| P3   | 多设备同步                       | ⏳  |

---

## 文档

| 想了解        | 看                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 产品是什么、凭什么赢 | [`docs/10-产品差异化设计.md`](docs/10-产品差异化设计.md)                                                                |
| 架构与安全设计    | [`docs/04-PersonalAgent框架设计.md`](docs/04-PersonalAgent框架设计.md)、[`docs/08`](docs/08-架构方案与符合性核验.md)         |
| 接口契约       | [`docs/06-附录-接口契约与Schema.md`](docs/06-附录-接口契约与Schema.md)                                                  |
| 部署与预算      | [`docs/11-阿里云部署与预算方案.md`](docs/11-阿里云部署与预算方案.md)                                                          |
| 竞品调研       | [`research/`](research/)、[`docs/01`](docs/01-产品解剖-Muse-GrokBot-Dots.md)、[`docs/02`](docs/02-横向对比与设计取舍.md) |

---

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。两条硬规矩：

1. **动治理代码必须带测试**——这里测的不是功能，是不变量
2. **fail-closed 不可协商**——未知、过期、歧义一律拒绝，"再确认一次"不是安全边界

## License

[MIT](LICENSE)
