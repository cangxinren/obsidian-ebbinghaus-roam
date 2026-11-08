#!/usr/bin/env node
'use strict';

/*
 * 安卓兼容验证：
 *   1. 插件文件与语法
 *   2. manifest 字段
 *   3. 手机端 API 静态扫描
 *   4. 运行调度逻辑与插件集成测试
 *
 * 运行：node verify.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const PLUGIN_DIR =
  process.env.ROAM_PLUGIN_DIR || __dirname;

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log('  ✓ ' + name);
}

function fail(name, detail) {
  failed++;
  console.log('  ✗ ' + name);
  if (detail) {
    console.log('    ' + String(detail).split('\n').slice(0, 8).join('\n    '));
  }
}

function section(title) {
  console.log('\n[' + title + ']');
}

console.log('Ebbinghaus Roam — 安卓兼容验证');
console.log('插件目录：' + PLUGIN_DIR);

section('文件');
for (const f of ['manifest.json', 'main.js', 'styles.css']) {
  if (fs.existsSync(path.join(PLUGIN_DIR, f))) ok(f + ' 存在');
  else fail(f + ' 缺失');
}

section('语法');
{
  const r = spawnSync(process.execPath, ['--check', path.join(PLUGIN_DIR, 'main.js')], {
    encoding: 'utf8',
  });
  if (r.status === 0) ok('main.js 语法 OK');
  else fail('main.js 语法错误', r.stderr);
}

section('manifest');
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
} catch (e) {
  fail('manifest.json 解析失败', e.message);
}
if (manifest) {
  manifest.id === 'ebbinghaus-roam'
    ? ok('id = ebbinghaus-roam')
    : fail('id 应为 ebbinghaus-roam');
  manifest.isDesktopOnly === false
    ? ok('isDesktopOnly = false（允许安卓）')
    : fail('isDesktopOnly 必须为 false');
  manifest.version ? ok('version = ' + manifest.version) : fail('缺少 version');
  manifest.minAppVersion
    ? ok('minAppVersion = ' + manifest.minAppVersion)
    : fail('缺少 minAppVersion');
}

section('安卓兼容静态扫描');
const main = fs.readFileSync(path.join(PLUGIN_DIR, 'main.js'), 'utf8');
// 去掉注释后再扫描 require，避免把说明文字里的 require 当成真实依赖
const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const badRequires = requires.filter((r) => r !== 'obsidian');

badRequires.length === 0
  ? ok('仅依赖 obsidian，无 Node/Electron 模块')
  : fail('存在非 obsidian 依赖', badRequires.join(', '));

code.includes('Platform.isMobile')
  ? ok('包含 Platform.isMobile 分支')
  : fail('缺少 Platform.isMobile 分支');

/if\s*\(\s*Platform\.isMobile\s*\)/.test(code)
  ? ok('存在移动端条件分支')
  : fail('缺少 Platform.isMobile 条件分支');

/getLeaf\(\s*['"]tab['"]\s*\)/.test(code)
  ? ok('移动端使用 getLeaf("tab")')
  : fail('缺少 getLeaf("tab")');

/SuggestModal/.test(code)
  ? ok('移动端导入使用 SuggestModal')
  : fail('缺少 SuggestModal');

/class\s+BackupFileModal\s+extends\s+SuggestModal/.test(code)
  ? ok('备份选择器已实现')
  : fail('缺少 BackupFileModal');

/const\s+DATA_FILE\s*=\s*['"][^'"]*ebbinghaus-roam-data\.json['"]/.test(code)
  ? ok('数据文件位于库内（可随笔记同步）')
  : fail('缺少库内数据文件常量');

/DATA_FILE\s*=\s*['"]附件\/ebbinghaus-roam-data\.json['"]/.test(code)
  ? ok('数据文件放在附件目录')
  : fail('数据文件应位于附件目录');

/adapter\.write\(\s*DATA_FILE/.test(code)
  ? ok('通过 vault.adapter 写入库内数据文件')
  : fail('缺少 adapter.write(DATA_FILE)');

section('Obsidian DOM 调用');
{
  // createDiv/createSpan 的第二个参数是回调，不是配置对象，传对象会在运行时抛错
  const misuse = [...code.matchAll(/\bcreate(?:Div|Span)\(\s*(['"])[^'"]*\1\s*,\s*\{/g)];
  if (!misuse.length) ok('createDiv/createSpan 未把配置对象当回调');
  else fail('createDiv/createSpan 第二参数必须是回调', misuse.map((m) => m[0]).join('\n'));
}

section('测试');
for (const [name, file] of [
  ['调度逻辑', 'test-scheduler.js'],
  ['插件集成', 'test-plugin.js'],
  ['视图渲染', 'test-view.js'],
]) {
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) {
    const last = (r.stdout || '').trim().split('\n').pop();
    ok(name + ' 测试通过 · ' + last);
  } else {
    fail(name + ' 测试失败', (r.stdout || '') + (r.stderr || ''));
  }
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed) {
  console.log('请先修复失败项，再打包安卓安装包。');
  process.exit(1);
}
console.log('可以运行 package:android 生成安装包。');
