# Orbit CLI

简体中文 | [English](README.md)

在终端或本地浏览器界面中创建、预览、迭代并发布 HTML 游戏。

Orbit CLI 是 [Orbit Arcade](https://orbit-arcade.com) 生态中的开源开发工具。你可以用自然语言描述想做的游戏，让 Orbit Agent 在本地项目目录中完成开发，随时预览结果、恢复中断的任务、生成 3D 素材，并在准备好后发布游戏。

Orbit CLI 由 **SODA GAME 的 Orbit 团队**制作和维护；我们也是 [Orbit Arcade](https://orbit-arcade.com) 和 [Orbit Engine](https://orbit-arcade.com/orbit-engine) 背后的团队。

## Orbit CLI 在产品体系中的位置

- **[Orbit Arcade](https://orbit-arcade.com)** 是在网页上创建、游玩、分享和发布 Orbit 游戏的平台。
- **[Orbit Engine](https://orbit-arcade.com/orbit-engine)** 是面向 Windows 和 macOS 的完整桌面应用，适合在本地项目中进行可视化游戏开发。
- **Orbit CLI** 是开源的终端和本地 Web CLI，适合偏好命令行、自动化或轻量浏览器界面的开发者。

Orbit CLI 使用与 Orbit 其他产品相同的 Orbit 账号和官方云服务。闭源的 Orbit Engine 桌面应用会单独分发；本仓库只包含 CLI 及其本地 Web 界面。

## 可以用它做什么

- 使用 Orbit Agent 在任意本地工作区中创建或修改游戏。
- 通过 OAuth 使用 Orbit 官方模型，或者接入自己拥有的服务商 API Key。
- 添加 PNG、JPEG 和 WebP 参考图。
- 通过 Orbit 或 Replicate 生成 GLB 3D 素材。
- 在隔离的本地浏览器沙箱中预览游戏。
- 从崩溃或意外中断中恢复，并从持久化检查点续跑。
- 发布前检查生成结果，再将完成的游戏发布到 Orbit Arcade。
- 使用 `orbit web` 打开本地图形界面。

## 快速开始

Orbit CLI 需要 Node.js 22 或更高版本。

```sh
git clone https://github.com/the-super-engine/orbit-cli.git
cd orbit-cli
npm ci
npm link
orbit doctor
```

登录 Orbit 账号并创建第一个游戏：

```sh
orbit auth login
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "制作一个可以反复游玩的手机街机游戏"
```

也可以打开图形化 Web CLI：

```sh
orbit web
```

Web CLI 只在本机的 `127.0.0.1` 上运行，并与终端 CLI 使用相同的工作区、Agent 任务、检查点、模型服务商和发布流程。

## 使用自己的 API Key

Orbit 官方能力通过浏览器 OAuth 登录，因此不需要把 Orbit API Key 复制到本机。你也可以接入自己拥有的服务商 API Key：

| 用途 | 支持的服务商 |
| --- | --- |
| 游戏生成 | OpenRouter、Z.AI、DeepSeek、火山方舟 |
| 3D 生成 | Replicate |

交互式添加服务商：

```sh
orbit providers set openrouter
orbit providers set replicate
orbit providers list
```

API Key 会保存在 macOS 钥匙串、Windows 凭据管理器或 Linux Secret Service 中。自动化环境应通过标准输入传入密钥，避免把密钥留在 Shell 历史记录中：

```sh
orbit providers set openrouter --key-stdin < /secure/path/openrouter-key
```

使用自己的服务商生成游戏：

```sh
orbit generate \
  --mode byok \
  --provider openrouter \
  --workspace "$PWD/my-game" \
  --prompt "制作一个高速霓虹赛车游戏"
```

## 图片和 3D 素材

生成游戏时可以添加一张或多张参考图：

```sh
orbit generate \
  --workspace "$PWD/my-game" \
  --prompt "使用这个角色和美术方向" \
  --attach /absolute/path/character.png \
  --attach /absolute/path/style.webp
```

通过 Orbit 官方服务生成独立的 GLB 文件：

```sh
orbit 3d \
  --mode orbit \
  --workspace "$PWD/my-game" \
  --prompt "一艘带有 PBR 材质的风格化低多边形宇宙飞船" \
  --output assets/models/spacecraft.glb
```

添加 Replicate API Key 后，可以使用 `--mode byok` 通过自己的账号执行 3D 生成。

## 恢复中断的任务

Orbit 会在模型调用和工具执行的边界将 Agent 进度记录到本地。列出任务并根据 ID 续跑：

```sh
orbit runs
orbit resume run_00000000-0000-4000-8000-000000000000
```

如果某个已中断的计费操作或其他非幂等操作无法安全地自动重试，Orbit 会暂停并请求确认，不会静默地重复执行：

```sh
orbit resume run_00000000-0000-4000-8000-000000000000 --retry-unsafe
```

## 发布到 Orbit Arcade

发布始终是一个独立且明确的操作，需要登录 Orbit，并且对应的游戏任务已经完成验证。生成或预览游戏不会自动发布。

```sh
orbit publish run_00000000-0000-4000-8000-000000000000
```

只有在你确认发布后，游戏才会被发送到 [Orbit Arcade](https://orbit-arcade.com)。

## 可选诊断日志

云端诊断默认关闭。需要向 Orbit 服务发送结构化状态和崩溃元数据时，可以主动开启：

```sh
orbit logs enable
orbit logs flush
orbit logs disable
```

云端日志协议不接受提示词、工作区路径、模型消息、工具参数或工具输出。

## 当前支持情况

| 能力 | 终端 CLI | Web CLI |
| --- | --- | --- |
| 本地游戏创建和修改 | 支持 | 支持 |
| PNG/JPEG/WebP 参考图 | 支持 | 支持 |
| GLB 3D 生成 | 支持 | 支持 |
| 崩溃恢复和续跑 | 支持 | 支持 |
| 明确确认后发布到 Orbit Arcade | 支持 | 支持 |
| 文档上传 | 暂不支持 | 暂不支持 |
| GIS 集成 | 暂不支持 | 暂不支持 |

运行 `orbit capabilities` 可以查看当前安装版本实际提供的能力。

## 命令一览

```text
orbit auth login|status|logout
orbit providers list|set|remove|test <provider>
orbit generate --prompt <text> [选项]
orbit resume <run-id> [选项]
orbit 3d --prompt <text> [选项]
orbit runs
orbit capabilities
orbit publish <run-id> [选项]
orbit logs enable|disable|flush
orbit web
orbit doctor
```

使用 `orbit --help` 查看完整参数列表。

## 开发与安全

```sh
npm test
npm run audit:public
npm pack --dry-run
```

Orbit CLI 使用 MIT License。安全边界和漏洞报告方式请参阅 [`SECURITY.md`](SECURITY.md)。

官方专用游戏模板和模型凭据保留在 Orbit 云服务中。本仓库不包含 Orbit Engine 源代码或私有生产基础设施。
