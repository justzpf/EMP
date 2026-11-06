# EchoMusic 插件源

EchoMusic 客户端的插件集合仓库。宿主通过根目录的 `echo-plugins.json` 索引加载各插件目录。

> **AI 开发声明**：本仓库的插件均由 AI vibe coding 开发完成，仅供学习与个人使用。

## 使用

在 EchoMusic 中把本仓库添加为插件源即可，插件源入口为 `echo-plugins.json`。

## 目录结构

```
.
├── echo-plugins.json        # 插件源索引
├── kugou-vip/               # 插件：权益
│   ├── manifest.json        # 插件清单
│   ├── index.js             # 插件逻辑
│   ├── style.css            # 外部样式
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
| `kugou-vip` | 权益领取并升级 |
| `music-downloader` | 音频和歌词保存到本地音乐库 |

## 开发

- 新增插件：新建目录并补齐四件套（`manifest.json` / `index.js` / `style.css` / `icon.svg`），再在 `echo-plugins.json` 中注册。
