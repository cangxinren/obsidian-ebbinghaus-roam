#!/usr/bin/env node
'use strict';

/*
 * 生成安卓 Obsidian 安装包：
 *   dist/ebbinghaus-roam/
 *   dist/ebbinghaus-roam-<version>.zip
 *   dist/安卓安装说明.md
 *
 * 不打包 data.json，避免把个人复习进度带进安装包。
 *
 * 运行：node build.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const PLUGIN_DIR =
  process.env.ROAM_PLUGIN_DIR || __dirname;
const distRoot = path.join(ROOT, 'dist');
const pkgDir = path.join(distRoot, 'ebbinghaus-roam');
const FILES = ['manifest.json', 'main.js', 'styles.css', 'package.json'];

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error('读取 manifest.json 失败：' + e.message);
  process.exit(1);
}

fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(pkgDir, { recursive: true });

for (const f of FILES) {
  const src = path.join(PLUGIN_DIR, f);
  if (!fs.existsSync(src)) {
    console.error('缺少文件：' + src);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(pkgDir, f));
}

const zipName = `ebbinghaus-roam-${manifest.version}.zip`;
const zipPath = path.join(distRoot, zipName);
const zr = spawnSync('zip', ['-r', zipName, 'ebbinghaus-roam'], {
  cwd: distRoot,
  encoding: 'utf8',
});
if (zr.status !== 0) {
  console.error('zip 打包失败：' + (zr.stderr || zr.stdout));
  process.exit(1);
}

const readme = `# Ebbinghaus Roam 安卓安装说明

版本：${manifest.version}

## 安装包内容

解压 \`${zipName}\`，得到 \`ebbinghaus-roam/\`：

- manifest.json
- main.js
- styles.css
- package.json

安装包**不包含** data.json，不会覆盖你的复习进度。

## 方式一：remotely-save 自动同步

1. 桌面端 Obsidian → remotely-save 设置，确认同步范围包含 \`.obsidian\`（配置文件夹/插件）。
2. 手动触发一次同步。
3. 手机端 Obsidian 打开同一个库，执行 remotely-save 拉取。
4. 确认手机 vault 中出现 \`.obsidian/plugins/ebbinghaus-roam/\`。

## 方式二：手动放置（兜底）

1. 把 \`${zipName}\` 传到手机（数据线、网盘、聊天工具均可）。
2. 解压得到 \`ebbinghaus-roam/\` 文件夹。
3. 复制到手机 vault 的 \`.obsidian/plugins/\` 下，最终路径为：
   \`.obsidian/plugins/ebbinghaus-roam/manifest.json\`
4. 完全退出并重新打开 Obsidian。

> Android 11+ 若无法直接访问 \`Android/data/md.obsidian\`，可先把 zip 放进 vault 根目录，
> 在手机文件管理器里解压，再把文件夹移动到 \`.obsidian/plugins/\`。

## 启用

Obsidian → 设置 → 社区插件 → 关闭受限模式 → 刷新 → 启用「Ebbinghaus Roam 漫游复习」。

要求 Obsidian 版本 ≥ ${manifest.minAppVersion}。

## 手机端使用

- 左键点左侧书本图标：打开下一篇到期笔记。
- 长按 / 右键：打开复习面板。
- 设置页可修改文件夹范围、曲线、停留阈值。
- 导出备份会写入**附件目录**的 \`附件/ebbinghaus-roam-YYYYMMDD.json\`。
- 导入会从附件目录的 \`ebbinghaus-roam-*.json\` 中选择（兼容旧版放在库根目录的备份）。

## 注意

- 插件只读写自己的数据文件，不修改笔记内容或 frontmatter。
- 复习进度保存在**附件目录**的 \`附件/ebbinghaus-roam-data.json\`，随 remotely-save 同步到手机。
- 进度实时写入，无需导入导出：本端每次评分/自动晋级都会立即写文件；另一端同步过来后插件自动读入并按更新时间逐条合并。
- 首次运行会把插件目录的旧 data.json 自动迁移到附件目录；若附件目录不存在会自动创建。
- 如果出现 \`*.sync-conflict-*.json\`，保留最新的一份并重命名为 \`ebbinghaus-roam-data.json\`。
- 首次在手机端启用会扫描全库并写入记录，数千篇时可能停顿几秒，属正常。
`;

fs.writeFileSync(path.join(distRoot, '安卓安装说明.md'), readme, 'utf8');

console.log('已生成：');
console.log('  目录：' + pkgDir);
console.log('  压缩包：' + zipPath);
console.log('  说明：' + path.join(distRoot, '安卓安装说明.md'));
console.log('\n安装包内容：' + FILES.join(', '));
console.log('不包含 data.json（个人复习进度）。');
