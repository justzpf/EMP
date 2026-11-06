# EchoMusic 插件源

EchoMusic 客户端的插件集合仓库。宿主通过根目录的 `echo-plugins.json` 索引加载各插件目录。

> **AI 开发声明**：本仓库的插件均由 AI 辅助开发完成，代码经人工复核后合入，仅供学习与个人使用。

## 使用

在 EchoMusic 中把本仓库添加为插件源即可，插件源入口为 `echo-plugins.json`。

## 目录结构

```
.
├── echo-plugins.json        # 插件源索引（唯一入口清单）
├── kugou-vip/               # 插件：每日权益领取
│   ├── manifest.json        # 插件清单（id / 入口 / 图标 / 能力声明）
│   ├── index.js             # 插件逻辑（单文件 ESM）
│   ├── style.css            # 外部样式（供参考，实际生效样式经运行时注入）
│   └── icon.svg             # 插件图标
└── music-downloader/        # 插件：音频保存
    ├── manifest.json
    ├── index.js
    ├── style.css
    └── icon.svg
```

每个插件目录的结构一致：`manifest.json` + `index.js` + `style.css` + `icon.svg`。

## 插件列表

| 插件 | 说明 |
|------|------|
| `kugou-vip` | 自动领取每日权益并升级 |
| `music-downloader` | 将播放中的音频保存到本地音乐库 |

## 开发

- 新增插件：新建目录并补齐四件套（`manifest.json` / `index.js` / `style.css` / `icon.svg`），再在 `echo-plugins.json` 中注册。
- 详细开发约定见 [AGENTS.md](./AGENTS.md)。
