# Ebbinghaus Roam 漫游复习

[English](#english) · [安装](#安装) · [使用](#使用) · [手机与双端同步](#手机与双端同步) · [开发](#开发)

Obsidian 插件：按艾宾浩斯遗忘曲线（或自定义间隔），对选定文件夹里的**整篇笔记**做「打开即复习」的漫游调度。

不是抽认卡、不切分知识点、不改你的笔记。插件只记录每篇笔记的复习档位与下次到期时间，到点后你打开它、停留片刻，就自动晋级。

- 复习范围：全库，或只勾选某几个文件夹（支持排除文件夹与关键词）
- 曲线：艾宾浩斯经典 / 紧凑 / 宽松 / 自定义天数
- 首次纳入：按笔记最后修改时间把第一轮均匀铺到未来 N 天，越旧越先到期
- 漫游：按逾期时间打开下一篇到期笔记，也可随机抽一篇
- 自动晋级：打开到期笔记并停留满阈值（默认 30 秒）即记为「记得」
- 手动评分：面板里「记得 / 模糊 / 忘了」
- 桌面与安卓通用：`isDesktopOnly: false`，单文件 `main.js`，无 Node 依赖
- 进度实时写入库内文件，配合 remotely-save 可双端自动合并，无需导入导出

## 安装

### 手动安装（当前方式）

1. 下载本仓库（或 Releases 里的 `ebbinghaus-roam-<version>.zip`）。
2. 把 `manifest.json`、`main.js`、`styles.css` 放进你的库：

   ```
   <你的库>/.obsidian/plugins/ebbinghaus-roam/
   ```

3. Obsidian → 设置 → 第三方插件 → 关闭受限模式 → 刷新 → 启用「Ebbinghaus Roam 漫游复习」。

要求 Obsidian ≥ 1.5.0。

安卓端的安装与同步细节见 [docs/安卓安装与验证.md](docs/安卓安装与验证.md)。

## 使用

- 点击左侧书本图标：直接打开下一篇到期笔记。
- 长按 / 右键书本图标（或命令面板「漫游复习：打开复习面板」）：打开面板，查看到期队列、暂停、手动评分。
- 命令面板还提供：开始漫游、随机漫游、标记记得/模糊/忘了、暂停或恢复。
- 打开到期笔记并停留满阈值后自动晋级并提示下次时间。

## 设置要点

| 设置 | 说明 |
| --- | --- |
| 复习范围 | 全库，或勾选文件夹；排除文件夹与关键词默认排除归档、模板、附件 |
| 曲线 | 预设或自定义天数（逗号分隔，自动去重升序） |
| 首次铺开 | 未来 N 天内按天分桶，首日即有一批到期 |
| 停留阈值 | 0 表示打开即算；默认 30 秒 |
| 每日上限 | 每次漫游最多展示的到期篇数 |
| 自动纳入 | 范围内新建笔记自动加入，1 天后到期 |

## 数据与双端同步

- 复习进度保存在 **`附件/ebbinghaus-roam-data.json`**（附件目录不存在会自动创建）。
- 本端每次评分、自动晋级、改设置都会在 1 秒内写入该文件。
- 另一端通过 remotely-save 等工具拉取后，插件会监听文件变化并自动合并：
  - 逐条比较每条记录的 `updatedAt`，新者胜；
  - `lastOpen` 取两端较大值；
  - 设置按 `settingsUpdatedAt` 取新；
  - 本地有更新记录时自动回写一次，使两端收敛。
- 另有 20 秒轮询兜底，防止某些平台不触发文件变更事件。
- 插件目录的 `data.json` 只用于旧版本数据迁移，不再写入。
- 「导出 / 导入」保留，仅作手动备份与换库迁移，日常不需要。
- 插件**只读写自己的数据文件**，不修改笔记内容或 frontmatter。

两端同时离线修改同一篇笔记时，按 `updatedAt` 取新的一侧；若同步工具生成了 `*.sync-conflict-*.json`，保留较新的一份并改名为 `附件/ebbinghaus-roam-data.json`。

## 开发

```bash
node verify.js          # 语法 + manifest + 移动端 API 扫描 + 两套测试
npm test                # 仅跑测试（调度 26 项、集成 30 项）
npm run build           # 生成 dist/ebbinghaus-roam/<files> 与 zip
```

也可以按 `Ctrl+Shift+B` 运行默认任务 `verify`（VSCode 配置见 `.vscode/`）。

```
main.js              插件全部逻辑（调度 + 视图 + 设置，单文件便于安卓加载）
manifest.json        Obsidian 插件清单
styles.css           面板与设置样式
verify.js            静态检查 + 测试入口
build.js             打包安装包
test-scheduler.js    纯调度逻辑测试
test-plugin.js       模拟 Obsidian 环境的集成测试
docs/                安卓安装与验证说明
```

插件只在运行时 `require('obsidian')`，不依赖 `fs`、`path`、Electron 等桌面模块。

## English

**Ebbinghaus Roam** is an Obsidian plugin that reviews *whole notes* on a forgetting curve. Pick folders (or the whole vault), and the plugin schedules each note by when you last opened it; opening a due note for a few seconds advances it. Notes are never modified — progress lives in `附件/ebbinghaus-roam-data.json`, which can be synced between desktop and Android with tools such as remotely-save and is merged per note by `updatedAt`. See [docs/安卓安装与验证.md](docs/安卓安装与验证.md) for mobile setup.

## License

[MIT](LICENSE)
