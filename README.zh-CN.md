<h1 align="center">Orbit CLI</h1>

<p align="center"><strong>一个在本地运行的游戏开发 Agent，把一句描述变成可玩的浏览器小游戏。</strong></p>

<p align="center">
  <img src="assets/readme/orbit-cli-hero.jpg" alt="真实的 Orbit CLI 欢迎菜单和五张 Orbit Arcade 游戏封面" width="100%" />
</p>

<p align="center">
  开源、本地优先；在终端完成构建、校验、续跑和发布。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@soda_game/orbit-cli"><img src="https://img.shields.io/npm/v/%40soda_game%2Forbit-cli?style=flat-square&amp;logo=npm&amp;label=npm" alt="npm 版本" /></a>
  <a href="https://github.com/soda-game-org/orbit-cli/actions/workflows/ci.yml"><img src="https://github.com/soda-game-org/orbit-cli/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI 状态" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/soda-game-org/orbit-cli?style=flat-square" alt="MIT License" /></a>
  <a href="https://www.npmjs.com/package/@soda_game/orbit-cli"><img src="https://img.shields.io/node/v/%40soda_game%2Forbit-cli?style=flat-square&amp;logo=node.js" alt="Node.js 版本" /></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="https://orbit-arcade.com">在 Orbit Arcade 游玩</a> ·
  <a href="https://github.com/soda-game-org/orbit-cli/releases">版本发布</a> ·
  <a href="https://orbit-arcade.com/orbit-engine">Orbit Engine</a>
</p>

---

## Orbit CLI 能做什么

Orbit CLI 在你的电脑上运行完整的游戏开发循环，同时由你决定模型和生成素材通过哪条链路访问。

| 能力 | 说明 |
| --- | --- |
| Agent 游戏开发 | 规划玩法循环、编写项目、校验可玩结果，并通过工具调用持续完成任务。 |
| 交互式终端或本地 Web CLI | 在同一个终端会话里持续修改，查看实时状态、命令和本地历史；也可以运行 `orbit web` 打开图形界面。 |
| Orbit Cloud 或 BYOK | 使用 Orbit OAuth 登录，或接入受支持的模型服务；密钥保存在操作系统凭据保险库。 |
| 同一次运行生成图片和 3D | 添加参考图，让 Agent 在编写代码的同时按需生成图片或 GLB 素材。 |
| 可续跑、明确发布 | 中断后从检查点安全恢复；只有执行 `orbit publish` 才会发布。 |

## 快速开始

### 安装 Orbit CLI

Orbit CLI 需要 Node.js 22 或更高版本。

```sh
npm install --global @soda_game/orbit-cli
```

如需从源码开发：

```sh
git clone https://github.com/soda-game-org/orbit-cli.git
cd orbit-cli
npm ci --ignore-scripts
npm link
```

检查本地环境：

```sh
orbit doctor
```

也可以直接运行无参数的 `orbit`，打开键盘操作的启动菜单：

```sh
orbit
```

选择 **Create a game** 会进入持续终端会话：默认使用当前目录，可以连续提出修改要求而不退出；工作区、模型和 runtime 始终可见。Agent 运行时只占用一条实时状态行，结束后会收起中间过程，只留下最终结果。其他菜单项可直接进入 Web CLI、本地运行记录、账号登录、服务商列表、诊断和完整命令说明。

在会话中可以直接描述需求，也可以使用可发现的命令面板：

```text
/new ./my-game
/images on
› 制作一个可以反复游玩的手机街机游戏
› 第一局简单一点，并加强得分反馈
/details
/web
```

输入 `/help` 查看所有会话命令；Tab 可补全斜杠命令，方向键可找回历史输入，Agent 忙碌时继续输入的需求会排到下一轮，`/resume` 默认继续最近的可恢复检查点，Ctrl+C 只中断当前运行、不会丢掉整个会话。`orbit generate` 等脚本化命令继续保留稳定的 JSON 输出，兼容自动化调用。

### Project 与 Session

Orbit 把一个本地工作区视为一个 **Project**。同一 Project 可以包含多个相互独立的 **Session**（内部对应 Thread）；每次输入是一轮 **Turn**，每次执行或重试都会形成可恢复的 **Run/Attempt**。新建 Session 会继续使用同一套项目文件，但拥有独立的对话上下文；新建 Project 才会选择另一个工作区。

在终端会话中可使用：

```text
/sessions
/session new 尝试另一种玩法方向
/session <id 或唯一前缀>
/new ./another-game
```

在本地 Web CLI 中，**New task** 会为当前 Game 新建 Session，**New game** 才会选择独立工作区。已有游戏即使进入一个空的新 Task，第一轮仍然按修改现有 Game 处理，不会重新创建或覆盖工作区。旧版 `runs/<id>/checkpoint.json` 和 `events.jsonl` 会留在原位置并按需建立索引；升级不会搬移、删除或重写旧运行历史。

### 创建第一个游戏

登录 Orbit 账号：

```sh
orbit auth login
```

登录会先打开 Orbit 自有授权页面，再沿用现有的 Google OAuth PKCE
流程。随时可以查看 Cade，或打开账号中心与充值页面：

```sh
orbit account
orbit account open
orbit account billing
```

启动菜单和 Web CLI 会显示最新可用的 Cade 余额。低余额只做预警；余额耗尽时，
下一次 Orbit Cloud 模型调用会暂停，但本地检查点不会被删除。BYOK 不受 Orbit
Cade 限制。

然后描述你想制作的游戏：

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "制作一个可以反复游玩的手机街机游戏"
```

如果更喜欢图形界面，可以打开本地 Web CLI：

```sh
orbit web
```

### 构建命令安全说明

Orbit 默认不会运行项目代码。部分生成项目需要在本地安装依赖或执行构建；请先检查工作区，再明确启用：

```sh
orbit resume <run-id> --allow-shell
```

命令范围受到限制，并使用隔离的 HOME 与 npm 缓存，但项目自己的 `build` 脚本仍以当前操作系统用户的文件系统权限运行。`--allow-shell` 表示允许执行生成项目，不是安全沙箱。

## 选择模型接入方式

Orbit CLI 提供两种模型链路：通过 Orbit OAuth 登录，使用 Orbit Cloud 和 Orbit 计费；或者填写自己的 API Key，接入 OpenRouter、OpenAI、DeepSeek、智谱 BigModel（中国区）、Z.AI（全球区）、火山方舟、Kimi（中国区）或 Kimi（全球区）。配置 Replicate Key 后，BYOK 游戏开发 Agent 可以在工作过程中生成图片和 3D 素材。

```sh
orbit providers set openrouter
orbit providers list
orbit providers models openrouter

orbit generate \
  --mode byok \
  --provider openrouter \
  --workspace "$PWD/my-game" \
  --prompt "制作一个高速霓虹赛车游戏"
```

OpenRouter 按模型 ID 选择模型，不使用写死的模型列表；目录命令会列出声明支持工具调用的模型，也可以直接填写其他模型 ID。智谱和 Kimi 的中国区、全球区使用不同接口和不同的本地密钥槽。

服务商密钥和 Orbit 会话都会保存在操作系统的凭据保险库中。Windows 上的大型会话会拆分到多个受保护的 Credential Manager 条目，避免超过单条凭据容量限制；不会回退到明文文件。自动化环境请使用 `--key-stdin`，不要将密钥直接写入 Shell 历史记录。

## 图片和 3D

为游戏添加 PNG、JPEG 或 WebP 参考图：

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "使用这个角色和美术方向" \
  --attach /absolute/path/character.png
```

每个附件 occurrence 都是具有稳定身份的独立 Turn 输入；即使两次输入复用同一份已验证图片字节，也不会被合并成一个输入。所选模型支持视觉时，图片只在有界的 provider 请求中临时投影；text-only 模型使用与该图片身份绑定的结构化 observation。Orbit 不会在启动时把所有图片拼成一段摘要，也不会把图片字节或本机路径写进对话 transcript，更不会跨 provider 转发私有图片上下文。

让游戏开发 Agent 在编写游戏代码的同时规划并生成图片素材：

```sh
orbit generate \
  --mode byok \
  --provider openrouter \
  --workspace "$PWD/my-game" \
  --prompt "制作一个完成度高的霓虹赛车游戏" \
  --images
```

使用 Orbit OAuth 时，同一工具通过认证后的 Orbit Worker 调用并按 Orbit 计费；使用 BYOK 时，通过保存在操作系统凭据保险库中的 Replicate Key 调用，并由用户自己的 Replicate 账户计费。Agent 会判断少量高价值图片是否确实能提高游戏质量，把校验后的 PNG 写入工作区并在最终游戏中实际引用；付费步骤会保留恢复检查点。两条计费链路不会互相静默降级。

`orbit image` 仍作为一个轻量便利命令保留，但 Orbit CLI 的主要工作方式是上面的 coding agent 运行：围绕同一个游戏一起生产代码、图片、3D 模型和其他素材。

通过 Orbit 或自己的 Replicate 账号生成 GLB 素材：

```sh
orbit 3d \
  --mode orbit \
  --workspace "$PWD/my-game" \
  --prompt "一艘风格化低多边形宇宙飞船" \
  --output assets/models/spacecraft.glb
```

## 续跑和发布

Orbit 会将检查点保存在本地，中断后可以继续运行：

```sh
orbit runs
orbit resume <run-id>
```

交互会话中可用 `/sessions` 查看当前 Project 的各个对话历史、用 `/session <id>` 切换，使用 `/runs` 查看最近检查点、用 `/resume [run-id]` 继续运行，并通过 `/details [run-id]` 按需展开已保存的计划和工具时间线；平时完成后只显示最终总结。

游戏完成后，可以发布到 [Orbit Arcade](https://orbit-arcade.com)：

```sh
orbit publish <run-id>
```

上传前，CLI 会读取 Orbit 服务端公开、版本化的发布合约，并校验其 SHA-256。
完成的任务还会在 `.orbit/artifacts/store/` 记录可选的本地商店素材：3:4 封面和
方形图标。开启图片能力时，host 会在游戏验证通过后尝试生成；失败不会把可玩的
游戏改成失败。`orbit publish` 会上传已经存在且校验通过的本地素材，由 Orbit
服务写入 R2。素材缺失（包括纯文本 BYOK）时，服务端仍按原有逻辑异步补全。

发布始终需要明确执行，并要求登录 Orbit 账号。

## 文档

- 运行 `orbit` 打开交互式启动菜单，或运行 `orbit --help` 查看完整命令说明。
- 运行 `orbit capabilities` 查看当前版本支持的功能。
- 阅读[安全策略](SECURITY.md)。
- 阅读[发布完整性策略与历史标签说明](RELEASES.md)。
- 在 [GitHub Releases](https://github.com/soda-game-org/orbit-cli/releases) 查看源码标签与发布说明。

## TypeScript 开发

Orbit CLI 的维护源码、测试、构建工具和发布审计均使用 TypeScript。编译后的 ESM 只在构建和打包时生成到已忽略的 `dist/`；仓库保持源码优先，npm 安装后也不依赖 TypeScript 运行时。

```sh
npm run dev -- --help
npm run typecheck
npm test
npm run build
npm run check
```

`npm run typecheck` 对产品代码执行 strict 检查；`npm test` 通过 `tsx` 直接运行 TypeScript 测试；`npm run check` 还会生成发布产物并审计 npm 包中的实际文件。

Orbit CLI 由 **SODA GAME** 开发，基于 [MIT License](LICENSE) 开源。
