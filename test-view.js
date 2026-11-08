'use strict';

/*
 * 视图渲染测试：真正实例化 RoamView 并调用 render，覆盖：
 * 到期列表、即将到期列表、错误 UI、滚动位置保持。
 *
 * 运行：node test-view.js
 */

const assert = require('assert');
const Module = require('module');
const { createEl } = require('./test-dom.js');

global.window = global;

const DAY = 24 * 60 * 60 * 1000;

/* ---------------- mock obsidian ---------------- */

class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.extension = path.split('.').pop();
    this.stat = { mtime: Date.now(), ctime: Date.now() };
  }
}

class TFolder {
  constructor(path) {
    this.path = path;
  }
}

class Notice {
  constructor(message) {
    this.message = message;
  }
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = (leaf && leaf.app) || { workspace: { getActiveFile: () => null } };
    this.contentEl = createEl('div');
  }
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest || { version: '0.0.0' };
  }
  registerView() {}
  addRibbonIcon() {
    return createEl('div');
  }
  addCommand() {}
  addSettingTab() {}
  addStatusBarItem() {
    return createEl('div');
  }
  registerEvent() {}
  registerInterval() {}
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createEl('div');
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = createEl('div');
  }
}

class SuggestModal {
  constructor(app) {
    this.app = app;
  }
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') {
    return {
      Notice,
      Plugin,
      ItemView,
      PluginSettingTab,
      Modal,
      SuggestModal,
      Setting,
      TFile,
      TFolder,
      Platform: { isMobile: false },
    };
  }
  return originalLoad.apply(this, arguments);
};

/* ---------------- 被测对象 ---------------- */

const PluginClass = require('./main.js');
const RoamView = PluginClass.RoamView;

if (typeof RoamView !== 'function') {
  console.log('  ✗ main.js 未导出 RoamView（无法进行渲染测试）');
  process.exit(1);
}

const VIEW_TYPE = PluginClass.VIEW_TYPE || 'ebbinghaus-roam-view';

/* ---------------- 测试工具 ---------------- */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

function findAllByClass(el, cls, out = []) {
  if (el.classList && el.classList.contains(cls)) out.push(el);
  for (const child of el.children || []) findAllByClass(child, cls, out);
  return out;
}

function dueItem(path) {
  return {
    path,
    state: { stage: 0, reviewCount: 0, nextDue: Date.now() - 1000 },
  };
}

function upcomingItem(path) {
  return {
    path,
    state: { stage: 0, reviewCount: 0, nextDue: Date.now() + DAY },
  };
}

function makePlugin({ due = [], upcoming = [], scope = [] } = {}) {
  return {
    data: {
      settings: {
        paused: false,
        includeAll: true,
        folders: [],
        excludeFolders: [],
        excludeKeywords: [],
        intervals: [1, 2, 4, 7, 15, 30, 60, 120, 240],
        listLimit: 200,
        minDwellSeconds: 30,
      },
      notes: Object.fromEntries(
        scope.map((p) => [p, { stage: 0, reviewCount: 0, nextDue: Date.now() + DAY }])
      ),
    },
    dueList: () => due,
    upcomingList: () => upcoming,
    scopeFiles: () => scope.map((p) => new TFile(p)),
    startRoam: async () => {},
    togglePause: () => {},
    gradePath: () => {},
    openPath: async () => {},
    enrollOne: () => {},
    saveSettingsNow: async () => {},
    refreshUI: () => {},
  };
}

function makeView(plugin) {
  const app = {
    vault: { getMarkdownFiles: () => [] },
    workspace: { getActiveFile: () => null },
  };
  const leaf = { app };
  const view = new RoamView(leaf, plugin);
  leaf.view = view;
  return view;
}

/* ---------------- 用例 ---------------- */

console.log('\n[DOM mock 语义]');

test('createDiv 第二参数传对象会抛 TypeError（复刻 Obsidian）', () => {
  const el = createEl('div');
  assert.throws(() => el.createDiv('er-title', { text: 'x' }), TypeError);
  assert.throws(() => el.createDiv('er-title', { text: 'x' }), /callback is not a function/);
});

test('createDiv 对象首参与回调写法都可用', () => {
  const el = createEl('div');
  const fixed = el.createDiv({ cls: 'er-title', text: 'x' });
  assert.ok(fixed.hasClass('er-title'));
  assert.strictEqual(fixed.textContent, 'x');

  const viaCb = el.createDiv('er-title', (d) => d.setText('y'));
  assert.ok(viaCb.hasClass('er-title'));
  assert.strictEqual(viaCb.textContent, 'y');
});

console.log('\n[面板渲染]');

test('有到期笔记时渲染出对应数量的列表项', () => {
  const scope = ['A/1.md', 'A/2.md', 'A/3.md'];
  const plugin = makePlugin({
    due: scope.map(dueItem),
    upcoming: [upcomingItem('A/4.md')],
    scope,
  });
  const view = makeView(plugin);
  view.renderSafe();

  assert.strictEqual(view._lastError, null, '不应有渲染错误');
  assert.ok(view.contentEl.textContent.includes('漫游复习'), '应有标题');
  const rows = findAllByClass(view.contentEl, 'er-item');
  assert.strictEqual(rows.length, 4, '3 篇到期 + 1 篇接下来');
  assert.ok(findAllByClass(view.contentEl, 'er-list').length >= 1);
  assert.ok(view.contentEl.textContent.includes('到期'));
  assert.ok(view.contentEl.textContent.includes('接下来'));
});

test('没有到期笔记时显示空态与即将到期列表', () => {
  const plugin = makePlugin({
    due: [],
    upcoming: [upcomingItem('A/4.md'), upcomingItem('A/5.md')],
    scope: ['A/4.md', 'A/5.md'],
  });
  const view = makeView(plugin);
  view.renderSafe();

  const text = view.contentEl.textContent;
  assert.ok(text.includes('今天没有到期的笔记'));
  assert.ok(text.includes('即将到期'));
  assert.strictEqual(findAllByClass(view.contentEl, 'er-item').length, 2);
});

test('暂停状态显示提示条', () => {
  const plugin = makePlugin({ due: [dueItem('A/1.md')], scope: ['A/1.md'] });
  plugin.data.settings.paused = true;
  const view = makeView(plugin);
  view.renderSafe();
  assert.ok(view.contentEl.textContent.includes('自动记录已暂停'));
});

test('渲染滚动后保持 scrollTop', () => {
  const plugin = makePlugin({ due: [dueItem('A/1.md')], scope: ['A/1.md'] });
  const view = makeView(plugin);
  view.contentEl.scrollTop = 120;
  view.renderSafe();
  assert.strictEqual(view.contentEl.scrollTop, 120);
});

console.log('\n[错误处理]');

test('renderSafe 捕获异常并显示错误 UI', () => {
  const plugin = makePlugin();
  plugin.dueList = () => {
    throw new Error('boom-render');
  };
  const view = makeView(plugin);

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.throws(() => view.render(), /boom-render/);
    view.renderSafe();
  } finally {
    console.error = originalError;
  }

  assert.ok(view._lastError && view._lastError.message === 'boom-render');
  assert.ok(view.contentEl.textContent.includes('漫游复习面板加载失败'));
  assert.ok(view.contentEl.textContent.includes('boom-render'));
  assert.strictEqual(findAllByClass(view.contentEl, 'er-btn').length, 1, '应有重试按钮');
});

test('重试按钮可重新渲染', () => {
  let shouldThrow = true;
  const plugin = makePlugin({ due: [dueItem('A/1.md')], scope: ['A/1.md'] });
  const realDueList = plugin.dueList;
  plugin.dueList = () => {
    if (shouldThrow) throw new Error('boom-render');
    return realDueList();
  };

  const view = makeView(plugin);
  const originalError = console.error;
  console.error = () => {};
  try {
    view.renderSafe();
  } finally {
    console.error = originalError;
  }
  assert.ok(view.contentEl.textContent.includes('加载失败'));

  shouldThrow = false;
  findAllByClass(view.contentEl, 'er-btn')[0].click();
  assert.ok(view.contentEl.textContent.includes('漫游复习'));
  assert.strictEqual(findAllByClass(view.contentEl, 'er-item').length, 1);
});

test('视图类型与标题正确', () => {
  const view = makeView(makePlugin());
  assert.strictEqual(view.getViewType(), VIEW_TYPE);
  assert.strictEqual(view.getDisplayText(), '漫游复习');
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
