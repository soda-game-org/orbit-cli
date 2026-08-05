# Orbit CLI

简体中文 | [English](README.md)

<p align="center"><strong>Orbit CLI</strong> 是一个开源的本地 AI 游戏开发工具，可在终端或浏览器中运行。</p>

<p align="center">
  在 <a href="https://orbit-arcade.com">Orbit Arcade</a> 创建、游玩和发布游戏。<br />
  如需完整桌面体验，可下载适用于 Windows 和 macOS 的 <a href="https://orbit-arcade.com/orbit-engine">Orbit Engine</a>。
</p>

---

## 快速开始

### 安装 Orbit CLI

Orbit CLI 需要 Node.js 22 或更高版本。

```sh
git clone https://github.com/the-super-engine/orbit-cli.git
cd orbit-cli
npm ci
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

## 选择模型接入方式

Orbit CLI 提供两种模型链路：通过 Orbit OAuth 登录，使用 Orbit Cloud 和 Orbit 计费；或者填写自己的 API Key，接入 OpenRouter、OpenAI、DeepSeek、智谱 BigModel（中国区）、Z.AI（全球区）、火山方舟、Kimi（中国区）或 Kimi（全球区）。3D 生成还支持 Replicate Key。

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

通过已登录的 Orbit Worker 生成 PNG 图片：

```sh
orbit image \
  --workspace "$PWD/my-game" \
  --prompt "一个原创的透明背景霓虹检查点图标" \
  --output assets/images/checkpoint.png
```

如需让游戏开发 Agent 在运行中生成图片，可在 Orbit OAuth 模式下添加 `--images`。图片生成需要明确开启，目前按 Orbit 计费；BYOK 编码任务不会静默切换到 Orbit 计费。

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
- 从 [GitHub Releases](https://github.com/the-super-engine/orbit-cli/releases) 下载版本。

Orbit CLI 由 **SODA GAME** 开发，基于 [MIT License](LICENSE) 开源。
