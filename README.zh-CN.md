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

## 使用自己的模型

Orbit CLI 既可以使用 Orbit 账号，也可以接入你自己的服务商 API Key。目前支持 OpenRouter、Z.AI、DeepSeek、火山方舟，以及用于 3D 生成的 Replicate。

```sh
orbit providers set openrouter
orbit providers list

orbit generate \
  --mode byok \
  --provider openrouter \
  --workspace "$PWD/my-game" \
  --prompt "制作一个高速霓虹赛车游戏"
```

服务商密钥会保存在操作系统的凭据保险库中。自动化环境请使用 `--key-stdin`，不要将密钥直接写入 Shell 历史记录。

## 图片和 3D

为游戏添加 PNG、JPEG 或 WebP 参考图：

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "使用这个角色和美术方向" \
  --attach /absolute/path/character.png
```

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
