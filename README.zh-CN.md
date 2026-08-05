<p align="center">
  <img src="assets/readme/orbit-cli-hero.jpg" alt="一条终端命令生成出一组 Orbit Arcade 小游戏" width="100%" />
</p>

<h1 align="center">Orbit CLI</h1>

<p align="center"><strong>在终端写下一句话，把它变成可以立即游玩的街机小游戏。</strong></p>

<p align="center">
  一个开源、本地优先的 AI 游戏开发 Agent，用于构建、测试、续跑和发布浏览器游戏。
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
| 终端或本地 Web CLI | 使用命令行快速工作，也可以运行 `orbit web` 打开图形界面。 |
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

### 创建第一个游戏

登录 Orbit 账号：

```sh
orbit auth login
```

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

服务商密钥会保存在操作系统的凭据保险库中。自动化环境请使用 `--key-stdin`，不要将密钥直接写入 Shell 历史记录。

## 图片和 3D

为游戏添加 PNG、JPEG 或 WebP 参考图：

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "使用这个角色和美术方向" \
  --attach /absolute/path/character.png
```

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

游戏完成后，可以发布到 [Orbit Arcade](https://orbit-arcade.com)：

```sh
orbit publish <run-id>
```

发布始终需要明确执行，并要求登录 Orbit 账号。

## 文档

- 运行 `orbit --help` 查看完整命令说明。
- 运行 `orbit capabilities` 查看当前版本支持的功能。
- 阅读[安全策略](SECURITY.md)。
- 阅读[发布完整性策略与历史标签说明](RELEASES.md)。
- 在 [GitHub Releases](https://github.com/soda-game-org/orbit-cli/releases) 查看源码标签与发布说明。

Orbit CLI 由 **SODA GAME** 开发，基于 [MIT License](LICENSE) 开源。
