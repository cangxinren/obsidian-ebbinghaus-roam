'use strict';

/*
 * 在模拟的 Obsidian 环境里加载 main.js，验证：
 * 插件加载、首次铺开、打开自动晋级、手动评分、重命名迁移、新建纳入、队列。
 * 运行：node test-plugin.js
 */

const assert = require('assert');
const Module = require('module');

global.window = global;

const DAY = 24 * 60 * 60 * 1000;
const DATA_PATH = '附件/ebbinghaus-roam-data.json';
const notices = [];
const saveCalls = { count: 0 };

/* ---------------- mock obsidian ---------------- */

class TAbstractFile {
  constructor(path) {
    this.path = path;
  }
}

class TFile extends TAbstractFile {
  constructor(path, mtime = Date.now()) {
    super(path);
    this.name = path.split('/').pop();
    this.extension = path.split('.').pop();
    this.stat = { mtime, ctime: mtime };
  }
}

class TFolder extends TAbstractFile {
  constructor(path) {
    super(path);
    this.children = [];
  }
}

function makeEl() {
  return {
    classList: { toggle() {}, add() {}, remove() {} },
    addClass() {},
    addEventListener() {},
    textContent: '',
    title: '',
  };
}

class Notice {
  constructor(message, timeout) {
    this.message = message;
    this.timeout = timeout;
    notices.push(message);
  }
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest || { version: '1.0.0' };
    this._data = null;
    this._handlers = [];
    this._intervals = [];
    this._commands = [];
    this._ribbon = [];
    this._settingTabs = [];
    this._statusBars = [];
  }
  async loadData() {
    return this._data;
  }
  async saveData(d) {
    this._data = JSON.parse(JSON.stringify(d));
    saveCalls.count++;
  }
  registerView() {}
  addRibbonIcon(icon, title, cb) {
    const el = makeEl();
    this._ribbon.push({ icon, title, cb, el });
    return el;
  }
  addCommand(c) {
    this._commands.push(c);
  }
  addSettingTab(t) {
    this._settingTabs.push(t);
  }
  addStatusBarItem() {
    const el = makeEl();
    this._statusBars.push(el);
    return el;
  }
  registerEvent(e) {
    this._handlers.push(e);
  }
  registerInterval(id) {
    this._intervals.push(id);
  }
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf && leaf.app;
    this.contentEl = makeEl();
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl();
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = makeEl();
    this.titleEl = { setText() {} };
  }
  open() {}
  close() {}
}

class SuggestModal {
  constructor(app) {
    this.app = app;
  }
  setPlaceholder() {}
  open() {}
  close() {}
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
  }
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  setClass() { return this; }
  addToggle(cb) { cb({ setValue() { return this; }, onChange() { return this; } }); return this; }
  addText(cb) { cb({ setValue() { return this; }, onChange() { return this; }, inputEl: makeEl() }); return this; }
  addTextArea(cb) { cb({ setValue() { return this; }, onChange() { return this; }, inputEl: makeEl() }); return this; }
  addDropdown(cb) { cb({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
  addButton(cb) { cb({ setButtonText() { return this; }, setCta() { return this; }, onClick() { return this; }, buttonEl: makeEl() }); return this; }
}

const mockObsidian = {
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

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return mockObsidian;
  return originalLoad.apply(this, arguments);
};

/* ---------------- mock app ---------------- */

const vaultEvents = {};
const workspaceEvents = {};
let layoutReadyCb = null;
let activeFile = null;

const files = [];
const adapterStore = {};
const adapterDirs = new Set();
let adapterWriteCalls = 0;
const vault = {
  adapter: {
    async exists(p) {
      return Object.prototype.hasOwnProperty.call(adapterStore, p) || adapterDirs.has(p);
    },
    async read(p) {
      return adapterStore[p];
    },
    async write(p, data) {
      adapterStore[p] = data;
      adapterWriteCalls++;
    },
    async mkdir(p) {
      adapterDirs.add(p);
    },
  },
  getMarkdownFiles() {
    return files.filter((f) => f instanceof TFile && f.extension === 'md');
  },
  getFiles() {
    return files.filter((f) => f instanceof TFile);
  },
  getAllLoadedFiles() {
    return files.slice();
  },
  getAbstractFileByPath(p) {
    return files.find((f) => f.path === p) || null;
  },
  async create(p, data) {
    const f = new TFile(p);
    files.push(f);
    return f;
  },
  async modify() {},
  async createFolder(p) {
    adapterDirs.add(p);
  },
  on(evt, cb) {
    vaultEvents[evt] = cb;
    return { evt, cb };
  },
};

const workspace = {
  on(evt, cb) {
    workspaceEvents[evt] = cb;
    return { evt, cb };
  },
  onLayoutReady(cb) {
    layoutReadyCb = cb;
  },
  getActiveFile() {
    return activeFile;
  },
  getLeavesOfType() {
    return [];
  },
  getLeaf() {
    return {
      openFile: async (f) => {
        activeFile = f;
        if (workspaceEvents['file-open']) workspaceEvents['file-open'](f);
      },
    };
  },
  getRightLeaf() {
    return null;
  },
  revealLeaf() {},
};

const app = { vault, workspace };

/* ---------------- 加载插件 ---------------- */

const PluginClass = require('./main.js');

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
async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

(async () => {
  const now = Date.now();

  // 10 篇范围内笔记 + 2 篇归档 + 1 个文件夹 + 1 个附件
  for (let i = 1; i <= 10; i++) {
    files.push(new TFile(`A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note${i}.md`, now - i * 10 * DAY));
  }
  files.push(new TFile('Archives（归档，短期无用）/old1.md', now - 200 * DAY));
  files.push(new TFile('Archives（归档，短期无用）/old2.md', now - 300 * DAY));
  files.push(new TFile('附件/图.png', now));
  files.push(new TFolder('A-Areas（板块知识点笔记、总结类、本阶段长期有用）'));
  files.push(new TFolder('Archives（归档，短期无用）'));

  const plugin = new PluginClass(app, { version: '1.0.0' });

  console.log('\n[插件加载]');
  await asyncTest('onload 不报错并注册命令/视图', async () => {
    await plugin.onload();
    // 测试环境使用全库模式，避免 2027 预设的固定文件夹路径影响其余用例
    plugin._needsExamPreset = false;
    plugin._needsRescheduleMigration = false;
    plugin.data.settings.includeAll = true;
    plugin.data.settings.folders = [];
    // 从旧位置载入时必须保留“待迁移写入”标记，否则库内文件永远不会生成
    assert.strictEqual(plugin._dirty, true, '载入后应等待写入库内数据文件');
    assert.ok(plugin._commands.length >= 7, '命令数量不足');
    assert.ok(plugin._settingTabs.length === 1);
    assert.ok(plugin._ribbon.length === 1);
  });

  await asyncTest('onLayoutReady 后首次铺开只纳入范围内笔记', async () => {
    assert.strictEqual(typeof layoutReadyCb, 'function');
    layoutReadyCb();
    const keys = Object.keys(plugin.data.notes);
    assert.strictEqual(keys.length, 10);
    assert.ok(!keys.some((k) => k.startsWith('Archives/')));
    assert.ok(!keys.some((k) => k.endsWith('.png')));
  });

  await asyncTest('铺开后的到期时间落在未来 30 天附近', async () => {
    const dues = Object.values(plugin.data.notes).map((x) => x.nextDue);
    assert.ok(Math.min(...dues) >= now);
    assert.ok(Math.max(...dues) <= now + 31 * DAY);
  });

  console.log('\n[打开自动晋级]');
  const targetPath = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note1.md';
  plugin.data.settings.minDwellSeconds = 0;
  plugin.data.settings.autoAdvance = true;
  plugin.data.notes[targetPath].nextDue = Date.now() - 1000;
  plugin.data.notes[targetPath].stage = 0;
  activeFile = vault.getAbstractFileByPath(targetPath);

  await asyncTest('打开到期笔记且停留在 0 秒阈值时自动晋级', () => {
    const before = plugin.data.notes[targetPath].stage;
    plugin.onFileOpen(activeFile);
    const after = plugin.data.notes[targetPath];
    assert.strictEqual(after.stage, before + 1);
    assert.ok(after.nextDue > Date.now());
    assert.ok(notices.some((n) => n.includes('已复习')));
  });

  await asyncTest('未到期笔记打开不推进', () => {
    const p = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note2.md';
    plugin.data.notes[p].nextDue = Date.now() + 5 * DAY;
    plugin.data.notes[p].stage = 1;
    activeFile = vault.getAbstractFileByPath(p);
    plugin.onFileOpen(activeFile);
    assert.strictEqual(plugin.data.notes[p].stage, 1);
  });

  await asyncTest('暂停时不自动晋级', () => {
    const p = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note3.md';
    plugin.data.notes[p].nextDue = Date.now() - 1000;
    plugin.data.notes[p].stage = 0;
    plugin.data.settings.paused = true;
    activeFile = vault.getAbstractFileByPath(p);
    plugin.onFileOpen(activeFile);
    assert.strictEqual(plugin.data.notes[p].stage, 0);
    plugin.data.settings.paused = false;
  });

  console.log('\n[手动评分]');
  await asyncTest('忘记重置到第 0 档', () => {
    const p = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note4.md';
    plugin.data.notes[p].stage = 3;
    plugin.gradePath(p, 'forgot');
    assert.strictEqual(plugin.data.notes[p].stage, 0);
  });

  await asyncTest('模糊保持档位', () => {
    const p = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note5.md';
    plugin.data.notes[p].stage = 2;
    plugin.gradePath(p, 'fuzzy');
    assert.strictEqual(plugin.data.notes[p].stage, 2);
  });

  await asyncTest('范围外笔记评分被拒绝', () => {
    const p = 'Archives（归档，短期无用）/old1.md';
    const before = notices.length;
    plugin.gradePath(p, 'remember');
    assert.ok(notices.slice(before).some((n) => n.includes('不在复习范围')));
  });

  console.log('\n[队列]');
  await asyncTest('dueList 只返回到期且在范围内的笔记', () => {
    plugin.data.notes['A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note6.md'].nextDue = Date.now() - 1000;
    const due = plugin.dueList();
    assert.ok(due.some((x) => x.path.endsWith('note6.md')));
    assert.ok(due.every((x) => x.path.startsWith('A-Areas')));
  });

  await asyncTest('startRoam 会打开一篇到期笔记', async () => {
    const dueBefore = plugin.dueList().map((x) => x.path);
    assert.ok(dueBefore.length > 0);
    await plugin.startRoam(false);
    assert.ok(activeFile);
    assert.ok(dueBefore.includes(activeFile.path));
  });

  console.log('\n[重新铺开]');
  await asyncTest('只重排未复习笔记，已复习进度保持不变', () => {
    const reviewed = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note8.md';
    const unreviewed = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note9.md';
    plugin.data.notes[reviewed].reviewCount = 3;
    plugin.data.notes[reviewed].stage = 2;
    plugin.data.notes[reviewed].nextDue = Date.now() + 5 * DAY;
    const oldDue = plugin.data.notes[reviewed].nextDue;
    const oldStage = plugin.data.notes[reviewed].stage;

    plugin.data.notes[unreviewed].reviewCount = 0;
    plugin.data.notes[unreviewed].stage = 0;
    plugin.data.notes[unreviewed].nextDue = Date.now() + 200 * DAY;

    const n = plugin.rescheduleUnreviewed();
    assert.ok(n > 0);
    assert.strictEqual(plugin.data.notes[reviewed].stage, oldStage);
    assert.strictEqual(plugin.data.notes[reviewed].nextDue, oldDue);
    assert.ok(plugin.data.notes[unreviewed].nextDue <= Date.now() + 31 * DAY);
  });

  await asyncTest('重新铺开后范围内有到期笔记', () => {
    assert.ok(plugin.dueList().length >= 1);
  });

  await asyncTest('在主编辑区 leaf 中打开笔记并激活', async () => {
    let opened = null;
    let revealed = null;
    const originalGetLeaf = workspace.getLeaf;
    const originalReveal = workspace.revealLeaf;
    workspace.rootSplit = {};
    workspace.getLeaf = () => ({
      getRoot: () => workspace.rootSplit,
      openFile: async (f) => {
        opened = f;
        activeFile = f;
      },
    });
    workspace.revealLeaf = (leaf) => {
      revealed = leaf;
    };
    try {
      const target = vault.getAbstractFileByPath(
        'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note2.md'
      );
      await plugin.openPath(target.path);
      assert.strictEqual(opened, target);
      assert.ok(revealed, '应调用 revealLeaf 激活标签页');
    } finally {
      workspace.getLeaf = originalGetLeaf;
      workspace.revealLeaf = originalReveal;
      delete workspace.rootSplit;
    }
  });

  await asyncTest('侧边栏 leaf 会改到主编辑区新标签页', async () => {
    let opened = null;
    const originalGetLeaf = workspace.getLeaf;
    workspace.rootSplit = { main: true };
    workspace.getLeaf = (arg) => {
      if (arg === false) {
        return {
          getRoot: () => ({ side: true }),
          openFile: async () => {
            throw new Error('不应在侧边栏打开');
          },
        };
      }
      return {
        getRoot: () => workspace.rootSplit,
        openFile: async (f) => {
          opened = f;
        },
      };
    };
    try {
      const target = vault.getAbstractFileByPath(
        'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note3.md'
      );
      await plugin.openPath(target.path);
      assert.strictEqual(opened, target);
    } finally {
      workspace.getLeaf = originalGetLeaf;
      delete workspace.rootSplit;
    }
  });

  console.log('\n[文件事件]');
  await asyncTest('重命名迁移复习记录', () => {
    const from = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/note7.md';
    const to = 'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/moved-note7.md';
    const f = vault.getAbstractFileByPath(from);
    assert.ok(plugin.data.notes[from]);
    f.path = to;
    vaultEvents['rename'](f, from);
    assert.ok(plugin.data.notes[to]);
    assert.ok(!plugin.data.notes[from]);
  });

  await asyncTest('文件夹重命名批量迁移', () => {
    const folder = files.find((f) => f instanceof TFolder && f.path.startsWith('A-Areas'));
    const oldPath = folder.path;
    const newPath = 'A-Areas-renamed';
    const before = Object.keys(plugin.data.notes).length;
    for (const f of files) {
      if (f instanceof TFile && f.path.startsWith(oldPath + '/')) {
        f.path = f.path.replace(oldPath, newPath);
      }
    }
    folder.path = newPath;
    vaultEvents['rename'](folder, oldPath);
    assert.strictEqual(Object.keys(plugin.data.notes).length, before);
    assert.ok(Object.keys(plugin.data.notes).every((p) => p.startsWith(newPath + '/')));
  });

  await asyncTest('新建笔记自动纳入并安排在 1 天后', () => {
    const newFile = new TFile('A-Areas-renamed/brand-new.md', Date.now());
    files.push(newFile);
    vaultEvents['create'](newFile);
    const st = plugin.data.notes[newFile.path];
    assert.ok(st);
    assert.ok(st.nextDue > Date.now() + 0.9 * DAY);
    assert.ok(st.nextDue < Date.now() + 1.2 * DAY);
  });

  await asyncTest('复习数据写入附件目录文件', async () => {
    plugin._dirty = true;
    await plugin.saveSettingsNow();
    assert.ok(adapterWriteCalls > 0, 'adapter.write 应被调用');
    const DATA_PATH = '附件/ebbinghaus-roam-data.json';
    assert.ok(adapterStore[DATA_PATH], '附件目录的数据文件应存在');
    const saved = JSON.parse(adapterStore[DATA_PATH]);
    assert.ok(saved.notes && typeof saved.notes === 'object');
    assert.ok(saved.settings);
  });

  await asyncTest('从插件 data.json 迁移时自动生成附件目录数据文件', async () => {
    const DATA_PATH = '附件/ebbinghaus-roam-data.json';
    const legacy = adapterStore[DATA_PATH];
    delete adapterStore[DATA_PATH];

    const fresh = new PluginClass(app, { version: '1.5.0' });
    fresh._data = JSON.parse(JSON.stringify(plugin.data));
    await fresh.loadStore();
    assert.strictEqual(fresh._dataSource, 'plugin');
    assert.strictEqual(fresh._dirty, true, '迁移场景应置待写入标记');
    await fresh.saveStore();
    assert.ok(adapterStore[DATA_PATH], '迁移后附件目录应出现数据文件');
    assert.strictEqual(JSON.parse(adapterStore[DATA_PATH]).version, 5);

    adapterStore[DATA_PATH] = legacy;
  });

  await asyncTest('手机端导出备份写入附件目录', async () => {
    mockObsidian.Platform.isMobile = true;
    try {
      await plugin.exportData();
    } finally {
      mockObsidian.Platform.isMobile = false;
    }
    const backup = files.find((f) => /^附件\/ebbinghaus-roam-\d{8}\.json$/.test(f.path));
    assert.ok(backup, '备份应生成在附件目录');
  });

  await asyncTest('导入候选只含附件/库根目录备份，排除数据主文件', () => {
    const dataFile = new TFile('附件/ebbinghaus-roam-data.json');
    dataFile.parent = { path: '附件' };
    files.push(dataFile);
    const inAttach = new TFile('附件/ebbinghaus-roam-20260101.json');
    inAttach.parent = { path: '附件' };
    files.push(inAttach);
    const inRoot = new TFile('ebbinghaus-roam-20260101.json');
    inRoot.parent = { path: '/' };
    files.push(inRoot);
    const elsewhere = new TFile('A-Areas/bak/ebbinghaus-roam-old.json');
    elsewhere.parent = { path: 'A-Areas/bak' };
    files.push(elsewhere);

    const list = plugin.backupFiles();
    assert.ok(list.includes(inAttach), '应包含附件目录备份');
    assert.ok(list.includes(inRoot), '应兼容旧版库根目录备份');
    assert.ok(!list.includes(dataFile), '不应把数据主文件当备份');
    assert.ok(!list.includes(elsewhere), '不应扫描其他目录');
  });

  await asyncTest('评分会写入 updatedAt，供两端合并比较', () => {
    const p = Object.keys(plugin.data.notes)[0];
    const before = plugin.data.notes[p].updatedAt || 0;
    plugin.gradePath(p, 'remember');
    assert.ok(plugin.data.notes[p].updatedAt > before);
  });

  await asyncTest('另一端同步过来的数据自动合并，无需导入', async () => {
    const p = Object.keys(plugin.data.notes)[0];
    const local = plugin.data.notes[p];

    const remote = JSON.parse(JSON.stringify(plugin.data));
    remote.notes[p] = Object.assign({}, local, {
      stage: 2,
      nextDue: Date.now() + DAY,
      updatedAt: Date.now() + 60 * 1000,
    });
    remote.notes['同步新增/remote-only.md'] = {
      stage: 0,
      nextDue: Date.now(),
      reviewCount: 0,
      lastReviewed: 0,
      lastOpen: 0,
      addedAt: Date.now(),
      updatedAt: Date.now(),
    };

    const writesBefore = adapterWriteCalls;
    adapterStore[DATA_PATH] = JSON.stringify(remote);
    await plugin.onDataFileChanged({ path: DATA_PATH });

    assert.strictEqual(plugin.data.notes[p].stage, 2, '外部较新的记录应生效');
    assert.ok(plugin.data.notes['同步新增/remote-only.md'], '外部新增记录应并入');
    assert.strictEqual(adapterWriteCalls, writesBefore, '无本地领先时不应回写，避免同步震荡');
  });

  await asyncTest('自己写入触发的事件被忽略，不重复合并', async () => {
    await plugin.saveSettingsNow();
    const writesBefore = adapterWriteCalls;
    await plugin.onDataFileChanged({ path: DATA_PATH });
    assert.strictEqual(adapterWriteCalls, writesBefore);
  });

  await asyncTest('本地记录更新时回写合并结果，让两端收敛', async () => {
    const p = Object.keys(plugin.data.notes)[0];
    const local = plugin.data.notes[p];
    local.stage = 3;
    local.updatedAt = (local.updatedAt || 0) + 60 * 1000;

    const remote = JSON.parse(JSON.stringify(plugin.data));
    remote.notes[p] = Object.assign({}, local, { stage: 1, updatedAt: local.updatedAt - 1000 });

    plugin._dirty = false;
    adapterStore[DATA_PATH] = JSON.stringify(remote);
    await plugin.onDataFileChanged({ path: DATA_PATH });

    assert.strictEqual(plugin.data.notes[p].stage, 3, '本地较新记录不被覆盖');
    assert.strictEqual(plugin._dirty, true, '应安排回写');
    if (plugin._saveTimer) {
      clearTimeout(plugin._saveTimer);
      plugin._saveTimer = null;
    }
  });

  await asyncTest('设置页改动带 settingsUpdatedAt，另一端的设置能被采用', async () => {
    const p = Object.keys(plugin.data.notes)[0];
    const remote = JSON.parse(JSON.stringify(plugin.data));
    remote.settings = Object.assign({}, remote.settings, { dailyLimit: 77 });
    remote.settingsUpdatedAt = Date.now() + 60 * 1000;
    remote.notes = { [p]: plugin.data.notes[p] };

    adapterStore[DATA_PATH] = JSON.stringify(remote);
    await plugin.onDataFileChanged({ path: DATA_PATH });

    assert.strictEqual(plugin.data.settings.dailyLimit, 77);
    plugin.data.settings.dailyLimit = 45;
    plugin.data.settingsUpdatedAt = Date.now();
    if (plugin._saveTimer) {
      clearTimeout(plugin._saveTimer);
      plugin._saveTimer = null;
    }
  });

  await asyncTest('状态栏文本包含到期数', () => {
    plugin.refreshUI();
    assert.ok(plugin._statusBars[0].textContent.includes('漫游'));
  });

  await asyncTest('移动端通过新标签页打开面板视图', async () => {
    mockObsidian.Platform.isMobile = true;
    let createdLeaf = null;
    const originalGetLeaf = workspace.getLeaf;
    workspace.getLeaf = (newLeaf) => {
      const leaf = {
        app,
        openFile: async (f) => {
          activeFile = f;
        },
        setViewState: async () => {},
      };
      if (newLeaf) createdLeaf = leaf;
      return leaf;
    };
    try {
      await plugin.activateView();
      assert.ok(createdLeaf, '移动端应调用 getLeaf(true)');
    } finally {
      workspace.getLeaf = originalGetLeaf;
      mockObsidian.Platform.isMobile = false;
    }
  });

  await asyncTest('应用 2027 国省考预设', () => {
    const n = plugin.applyExamPreset2027();
    const s = plugin.data.settings;
    assert.strictEqual(s.includeAll, false);
    assert.strictEqual(s.folders.length, 5);
    assert.strictEqual(s.intervals.join(','), '1,3,7,14,21');
    assert.strictEqual(s.initialSpreadDays, 18);
    assert.strictEqual(s.dailyLimit, 45);
    assert.strictEqual(s.listLimit, 120);
    assert.strictEqual(s.minDwellSeconds, 30);
    assert.ok(s.excludeKeywords.includes('打卡表'));
    assert.ok(n >= 0);
  });

  // 清理 60 秒定时器
  for (const id of plugin._intervals) clearInterval(id);

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
