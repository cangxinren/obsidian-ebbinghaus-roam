'use strict';

const obsidian = require('obsidian');
const {
  Notice,
  Plugin,
  ItemView,
  PluginSettingTab,
  Modal,
  Setting,
  SuggestModal,
  TFile,
  TFolder,
  Platform,
} = obsidian;

const VIEW_TYPE = 'ebbinghaus-roam-view';
// 复习进度主数据文件：放在附件目录，随 remotely-save / 网盘同步到手机
const DATA_FILE = '附件/ebbinghaus-roam-data.json';
const DATA_DIR = DATA_FILE.slice(0, DATA_FILE.lastIndexOf('/'));
// 早期版本的库根目录数据文件，仅用于读取迁移，不再写入
const LEGACY_DATA_FILES = ['ebbinghaus-roam-data.json'];

/* ------------------------------------------------------------------ */
/* 内置调度逻辑                                                        */
/* 合并为单文件而不是 require('./scheduler.js')，因为 Obsidian 手机端    */
/* 不保证支持插件内的相对 require；单文件 main.js 在桌面与安卓都能加载。 */
/* ------------------------------------------------------------------ */

const S = (() => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  const DEFAULT_SETTINGS = {
    includeAll: true,
    folders: [],
    excludeFolders: ['Archives（归档，短期无用）', '模板', '附件', '.trash'],
    excludeKeywords: [],
    intervals: [1, 2, 4, 7, 15, 30, 60, 120, 240],
    dailyLimit: 20,
    minDwellSeconds: 30,
    autoAdvance: true,
    autoRecordOpen: true,
    autoEnroll: true,
    randomOrder: false,
    paused: false,
    showStatusBar: true,
    initialSpreadDays: 30,
    listLimit: 200,
  };

  const PRESETS = {
    ebbinghaus: [1, 2, 4, 7, 15, 30, 60, 120, 240],
    compact: [1, 2, 3, 5, 8, 13, 21, 34],
    relaxed: [2, 4, 7, 15, 30, 60, 120, 240, 365],
  };

  const PRESET_LABELS = {
    ebbinghaus: '艾宾浩斯经典（1/2/4/7/15/30/60/120/240 天）',
    compact: '紧凑（1/2/3/5/8/13/21/34 天）',
    relaxed: '宽松（2/4/7/15/30/60/120/240/365 天）',
  };

  function normalizePathKey(p) {
    return String(p == null ? '' : p)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }

  function isFolderSelected(path, folder) {
    const p = normalizePathKey(path);
    const f = normalizePathKey(folder);
    if (!f) return false;
    return p === f || p.startsWith(f + '/');
  }

  function pathHasSegment(path, name) {
    const n = normalizePathKey(name);
    if (!n) return false;
    return normalizePathKey(path).split('/').includes(n);
  }

  function inScope(path, settings) {
    const s = settings || {};
    const p = normalizePathKey(path);
    if (!/\.md$/i.test(p)) return false;

    const excluded = (s.excludeFolders || []).some((f) => {
      const nf = normalizePathKey(f);
      if (!nf) return false;
      return nf.includes('/') ? isFolderSelected(p, nf) : pathHasSegment(p, nf);
    });
    if (excluded) return false;

    const keywords = s.excludeKeywords || [];
    if (keywords.some((k) => k && p.includes(k))) return false;

    if (s.includeAll) return true;
    return (s.folders || []).some((f) => isFolderSelected(p, f));
  }

  function parseIntervals(input) {
    let arr;
    if (Array.isArray(input)) arr = input;
    else arr = String(input == null ? '' : input).split(/[\s,，、;；]+/);
    const nums = arr
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.max(1, Math.round(n)));
    const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);
    return uniq.length ? uniq : DEFAULT_SETTINGS.intervals.slice();
  }

  function intervalsToText(intervals) {
    return parseIntervals(intervals).join(', ');
  }

  function hash01(str) {
    let h = 2166136261 >>> 0;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h / 4294967296;
  }

  function clampStage(stage, intervals) {
    const list = parseIntervals(intervals);
    const n = Math.round(Number(stage) || 0);
    return Math.min(Math.max(0, n), list.length - 1);
  }

  function makeEnrollment(path, now, nextDue) {
    return {
      stage: 0,
      firstSeen: now,
      lastReviewed: 0,
      lastOpen: 0,
      reviewCount: 0,
      nextDue: Number.isFinite(nextDue) ? nextDue : now,
      lastGrade: null,
      addedAt: now,
      // 每条记录的修改时间，用于两端数据合并（大的为准）
      updatedAt: now,
    };
  }

  /**
   * 计算“按天分桶”的首次到期时间：
   * 同一批笔记的第一天全部立即到期，之后每天一批，当天内随机打散。
   * 这样启用插件后马上有内容可复习，而不是等一整天。
   */
  function spreadDue(path, index, total, now, spreadDays) {
    const n = Math.max(0, Number(total) || 0);
    const spread = Math.max(0, Number(spreadDays) || 0);
    if (n <= 1 || spread <= 0) return now;

    const ratio = index / (n - 1);
    const dayIndex = Math.min(spread - 1, Math.floor(ratio * spread));
    if (dayIndex === 0) return now;
    return now + dayIndex * DAY_MS + hash01(path) * DAY_MS;
  }

  function buildInitialSchedule(files, now = Date.now(), spreadDays = 30) {
    const sorted = (files || [])
      .filter((f) => f && f.path)
      .slice()
      .sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
    const n = sorted.length;
    const out = {};
    sorted.forEach((f, i) => {
      out[f.path] = makeEnrollment(f.path, now, spreadDue(f.path, i, n, now, spreadDays));
    });
    return out;
  }

  function isDue(state, now = Date.now()) {
    return !!(state && Number.isFinite(state.nextDue) && state.nextDue <= now);
  }

  function reviewNote(state, grade, intervals, now = Date.now()) {
    const list = parseIntervals(intervals);
    const s = Object.assign({ stage: 0, reviewCount: 0 }, state || {});
    const stage = clampStage(s.stage, list);
    let nextStage;
    let days;

    if (grade === 'forgot') {
      nextStage = 0;
      days = list[0];
    } else if (grade === 'fuzzy') {
      nextStage = stage;
      days = Math.max(1, list[stage] * 0.5);
    } else {
      nextStage = Math.min(stage + 1, list.length - 1);
      days = list[nextStage];
    }

    return Object.assign({}, s, {
      stage: nextStage,
      reviewCount: (Number(s.reviewCount) || 0) + 1,
      lastReviewed: now,
      nextDue: now + days * DAY_MS,
      lastGrade: grade,
      updatedAt: now,
    });
  }

  function dueNotes(notes, now = Date.now(), pathFilter) {
    const out = [];
    const all = notes || {};
    for (const path of Object.keys(all)) {
      const st = all[path];
      if (!isDue(st, now)) continue;
      if (pathFilter && !pathFilter(path)) continue;
      out.push({ path, state: st });
    }
    out.sort((a, b) => a.state.nextDue - b.state.nextDue);
    return out;
  }

  function formatDue(nextDue, now = Date.now()) {
    if (!Number.isFinite(nextDue)) return '未安排';
    const diff = nextDue - now;
    const abs = Math.abs(diff);
    const days = Math.floor(abs / DAY_MS);

    if (diff <= 0) {
      if (abs < 60 * 1000) return '刚刚到期';
      if (abs < DAY_MS) return '今天到期';
      if (days === 1) return '逾期 1 天';
      return `逾期 ${days} 天`;
    }
    if (diff < DAY_MS) return '今天稍后';
    const ceilDays = Math.ceil(diff / DAY_MS);
    if (ceilDays === 1) return '明天';
    if (ceilDays < 30) return `${ceilDays} 天后`;
    if (ceilDays < 365) return `${Math.round(ceilDays / 30)} 个月后`;
    return `${(ceilDays / 365).toFixed(1)} 年后`;
  }

  function stageLabel(state, intervals) {
    const list = parseIntervals(intervals);
    const stage = clampStage(state && state.stage, list);
    return `第 ${stage + 1}/${list.length} 档`;
  }

  function pathBasename(path) {
    const p = normalizePathKey(path);
    const name = p.split('/').pop() || p;
    return name.replace(/\.md$/i, '');
  }

  function pathDirname(path) {
    const p = normalizePathKey(path);
    const idx = p.lastIndexOf('/');
    return idx < 0 ? '' : p.slice(0, idx);
  }

  return {
    DAY_MS,
    DEFAULT_SETTINGS,
    PRESETS,
    PRESET_LABELS,
    normalizePathKey,
    isFolderSelected,
    pathHasSegment,
    inScope,
    parseIntervals,
    intervalsToText,
    hash01,
    clampStage,
    makeEnrollment,
    spreadDue,
    buildInitialSchedule,
    isDue,
    reviewNote,
    dueNotes,
    formatDue,
    stageLabel,
    pathBasename,
    pathDirname,
  };
})();

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

class EbbinghausRoamPlugin extends Plugin {
  async onload() {
    // 先初始化字段，再载入数据：loadStore 会按数据来源设置 _dirty，
    // 若在其后重置为 false，迁移写入库内文件的标记会被覆盖。
    this._saveTimer = null;
    this._dwellTimer = null;
    this._dwellPath = null;
    this._dirty = false;
    this._enrolling = false;
    this._lastUISignature = null;
    // 实时同步：记录最后一次写入内容，用于忽略自己写入触发的 modify 事件
    this._lastSavedRaw = null;
    this._mergingRemote = false;
    this._dataMtime = 0;

    await this.loadStore();

    this.registerView(VIEW_TYPE, (leaf) => new RoamView(leaf, this));

    // 左键：直接开始漫游（打开下一篇到期笔记）
    // 右键/长按：打开复习面板（查看队列、暂停、手动评分）
    const ribbonIcon = this.addRibbonIcon(
      'book-open',
      '漫游复习：点击开始下一篇（右键/长按打开面板）',
      () => {
        this.startRoam(false).catch((e) => {
          new Notice('打开失败：' + (e && e.message ? e.message : e), 5000);
        });
      }
    );
    if (ribbonIcon && typeof ribbonIcon.addEventListener === 'function') {
      ribbonIcon.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.activateView();
      });
    }

    this.addCommand({ id: 'open-panel', name: '打开复习面板', callback: () => this.activateView() });
    this.addCommand({
      id: 'refresh-panel',
      name: '刷新复习列表',
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (!leaves.length) {
          this.activateView();
          return;
        }
        for (const lf of leaves) {
          const view = lf.view;
          if (view && typeof view.renderSafe === 'function') view.renderSafe();
        }
      },
    });
    this.addCommand({ id: 'start-roam', name: '开始漫游（打开下一篇到期笔记）', callback: () => this.startRoam(false) });
    this.addCommand({ id: 'random-roam', name: '随机漫游一篇到期笔记', callback: () => this.startRoam(true) });
    this.addCommand({ id: 'grade-remember', name: '标记当前笔记：记得（晋级）', callback: () => this.gradeActive('remember') });
    this.addCommand({ id: 'grade-fuzzy', name: '标记当前笔记：模糊（保持）', callback: () => this.gradeActive('fuzzy') });
    this.addCommand({ id: 'grade-forgot', name: '标记当前笔记：忘了（重置）', callback: () => this.gradeActive('forgot') });
    this.addCommand({ id: 'toggle-pause', name: '暂停 / 恢复自动记录', callback: () => this.togglePause() });

    this.addSettingTab(new RoamSettingTab(this.app, this));

    // 手机端没有状态栏，addStatusBarItem 可能返回 null 或隐藏元素
    this.statusBarEl = this.addStatusBarItem();
    if (this.statusBarEl) {
      this.statusBarEl.addClass('er-statusbar');
      this.statusBarEl.addEventListener('click', () => this.activateView());
    }

    this.registerEvent(this.app.workspace.on('file-open', (file) => this.onFileOpen(file)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.onActiveLeafChange()));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('create', (file) => this.onCreate(file)));
    this.registerEvent(this.app.vault.on('delete', () => this.refreshUI()));
    // 数据文件被另一端同步覆盖时，实时读入并合并，不需要手动导入
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file && file.path === DATA_FILE) this.onDataFileChanged(file);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      if (this._needsExamPreset) {
        this._needsExamPreset = false;
        this._needsRescheduleMigration = false;
        this.applyExamPreset2027();
        this.saveSettingsNow();
      } else if (this._needsRescheduleMigration) {
        // 旧版数据（首次铺开时可能还是全库范围）升级后，先按当前范围重排一次
        this._needsRescheduleMigration = false;
        this.rescheduleUnreviewed();
        this.saveSettingsNow();
      }
      // 只有首次运行（还没有任何记录）才按修改时间铺开；
      // 之后启动时发现的新笔记按普通规则从 1 天后开始。
      this.enrollScope(Object.keys(this.data.notes).length === 0);
      this.refreshUI();

      // 布局恢复出来的空白视图：重新渲染一次，失败时会把错误显示在面板里
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        const view = leaf.view;
        if (!view) continue;
        const content = view.contentEl;
        const empty = !content || !content.childElementCount;
        if (empty && typeof view.renderSafe === 'function') view.renderSafe();
      }
    });

    this.registerInterval(window.setInterval(() => this.refreshUI(), 60 * 1000));
    // 部分平台不会为库外写入触发 modify，用轮询兜底（20 秒）
    this.registerInterval(
      window.setInterval(() => {
        this.checkExternalUpdate();
      }, 20 * 1000)
    );

    // 首次启用或从旧位置迁移时，把数据写入附件目录
    if (this._dirty) this.scheduleSave(500);
  }

  onunload() {
    this.clearDwell();
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) {
      this.saveStore().catch((e) => {
        console.error('[ebbinghaus-roam] 卸载时保存失败', e);
      });
    }
  }

  /* ---------------- 数据 ---------------- */

  async loadStore() {
    // 主数据源：附件目录的普通 JSON，随 remotely-save / 网盘同步到手机
    let raw = null;
    let source = 'none';
    const adapter = this.app.vault.adapter;
    for (const p of [DATA_FILE].concat(LEGACY_DATA_FILES)) {
      try {
        if (!adapter || !(await adapter.exists(p))) continue;
        const text = await adapter.read(p);
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          raw = parsed;
          if (p === DATA_FILE) this._lastSavedRaw = text;
          // 旧位置读到的数据要重新写一份到附件目录
          source = p === DATA_FILE ? 'vault' : 'legacy';
          break;
        }
      } catch (e) {
        console.error('[ebbinghaus-roam] 读取库内数据失败：' + p, e);
      }
    }

    if (!raw) {
      raw = await this.loadData();
      source = raw ? 'plugin' : 'none';
    }

    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const settings = this.normalizeSettings(d.settings);
    const notes = this.normalizeNotes(d.notes);

    const incomingVersion = Number(d.version) || 1;
    // v4：按“当前范围 + 按天分桶”重新铺开未复习笔记
    this._needsRescheduleMigration = incomingVersion < 4;
    // v5：应用 2027 国省考预设（按 2026-11-29 国考、2026-12-06 省考倒排）
    this._needsExamPreset = incomingVersion < 5;
    this.data = {
      version: 5,
      settings,
      notes,
      settingsUpdatedAt: Number(d.settingsUpdatedAt) || 0,
    };
    this._dataSource = source;
    // 首次启用或从插件 data.json 迁移时，尽快写入库内文件
    this._dirty = source !== 'vault';
  }

  normalizeSettings(rawSettings) {
    const settings = Object.assign({}, S.DEFAULT_SETTINGS, rawSettings || {});

    settings.intervals = S.parseIntervals(settings.intervals);
    settings.folders = Array.isArray(settings.folders) ? settings.folders : [];
    settings.excludeFolders = Array.isArray(settings.excludeFolders)
      ? settings.excludeFolders
      : S.DEFAULT_SETTINGS.excludeFolders.slice();
    settings.excludeKeywords = Array.isArray(settings.excludeKeywords) ? settings.excludeKeywords : [];

    settings.initialSpreadDays = Number(settings.initialSpreadDays);
    if (!Number.isFinite(settings.initialSpreadDays) || settings.initialSpreadDays < 0) {
      settings.initialSpreadDays = 30;
    }
    settings.dailyLimit = Math.max(0, Math.round(Number(settings.dailyLimit) || 0));
    settings.minDwellSeconds = Math.max(0, Math.round(Number(settings.minDwellSeconds) || 0));
    settings.listLimit = Math.max(20, Math.round(Number(settings.listLimit) || 200));
    return settings;
  }

  normalizeNotes(rawNotes) {
    const notes = {};
    if (!rawNotes || typeof rawNotes !== 'object') return notes;
    for (const [p, st] of Object.entries(rawNotes)) {
      if (!st || typeof st !== 'object' || !Number.isFinite(st.nextDue)) continue;
      // 旧记录没有 updatedAt，用最近复习时间兜底，保证合并时可比
      if (!Number.isFinite(st.updatedAt)) {
        st.updatedAt = Number(st.lastReviewed) || Number(st.addedAt) || 0;
      }
      notes[S.normalizePathKey(p)] = st;
    }
    return notes;
  }

  /** 记录新旧程度：优先 updatedAt，其次 lastReviewed */
  noteScore(st) {
    if (!st) return -1;
    return Number(st.updatedAt) || Number(st.lastReviewed) || 0;
  }

  /**
   * 合并另一台设备写入的数据：逐条按更新时间取新，lastOpen 取两者较大值。
   * 返回 { changed, localAhead }：localAhead 表示本地有更新的记录，需要回写让两端收敛。
   */
  mergeRemoteStore(remote) {
    const result = { changed: false, localAhead: false };
    if (!remote || typeof remote !== 'object') return result;

    const remoteNotes = this.normalizeNotes(remote.notes);
    for (const [path, rst] of Object.entries(remoteNotes)) {
      const lst = this.data.notes[path];
      if (!lst) {
        this.data.notes[path] = rst;
        result.changed = true;
        continue;
      }
      const localNewer = this.noteScore(lst) > this.noteScore(rst);
      const base = localNewer ? lst : rst;
      const other = localNewer ? rst : lst;
      const merged = Object.assign({}, other, base);
      merged.lastOpen = Math.max(Number(lst.lastOpen) || 0, Number(rst.lastOpen) || 0);
      if (localNewer && this.noteScore(lst) !== this.noteScore(rst)) result.localAhead = true;
      if (JSON.stringify(merged) !== JSON.stringify(lst)) {
        this.data.notes[path] = merged;
        if (!localNewer) result.changed = true;
      }
    }

    const remoteSettingsAt = Number(remote.settingsUpdatedAt) || 0;
    const localSettingsAt = Number(this.data.settingsUpdatedAt) || 0;
    if (remote.settings && remoteSettingsAt > localSettingsAt) {
      this.data.settings = this.normalizeSettings(remote.settings);
      this.data.settingsUpdatedAt = remoteSettingsAt;
      result.changed = true;
    }
    return result;
  }

  /** 库内数据文件被外部改动（另一台设备同步过来）时读入并合并 */
  async onDataFileChanged(file) {
    if (file && file.path && file.path !== DATA_FILE) return;
    if (this._mergingRemote) return;
    let raw = null;
    try {
      const adapter = this.app.vault.adapter;
      if (!adapter || !(await adapter.exists(DATA_FILE))) return;
      raw = await adapter.read(DATA_FILE);
    } catch (e) {
      console.error('[ebbinghaus-roam] 读取同步数据失败', e);
      return;
    }
    if (typeof raw !== 'string' || raw === this._lastSavedRaw) return;

    this._mergingRemote = true;
    try {
      this._lastSavedRaw = raw;
      const parsed = JSON.parse(raw);
      const { changed, localAhead } = this.mergeRemoteStore(parsed);
      if (changed) {
        new Notice('复习进度已从另一台设备同步', 2500);
        this.refreshUI();
      }
      // 本地记录更新时回写合并结果，避免两端长期不一致
      if (localAhead) this.scheduleSave(300);
    } catch (e) {
      console.error('[ebbinghaus-roam] 合并同步数据失败', e);
    } finally {
      this._mergingRemote = false;
    }
  }

  /** 兜底轮询：部分平台对库外写入不触发 modify 事件 */
  async checkExternalUpdate() {
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.stat !== 'function') return;
    try {
      const st = await adapter.stat(DATA_FILE);
      if (!st || !Number.isFinite(st.mtime)) return;
      if (st.mtime <= (this._dataMtime || 0)) return;
      this._dataMtime = st.mtime;
      await this.onDataFileChanged(null);
    } catch (e) {
      /* 文件可能还不存在 */
    }
  }

  scheduleSave(delay = 800) {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveStore();
    }, delay);
  }

  /** 确保附件目录存在（桌面/手机、首次运行或另一设备刚同步时都可能缺失） */
  async ensureDataDir() {
    if (!DATA_DIR) return;
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.exists === 'function' && (await adapter.exists(DATA_DIR))) return;
    if (this.app.vault.getAbstractFileByPath(DATA_DIR)) return;
    try {
      if (adapter && typeof adapter.mkdir === 'function') await adapter.mkdir(DATA_DIR);
      else await this.app.vault.createFolder(DATA_DIR);
    } catch (e) {
      // 并发创建或另一设备刚建好，最终以是否存在为准
      if (adapter && typeof adapter.exists === 'function' && (await adapter.exists(DATA_DIR))) return;
      if (this.app.vault.getAbstractFileByPath(DATA_DIR)) return;
      throw e;
    }
  }

  async saveStore() {
    if (!this._dirty) return;
    this._dirty = false;

    // 只写库内文件，保证桌面与手机共用同一份数据；
    // 插件目录的 data.json 仅用于旧数据迁移，不再更新，避免两个同步源冲突。
    try {
      const adapter = this.app.vault.adapter;
      if (!adapter) throw new Error('当前环境不支持库内文件写入');
      await this.ensureDataDir();
      const raw = JSON.stringify(this.data);
      await adapter.write(DATA_FILE, raw);
      this._lastSavedRaw = raw;
      if (typeof adapter.stat === 'function') {
        try {
          const st = await adapter.stat(DATA_FILE);
          if (st && Number.isFinite(st.mtime)) this._dataMtime = st.mtime;
        } catch (e) {
          /* 拿不到 mtime 时靠 modify 事件与轮询兜底 */
        }
      }
    } catch (e) {
      this._dirty = true;
      console.error('[ebbinghaus-roam] 写入库内数据失败', e);
      new Notice('复习数据写入库内文件失败：' + (e && e.message ? e.message : e), 6000);
    }
  }

  async saveSettingsNow() {
    // 设置变更时间，供另一端合并时判断谁更新
    this.data.settingsUpdatedAt = Date.now();
    this._dirty = true;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this.saveStore();
  }

  /* ---------------- 范围与纳入 ---------------- */

  scopeFiles() {
    return this.app.vault.getMarkdownFiles().filter((f) => S.inScope(f.path, this.data.settings));
  }

  enrollOne(path, due) {
    if (this.data.notes[path]) return this.data.notes[path];
    const now = Date.now();
    const st = S.makeEnrollment(path, now, Number.isFinite(due) ? due : now);
    this.data.notes[path] = st;
    this.scheduleSave();
    return st;
  }

  /**
   * 把范围内尚未纳入的笔记加入队列。
   * initial=true 时按最后修改时间均匀铺开（首次启用）。
   */
  enrollScope(initial = false) {
    if (this._enrolling) return 0;
    this._enrolling = true;
    try {
      const files = this.scopeFiles();
      const missing = files.filter((f) => !this.data.notes[f.path]);
      if (!missing.length) return 0;

      const now = Date.now();
      const firstInterval = S.parseIntervals(this.data.settings.intervals)[0] || 1;

      if (initial && missing.length > 3) {
        const plan = S.buildInitialSchedule(
          missing.map((f) => ({ path: f.path, mtime: (f.stat && f.stat.mtime) || 0 })),
          now,
          this.data.settings.initialSpreadDays
        );
        Object.assign(this.data.notes, plan);
      } else {
        for (const f of missing) {
          const due = now + firstInterval * S.DAY_MS + S.hash01(f.path) * 6 * 60 * 60 * 1000;
          this.data.notes[f.path] = S.makeEnrollment(f.path, now, due);
        }
      }
      this.scheduleSave();
      return missing.length;
    } finally {
      this._enrolling = false;
    }
  }

  /**
   * 按当前范围重新铺开“从未复习过”的笔记：
   * 以最后修改时间从旧到新，均匀铺到未来 initialSpreadDays 天，最旧的立即到期。
   * 已复习过（reviewCount > 0）的笔记保持原有进度不动。
   */
  rescheduleUnreviewed() {
    const s = this.data.settings;
    const files = this.scopeFiles();
    if (!files.length) return 0;

    const now = Date.now();
    const spread = Math.max(0, Number(s.initialSpreadDays) || 0);
    const sorted = files
      .slice()
      .sort((a, b) => ((a.stat && a.stat.mtime) || 0) - ((b.stat && b.stat.mtime) || 0));
    const n = sorted.length;
    let changed = 0;

    sorted.forEach((f, i) => {
      const existing = this.data.notes[f.path];
      if (existing && (Number(existing.reviewCount) || 0) > 0) return;

      const due = S.spreadDue(f.path, i, n, now, spread);

      if (existing) {
        existing.stage = 0;
        existing.nextDue = due;
      } else {
        this.data.notes[f.path] = S.makeEnrollment(f.path, now, due);
      }
      changed++;
    });

    if (changed) this.scheduleSave();
    return changed;
  }

  /**
   * 2027 国省考预设：
   *   国考 2026-11-29（行政执法卷），省考 2026-12-06（县乡综合管理卷），笔试相隔 7 天。
   *   - 范围：P1 主战役（时政/常识考点）+ A1 行测 + A2 申论 + A3 政治理论 + A4 错题库，共约 807 篇
   *   - 剔除逐日作战图、打卡表、报考指南等非记忆材料
   *   - 18 天铺开（11-08 → 11-26，留 3 天机动），每天约 45 篇
   *   - 曲线 1/3/7/14/21 天：国考前每篇至少 2 轮，省考前可到 3–4 轮
   */
  applyExamPreset2027() {
    const s = this.data.settings;
    s.includeAll = false;
    s.folders = [
      'P-Projects（计划、日记、未学的知识）/P1_2027国、省考主战役',
      'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/A1_行测底盘',
      'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/A2_申论底盘',
      'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/A3_政治理论底盘',
      'A-Areas（板块知识点笔记、总结类、本阶段长期有用）/A4_错题库',
    ];
    s.excludeFolders = ['Archives（归档，短期无用）', '模板', '附件', '.trash'];
    s.excludeKeywords = [
      '逐日作战图',
      '打卡表',
      '执行手册',
      '作战计划',
      '报考备考指南',
      '岗位分析',
      '备考手册',
      'INDEX-模块化',
    ];
    s.intervals = [1, 3, 7, 14, 21];
    s.dailyLimit = 45;
    s.minDwellSeconds = 30;
    s.autoAdvance = true;
    s.autoRecordOpen = true;
    s.autoEnroll = true;
    s.randomOrder = false;
    s.paused = false;
    s.initialSpreadDays = 18;
    s.listLimit = 120;
    return this.rescheduleUnreviewed();
  }

  async scanNow(initial = false) {
    const n = this.enrollScope(initial);
    await this.saveSettingsNow();
    this.refreshUI();

    const files = this.scopeFiles();
    const scope = files.length;
    const enrolled = files.filter((f) => this.data.notes[f.path]).length;
    const due = this.dueList().length;

    if (n) {
      new Notice(`已纳入 ${n} 篇新笔记（范围内共 ${scope} 篇，已纳入 ${enrolled} 篇，到期 ${due} 篇）`, 5000);
    } else {
      new Notice(`范围内共 ${scope} 篇，已全部纳入（${enrolled} 篇），当前到期 ${due} 篇`, 5000);
    }
  }

  /* ---------------- 通过打开行为记录/晋级 ---------------- */

  clearDwell() {
    if (this._dwellTimer) {
      clearTimeout(this._dwellTimer);
      this._dwellTimer = null;
    }
    this._dwellPath = null;
  }

  onFileOpen(file) {
    const s = this.data.settings;

    if (!file || !(file instanceof TFile) || file.extension !== 'md') {
      this.clearDwell();
      this.refreshUI();
      return;
    }
    if (!S.inScope(file.path, s)) {
      this.clearDwell();
      this.refreshUI();
      return;
    }

    if (s.autoRecordOpen) {
      const existing = this.data.notes[file.path];
      if (existing) {
        existing.lastOpen = Date.now();
        existing.updatedAt = existing.updatedAt || existing.lastOpen;
        this.scheduleSave(2500);
      }
    }

    if (this._dwellPath === file.path && this._dwellTimer) {
      this.refreshUI();
      return;
    }

    let st = this.data.notes[file.path];
    if (!st) {
      if (!s.autoEnroll) {
        this.clearDwell();
        this.refreshUI();
        return;
      }
      st = this.enrollOne(file.path, Date.now());
    }

    if (s.paused || !s.autoAdvance || !S.isDue(st, Date.now())) {
      this.clearDwell();
      this.refreshUI();
      return;
    }

    const waitMs = Math.max(0, Number(s.minDwellSeconds) || 0) * 1000;
    this.clearDwell();

    if (waitMs === 0) {
      this.autoReview(file.path);
      return;
    }

    this._dwellPath = file.path;
    this._dwellTimer = window.setTimeout(() => {
      this._dwellTimer = null;
      const path = this._dwellPath;
      this._dwellPath = null;
      if (!path) return;
      const active = this.app.workspace.getActiveFile();
      if (active && active.path === path) this.autoReview(path);
    }, waitMs);

    this.refreshUI();
  }

  onActiveLeafChange() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.clearDwell();
      this.refreshUI();
      return;
    }
    if (this._dwellPath && this._dwellPath !== file.path) this.clearDwell();
    if (this._dwellPath === file.path) {
      this.refreshUI();
      return;
    }
    this.onFileOpen(file);
  }

  autoReview(path) {
    const now = Date.now();
    const st = this.data.notes[path];
    if (!st || !S.isDue(st, now)) return;

    const next = S.reviewNote(st, 'remember', this.data.settings.intervals, now);
    this.data.notes[path] = next;
    this.scheduleSave();
    new Notice(`已复习《${S.pathBasename(path)}》 · 下次 ${S.formatDue(next.nextDue, now)}`, 3200);
    this.refreshUI();
  }

  gradeActive(grade) {
    const file = this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile) || file.extension !== 'md') {
      new Notice('当前没有打开的 Markdown 笔记');
      return;
    }
    this.gradePath(file.path, grade);
  }

  gradePath(path, grade) {
    if (!S.inScope(path, this.data.settings)) {
      new Notice('这篇笔记不在复习范围内，可到插件设置里调整文件夹。');
      return;
    }

    const now = Date.now();
    const st = this.data.notes[path] || this.enrollOne(path, now);
    const next = S.reviewNote(st, grade, this.data.settings.intervals, now);
    this.data.notes[path] = next;
    this.scheduleSave();

    const word = grade === 'forgot' ? '已重置到第 1 档' : grade === 'fuzzy' ? '保持当前档位' : '已晋级';
    new Notice(`《${S.pathBasename(path)}》${word} · 下次 ${S.formatDue(next.nextDue, now)}`, 3200);
    this.refreshUI();
  }

  async togglePause() {
    this.data.settings.paused = !this.data.settings.paused;
    this.clearDwell();
    await this.saveSettingsNow();
    new Notice(this.data.settings.paused ? '漫游自动记录已暂停' : '漫游自动记录已恢复');
    this.refreshUI();
  }

  /* ---------------- 队列与打开 ---------------- */

  dueList() {
    const paths = new Set(this.app.vault.getMarkdownFiles().map((f) => f.path));
    const s = this.data.settings;
    return S.dueNotes(this.data.notes, Date.now(), (p) => paths.has(p) && S.inScope(p, s));
  }

  /** 尚未到期的范围内笔记，按到期时间升序，用于侧边栏「即将到期」 */
  upcomingList(limit = 10) {
    const paths = new Set(this.app.vault.getMarkdownFiles().map((f) => f.path));
    const s = this.data.settings;
    const now = Date.now();
    return Object.entries(this.data.notes)
      .filter(([p, st]) => paths.has(p) && S.inScope(p, s) && Number(st.nextDue) > now)
      .map(([path, state]) => ({ path, state }))
      .sort((a, b) => a.state.nextDue - b.state.nextDue)
      .slice(0, Math.max(0, limit));
  }

  async startRoam(random) {
    const s = this.data.settings;
    let list = this.dueList();
    if (!list.length) {
      new Notice('今天没有到期的笔记 🎉');
      return;
    }

    const limit = Math.max(0, Number(s.dailyLimit) || 0);
    if (limit > 0) list = list.slice(0, limit);

    const active = this.app.workspace.getActiveFile();
    const activePath = active ? active.path : null;

    let pick;
    if (random || s.randomOrder) {
      const pool = list.length > 1 ? list.filter((x) => x.path !== activePath) : list;
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      pick = list.find((x) => x.path !== activePath) || list[0];
    }

    if (pick) {
      if (activePath && pick.path === activePath && list.length === 1) {
        new Notice(
          `当前笔记就是唯一到期的一篇，停留 ${s.minDwellSeconds} 秒即可完成复习`,
          4000
        );
      }
      await this.openPath(pick.path);
    }
  }

  async openPath(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('笔记不存在或已被移动：' + path, 5000);
      return;
    }

    const { workspace } = this.app;

    // 手机端只有一个主编辑区，直接在当前 leaf 打开即可
    if (Platform.isMobile) {
      let mobileLeaf = await Promise.resolve(workspace.getLeaf(false));
      if (!mobileLeaf) mobileLeaf = await Promise.resolve(workspace.getLeaf('tab'));
      if (!mobileLeaf || typeof mobileLeaf.openFile !== 'function') {
        throw new Error('无法获取可用的编辑区标签页');
      }
      await mobileLeaf.openFile(file);
      return;
    }

    // 与 Obsidian 核心「随机笔记」一致：getLeaf(false).openFile(file)。
    // 但按钮位于侧边栏，此时 getLeaf(false) 可能拿到侧边栏 leaf，
    // 所以再校正到主编辑区，并用 revealLeaf 激活，避免文件在后台标签页打开。
    let leaf = null;
    try {
      leaf = await Promise.resolve(workspace.getLeaf(false));
    } catch (e) {
      leaf = null;
    }

    const root = workspace.rootSplit;
    if (!leaf || (typeof leaf.getRoot === 'function' && root && leaf.getRoot() !== root)) {
      leaf = await Promise.resolve(workspace.getLeaf('tab'));
    }
    if (!leaf || typeof leaf.openFile !== 'function') {
      throw new Error('无法获取可用的编辑区标签页');
    }

    await leaf.openFile(file);
    if (typeof workspace.revealLeaf === 'function') {
      workspace.revealLeaf(leaf);
    }
  }

  /* ---------------- 视图与状态栏 ---------------- */

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];

    if (!leaf) {
      if (Platform.isMobile) {
        // 手机端没有右侧栏，明确使用标签页而不是 split
        leaf = await Promise.resolve(workspace.getLeaf('tab'));
      } else {
        // 桌面端优先在右侧边栏新建一个叶子，避免覆盖已有的侧边栏面板
        leaf = await Promise.resolve(workspace.getRightLeaf(true));
        if (!leaf) leaf = await Promise.resolve(workspace.getRightLeaf(false));
        // 极少数布局下没有右侧栏，退回主编辑区标签页
        if (!leaf) leaf = await Promise.resolve(workspace.getLeaf('tab'));
      }
      if (!leaf) {
        new Notice('无法打开复习列表：当前窗口没有可用的侧边栏');
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (typeof workspace.revealLeaf === 'function') workspace.revealLeaf(leaf);
  }

  refreshUI() {
    if (!this.data) return;

    const s = this.data.settings;
    const due = this.dueList();
    const dueCount = due.length;

    if (this.statusBarEl) {
      this.statusBarEl.classList.toggle('er-hidden', !s.showStatusBar);
      this.statusBarEl.textContent = s.paused ? '⏸ 漫游已暂停' : `漫游 ${dueCount}`;
      this.statusBarEl.title = `漫游复习：${dueCount} 篇到期（点击打开面板）`;
    }

    // 只有真正影响面板内容的状态变化时才重建 DOM，避免每分钟闪烁、打断滚动
    const active = this.app.workspace.getActiveFile();
    const activeState = active ? this.data.notes[active.path] : null;
    const signature = [
      dueCount,
      s.paused ? 1 : 0,
      s.autoAdvance ? 1 : 0,
      s.minDwellSeconds,
      s.listLimit,
      s.includeAll ? 1 : 0,
      (s.intervals || []).join(','),
      (s.folders || []).join('|'),
      (s.excludeFolders || []).join('|'),
      (s.excludeKeywords || []).join('|'),
      active ? active.path : '',
      activeState ? `${activeState.stage}:${activeState.nextDue}:${activeState.reviewCount}` : '',
      Object.keys(this.data.notes).length,
    ].join('§');

    if (signature === this._lastUISignature) return;
    this._lastUISignature = signature;

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (!view) continue;
      if (typeof view.renderSafe === 'function') view.renderSafe();
      else if (typeof view.render === 'function') view.render();
    }
  }

  /* ---------------- 文件事件 ---------------- */

  onRename(file, oldPath) {
    if (!file) return;
    const oldKey = S.normalizePathKey(oldPath);
    const newKey = S.normalizePathKey(file.path);

    if (file instanceof TFolder) {
      const prefix = oldKey + '/';
      const moves = [];
      for (const p of Object.keys(this.data.notes)) {
        if (p === oldKey || p.startsWith(prefix)) {
          moves.push([p, newKey + p.slice(oldKey.length)]);
        }
      }
      for (const [from, to] of moves) {
        this.data.notes[to] = this.data.notes[from];
        delete this.data.notes[from];
      }
      if (moves.length) this.scheduleSave();
    } else if (this.data.notes[oldKey]) {
      this.data.notes[newKey] = this.data.notes[oldKey];
      delete this.data.notes[oldKey];
      this.scheduleSave();
    } else if (this.data.settings.autoEnroll && S.inScope(newKey, this.data.settings)) {
      const first = S.parseIntervals(this.data.settings.intervals)[0] || 1;
      this.enrollOne(newKey, Date.now() + first * S.DAY_MS);
    }

    this.refreshUI();
  }

  onCreate(file) {
    if (this._enrolling) return;
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (!this.data.settings.autoEnroll) return;
    if (!S.inScope(file.path, this.data.settings)) return;
    if (this.data.notes[file.path]) return;

    const first = S.parseIntervals(this.data.settings.intervals)[0] || 1;
    this.enrollOne(file.path, Date.now() + first * S.DAY_MS);
    this.refreshUI();
  }

  /* ---------------- 导入导出 ---------------- */

  async exportData() {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const json = JSON.stringify(this.data, null, 2);

    // 手机端没有可靠的浏览器下载入口，直接写入附件目录，用户可在文件列表里取走
    if (Platform.isMobile) {
      const path = `${DATA_DIR}/ebbinghaus-roam-${stamp}.json`;
      try {
        await this.ensureDataDir();
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) await this.app.vault.modify(existing, json);
        else await this.app.vault.create(path, json);
        new Notice(`备份已保存到附件目录：${path}`, 5000);
      } catch (e) {
        new Notice('导出失败：' + (e && e.message ? e.message : e));
      }
      return;
    }

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ebbinghaus-roam-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    new Notice('复习数据已导出');
  }

  importData() {
    if (Platform.isMobile) {
      this.importDataMobile().catch((e) => {
        new Notice('导入失败：' + (e && e.message ? e.message : e));
      });
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        await this.applyImportedData(JSON.parse(text));
      } catch (e) {
        new Notice('导入失败：' + (e && e.message ? e.message : e));
      }
    });
    input.click();
  }

  /** 可导入的备份文件：附件目录优先，兼容旧版库根目录 */
  backupFiles() {
    const ROOTS = [DATA_DIR, ''];
    return this.app.vault
      .getFiles()
      .filter((f) => {
        if (!/^ebbinghaus-roam-.*\.json$/i.test(f.name)) return false;
        // 数据主文件不是备份，排除
        if (f.path === DATA_FILE) return false;
        const parent = (f.parent && f.parent.path) || '/';
        return ROOTS.some((r) => (r ? parent === r : parent === '/'));
      })
      .sort((a, b) => ((b.stat && b.stat.mtime) || 0) - ((a.stat && a.stat.mtime) || 0));
  }

  /** 手机端：从附件目录（兼容旧版库根目录）的 ebbinghaus-roam-*.json 备份中选择导入 */
  async importDataMobile() {
    const files = this.backupFiles();

    if (!files.length) {
      new Notice(
        `附件目录没有 ebbinghaus-roam-*.json 备份。请先在桌面端导出，或把备份文件放到 ${DATA_DIR}。`,
        6000
      );
      return;
    }

    new BackupFileModal(this.app, files, async (file) => {
      try {
        const text = await this.app.vault.read(file);
        await this.applyImportedData(JSON.parse(text));
      } catch (e) {
        new Notice('导入失败：' + (e && e.message ? e.message : e));
      }
    }).open();
  }

  async applyImportedData(parsed) {
    if (!parsed || typeof parsed !== 'object' || !parsed.notes || typeof parsed.notes !== 'object') {
      throw new Error('文件格式不正确');
    }

    const currentCount = Object.keys(this.data.notes).length;
    const incomingCount = Object.keys(parsed.notes).length;
    const ok = await confirmDialog(
      this.app,
      `导入将覆盖当前 ${currentCount} 条记录（备份含 ${incomingCount} 条）。继续？`,
      '覆盖导入'
    );
    if (!ok) return false;

    const settings = Object.assign({}, S.DEFAULT_SETTINGS, parsed.settings || {});
    settings.intervals = S.parseIntervals(settings.intervals);
    settings.folders = Array.isArray(settings.folders) ? settings.folders : [];
    settings.excludeFolders = Array.isArray(settings.excludeFolders)
      ? settings.excludeFolders
      : S.DEFAULT_SETTINGS.excludeFolders.slice();
    settings.excludeKeywords = Array.isArray(settings.excludeKeywords) ? settings.excludeKeywords : [];

    const notes = {};
    for (const [p, st] of Object.entries(parsed.notes)) {
      if (st && typeof st === 'object' && Number.isFinite(st.nextDue)) {
        notes[S.normalizePathKey(p)] = st;
      }
    }

    this.data = { version: 5, settings, notes };
    await this.saveSettingsNow();
    this.enrollScope(false);
    this.refreshUI();
    new Notice('复习数据已导入');
    return true;
  }

  async resetData() {
    const n = Object.keys(this.data.notes).length;
    if (!n) {
      new Notice('当前没有复习记录');
      return;
    }
    const ok = await confirmDialog(
      this.app,
      `确定清空全部 ${n} 条复习记录吗？此操作不可撤销，建议先导出备份。`,
      '清空'
    );
    if (!ok) return;

    this.data.notes = {};
    await this.saveSettingsNow();
    this.clearDwell();
    this.refreshUI();
    new Notice('复习记录已清空');
  }
}

/* ------------------------------------------------------------------ */
/* 侧边栏面板                                                          */
/* ------------------------------------------------------------------ */

class RoamView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '漫游复习';
  }

  getIcon() {
    return 'book-open';
  }

  async onOpen() {
    this.renderSafe();
  }

  async onClose() {
    this.contentEl.empty();
  }

  /** 渲染失败时把错误显示在面板里，避免整块空白无从排查 */
  renderSafe() {
    try {
      this.render();
      this._lastError = null;
    } catch (e) {
      this._lastError = e;
      console.error('[ebbinghaus-roam] 渲染复习面板失败', e);
      this.renderError(e);
    }
  }

  renderError(err) {
    const root = this.contentEl;
    root.empty();
    root.addClass('er-view');
    root.createEl('h4', { text: '漫游复习面板加载失败' });
    root.createEl('p', { text: String((err && err.message) || err) });
    const stack = String((err && err.stack) || err).slice(0, 1500);
    const pre = root.createEl('pre', { text: stack });
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.fontSize = 'var(--font-ui-smaller)';
    const btn = root.createEl('button', { cls: 'er-btn', text: '重试' });
    btn.addEventListener('click', () => this.renderSafe());
  }

  render() {
    const plugin = this.plugin;
    // 布局恢复可能早于插件数据载入，此时跳过，onLayoutReady 会再渲染一次
    if (!plugin || !plugin.data || !plugin.data.settings) return;

    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    root.empty();
    root.addClass('er-view');

    const s = plugin.data.settings;
    const now = Date.now();
    const due = plugin.dueList();
    const scope = plugin.scopeFiles();
    const enrolled = scope.filter((f) => plugin.data.notes[f.path]).length;

    const header = root.createDiv('er-header');
    header.createDiv('er-title', { text: '漫游复习' });
    const stats = header.createDiv('er-stats');
    stats.createSpan({ cls: 'er-stat', text: `到期 ${due.length}` });
    stats.createSpan({ cls: 'er-stat', text: `范围内 ${scope.length}` });
    stats.createSpan({ cls: 'er-stat', text: `已纳入 ${enrolled}` });

    if (s.paused) {
      root.createDiv('er-paused', { text: '⏸ 自动记录已暂停，仍可手动评分' });
    }

    const actions = root.createDiv('er-actions');
    const startBtn = actions.createEl('button', { cls: 'er-btn mod-cta', text: '开始漫游' });
    startBtn.addEventListener('click', () => {
      plugin.startRoam(false).catch((e) => {
        new Notice('打开失败：' + (e && e.message ? e.message : e), 5000);
      });
    });
    const randBtn = actions.createEl('button', { cls: 'er-btn', text: '随机一篇' });
    randBtn.addEventListener('click', () => {
      plugin.startRoam(true).catch((e) => {
        new Notice('打开失败：' + (e && e.message ? e.message : e), 5000);
      });
    });
    const pauseBtn = actions.createEl('button', { cls: 'er-btn', text: s.paused ? '恢复记录' : '暂停记录' });
    pauseBtn.addEventListener('click', () => plugin.togglePause());

    const active = this.app.workspace.getActiveFile();
    if (active && active instanceof TFile && active.extension === 'md') {
      this.renderCurrent(root, active, now);
    }

    const listHead = root.createDiv('er-section-head');
    listHead.createSpan({ cls: 'er-section-title', text: '到期笔记' });
    if (due.length) listHead.createSpan({ cls: 'er-count', text: String(due.length) });

    if (!due.length) {
      root.createDiv('er-empty', { text: '今天没有到期的笔记，休息一下吧。' });
    } else {
      const list = root.createDiv('er-list');
      const limit = Math.max(20, Number(s.listLimit) || 200);
      due.slice(0, limit).forEach((item) => this.renderRow(list, item, now));
      if (due.length > limit) {
        root.createDiv('er-more', {
          text: `还有 ${due.length - limit} 篇未显示，可在设置里调高“列表显示上限”。`,
        });
      }
    }

    // 侧边栏常驻：再列一批即将到期的笔记，保证任何时刻都能看到列表
    const upcoming = plugin.upcomingList(due.length ? 8 : 20);
    if (upcoming.length) {
      const nextHead = root.createDiv('er-section-head');
      nextHead.createSpan({
        cls: 'er-section-title',
        text: due.length ? '接下来' : '即将到期',
      });
      nextHead.createSpan({ cls: 'er-count', text: String(upcoming.length) });
      const nextList = root.createDiv('er-list');
      upcoming.forEach((item) => this.renderRow(nextList, item, now));
    } else if (!due.length) {
      root.createDiv('er-empty', { text: '范围内还没有可漫游的笔记，请先在设置中确认范围。' });
    }

    if (scrollTop) root.scrollTop = scrollTop;
  }

  renderCurrent(root, file, now) {
    const plugin = this.plugin;
    const s = plugin.data.settings;
    const inScope = S.inScope(file.path, s);
    const st = plugin.data.notes[file.path];

    const card = root.createDiv('er-current');
    const top = card.createDiv('er-current-top');
    top.createSpan({ cls: 'er-current-name', text: S.pathBasename(file.path) });
    top.createSpan({ cls: 'er-current-dir', text: S.pathDirname(file.path) || '/' });

    if (!inScope) {
      card.createDiv({ cls: 'er-current-note', text: '当前笔记不在复习范围内。' });
      return;
    }

    if (!st) {
      card.createDiv({ cls: 'er-current-note', text: '这篇笔记尚未纳入复习队列。' });
      const btn = card.createEl('button', { cls: 'er-btn', text: '纳入复习' });
      btn.addEventListener('click', async () => {
        plugin.enrollOne(file.path, now);
        await plugin.saveSettingsNow();
        plugin.refreshUI();
      });
      return;
    }

    const meta = card.createDiv('er-current-meta');
    meta.createSpan({ text: S.stageLabel(st, s.intervals) });
    meta.createSpan({ text: `已复习 ${Number(st.reviewCount) || 0} 次` });
    const dueNow = S.isDue(st, now);
    meta.createSpan({
      cls: dueNow ? 'er-due-now' : 'er-due-later',
      text: dueNow ? `已到期 · ${S.formatDue(st.nextDue, now)}` : `下次：${S.formatDue(st.nextDue, now)}`,
    });

    const total = S.parseIntervals(s.intervals).length;
    const pct = Math.round(((Math.min(Math.max(0, Number(st.stage) || 0), total - 1) + 1) / total) * 100);
    const bar = card.createDiv('er-progress');
    const fill = bar.createDiv('er-progress-fill');
    fill.style.width = pct + '%';

    const grades = card.createDiv('er-grades');
    const gradeDefs = [
      ['remember', '记得'],
      ['fuzzy', '模糊'],
      ['forgot', '忘了'],
    ];
    gradeDefs.forEach(([g, label], i) => {
      const b = grades.createEl('button', {
        cls: 'er-btn er-grade' + (i === 0 ? ' mod-cta' : ''),
        text: label,
      });
      b.addEventListener('click', () => plugin.gradePath(file.path, g));
    });
  }

  renderRow(listEl, item, now) {
    const plugin = this.plugin;
    const row = listEl.createDiv('er-item');
    row.title = item.path;

    const main = row.createDiv('er-item-main');
    main.createSpan({ cls: 'er-item-title', text: S.pathBasename(item.path) });
    const dir = S.pathDirname(item.path);
    if (dir) main.createSpan({ cls: 'er-item-dir', text: dir });

    const badge = row.createSpan({ cls: 'er-badge', text: S.formatDue(item.state.nextDue, now) });
    if (S.isDue(item.state, now)) badge.addClass('er-badge-due');

    row.addEventListener('click', () => plugin.openPath(item.path));
  }
}

/* ------------------------------------------------------------------ */
/* 手机端备份文件选择                                                  */
/* ------------------------------------------------------------------ */

class BackupFileModal extends SuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder('选择要导入的备份文件…');
  }

  getSuggestions(query) {
    const q = String(query || '').toLowerCase();
    return this.files.filter((f) => f.name.toLowerCase().includes(q));
  }

  renderSuggestion(file, el) {
    el.createDiv({ text: file.name });
    const parent = (file.parent && file.parent.path) || '/';
    el.createDiv({ cls: 'er-suggest-path', text: parent === '/' ? '库根目录（旧版）' : parent });
  }

  onChooseSuggestion(file) {
    this.onChoose(file);
  }
}

/* ------------------------------------------------------------------ */
/* 确认对话框（手机端 WebView 对 window.confirm 支持不一致，统一用 Modal） */
/* ------------------------------------------------------------------ */

class ConfirmModal extends Modal {
  constructor(app, message, ctaText, resolve) {
    super(app);
    this.message = message;
    this.ctaText = ctaText || '确定';
    this._resolve = resolve;
    this._done = false;
  }

  onOpen() {
    this.titleEl.setText('漫游复习');
    this.contentEl.createEl('p', { text: this.message });
    const row = this.contentEl.createDiv('er-modal-actions');
    const cancel = row.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.finish(false));
    const ok = row.createEl('button', { cls: 'mod-warning', text: this.ctaText });
    ok.addEventListener('click', () => this.finish(true));
  }

  onClose() {
    this.contentEl.empty();
    if (!this._done) {
      this._done = true;
      this._resolve(false);
    }
  }

  finish(value) {
    if (this._done) return;
    this._done = true;
    this._resolve(value);
    this.close();
  }
}

function confirmDialog(app, message, ctaText) {
  return new Promise((resolve) => {
    new ConfirmModal(app, message, ctaText, resolve).open();
  });
}

/* ------------------------------------------------------------------ */
/* 设置页                                                              */
/* ------------------------------------------------------------------ */

class RoamSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('er-settings');

    const s = this.plugin.data.settings;

    new Setting(containerEl).setName('漫游复习').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '按遗忘曲线调度整篇笔记的复习。插件只读取笔记路径与修改时间，复习进度保存在插件自己的 data.json，不修改笔记内容或 frontmatter。',
    });

    /* ---------------- 范围 ---------------- */

    new Setting(containerEl).setName('复习范围').setHeading();

    new Setting(containerEl)
      .setName('全库笔记')
      .setDesc('开启时复习所有笔记（仍应用下面的排除规则）；关闭后只复习勾选的文件夹。')
      .addToggle((t) =>
        t.setValue(!!s.includeAll).onChange(async (v) => {
          s.includeAll = v;
          await this.plugin.saveSettingsNow();
          this.plugin.rescheduleUnreviewed();
          this.plugin.enrollScope(false);
          this.plugin.refreshUI();
          this.display();
        })
      );

    if (!s.includeAll) {
      this.renderFolderPicker('选择要复习的文件夹（勾选后包含其所有子文件夹）', s.folders, async (folders) => {
        s.folders = folders;
        await this.plugin.saveSettingsNow();
        this.plugin.rescheduleUnreviewed();
        this.plugin.enrollScope(false);
        this.plugin.refreshUI();
      });
    }

    new Setting(containerEl)
      .setName('排除文件夹')
      .setDesc('每行一个。只写名称（如“模板”）会排除任意层级的同名文件夹；含“/”时按路径前缀排除。')
      .addTextArea((t) => {
        t.setValue((s.excludeFolders || []).join('\n'));
        t.inputEl.rows = 4;
        t.onChange((v) => {
          s.excludeFolders = v
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean);
          this.plugin.scheduleSave();
        });
        t.inputEl.addEventListener('blur', () => {
          this.plugin.rescheduleUnreviewed();
          this.plugin.enrollScope(false);
          this.plugin.refreshUI();
        });
      });

    new Setting(containerEl)
      .setName('排除关键词')
      .setDesc('每行一个，路径中包含该词就不纳入。例如：草稿、剪藏。')
      .addTextArea((t) => {
        t.setValue((s.excludeKeywords || []).join('\n'));
        t.inputEl.rows = 3;
        t.onChange((v) => {
          s.excludeKeywords = v
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean);
          this.plugin.scheduleSave();
        });
        t.inputEl.addEventListener('blur', () => {
          this.plugin.rescheduleUnreviewed();
          this.plugin.enrollScope(false);
          this.plugin.refreshUI();
        });
      });

    /* ---------------- 曲线 ---------------- */

    new Setting(containerEl).setName('遗忘曲线').setHeading();

    let presetValue = 'custom';
    for (const [key, arr] of Object.entries(S.PRESETS)) {
      if (JSON.stringify(arr) === JSON.stringify(S.parseIntervals(s.intervals))) {
        presetValue = key;
        break;
      }
    }

    new Setting(containerEl)
      .setName('预设曲线')
      .setDesc('选择预设会覆盖下面的自定义间隔。')
      .addDropdown((d) => {
        d.addOption('custom', '自定义');
        for (const [key, label] of Object.entries(S.PRESET_LABELS)) d.addOption(key, label);
        d.setValue(presetValue);
        d.onChange(async (v) => {
          if (v === 'custom') return;
          s.intervals = S.PRESETS[v].slice();
          await this.plugin.saveSettingsNow();
          this.plugin.refreshUI();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('自定义间隔（天）')
      .setDesc('逗号或空格分隔，自动去重升序。默认：1, 2, 4, 7, 15, 30, 60, 120, 240')
      .addText((t) => {
        t.setValue(S.intervalsToText(s.intervals));
        t.onChange((v) => {
          s.intervals = S.parseIntervals(v);
          this.plugin.scheduleSave();
        });
        t.inputEl.addEventListener('blur', () => {
          t.setValue(S.intervalsToText(s.intervals));
          this.plugin.refreshUI();
        });
      });

    /* ---------------- 行为 ---------------- */

    new Setting(containerEl).setName('复习行为').setHeading();

    new Setting(containerEl)
      .setName('自动晋级')
      .setDesc('打开到期笔记并停留达到阈值后，自动记为“记得”并进入下一档。')
      .addToggle((t) =>
        t.setValue(!!s.autoAdvance).onChange(async (v) => {
          s.autoAdvance = v;
          this.plugin.clearDwell();
          await this.plugin.saveSettingsNow();
          this.plugin.refreshUI();
        })
      );

    new Setting(containerEl)
      .setName('停留阈值（秒）')
      .setDesc('打开笔记后停留多久才自动算一次复习。设为 0 表示打开即算。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.min = '0';
        t.setValue(String(s.minDwellSeconds));
        t.onChange((v) => {
          s.minDwellSeconds = Math.max(0, Math.round(Number(v) || 0));
          this.plugin.clearDwell();
          this.plugin.scheduleSave();
        });
      });

    new Setting(containerEl)
      .setName('记录打开时间')
      .setDesc('打开笔记时更新“最近打开”时间，作为调度参考。')
      .addToggle((t) =>
        t.setValue(!!s.autoRecordOpen).onChange(async (v) => {
          s.autoRecordOpen = v;
          await this.plugin.saveSettingsNow();
        })
      );

    new Setting(containerEl)
      .setName('自动纳入新笔记')
      .setDesc('范围内新建或移入的笔记自动进入复习队列（第一次复习安排在 1 天后）。')
      .addToggle((t) =>
        t.setValue(!!s.autoEnroll).onChange(async (v) => {
          s.autoEnroll = v;
          await this.plugin.saveSettingsNow();
        })
      );

    new Setting(containerEl)
      .setName('每次漫游随机挑选')
      .setDesc('关闭时按逾期时间从久到近顺序打开。')
      .addToggle((t) =>
        t.setValue(!!s.randomOrder).onChange(async (v) => {
          s.randomOrder = v;
          await this.plugin.saveSettingsNow();
        })
      );

    new Setting(containerEl)
      .setName('每次漫游上限')
      .setDesc('“开始漫游”最多从多少篇到期笔记中挑选；0 表示不限制。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.min = '0';
        t.setValue(String(s.dailyLimit));
        t.onChange((v) => {
          s.dailyLimit = Math.max(0, Math.round(Number(v) || 0));
          this.plugin.scheduleSave();
        });
      });

    new Setting(containerEl)
      .setName('列表显示上限')
      .setDesc('侧边栏一次最多渲染多少条到期笔记，避免卡顿。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.min = '20';
        t.setValue(String(s.listLimit));
        t.onChange((v) => {
          s.listLimit = Math.max(20, Math.round(Number(v) || 200));
          this.plugin.scheduleSave();
          this.plugin.refreshUI();
        });
      });

    new Setting(containerEl)
      .setName('状态栏显示到期数')
      .setDesc('在底部状态栏显示当前到期笔记数量，点击可打开面板。')
      .addToggle((t) =>
        t.setValue(!!s.showStatusBar).onChange(async (v) => {
          s.showStatusBar = v;
          await this.plugin.saveSettingsNow();
          this.plugin.refreshUI();
        })
      );

    /* ---------------- 首次纳入 ---------------- */

    new Setting(containerEl).setName('首次纳入').setHeading();

    new Setting(containerEl)
      .setName('初始铺开天数')
      .setDesc('首次启用时，按笔记最后修改时间把第一轮复习均匀铺到未来这么多天，越旧的笔记越先到期。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.min = '0';
        t.setValue(String(s.initialSpreadDays));
        t.onChange((v) => {
          s.initialSpreadDays = Math.max(0, Math.round(Number(v) || 0));
          this.plugin.scheduleSave();
        });
      });

    new Setting(containerEl)
      .setName('2027 国省考预设')
      .setDesc('按国考 2026-11-29、省考 2026-12-06 倒排：5 个备考文件夹（约 807 篇）、18 天铺开、1/3/7/14/21 天曲线、每天约 45 篇。')
      .addButton((b) =>
        b.setButtonText('应用').onClick(async () => {
          const n = this.plugin.applyExamPreset2027();
          await this.plugin.saveSettingsNow();
          this.plugin.refreshUI();
          new Notice(`已应用 2027 公考预设，重排 ${n} 篇未复习笔记`);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('按当前范围重新铺开')
      .setDesc('把当前范围内从未复习过的笔记按最后修改时间重新铺到未来 N 天，最旧的立即到期；已复习过的进度不受影响。')
      .addButton((b) =>
        b.setButtonText('重新铺开').onClick(async () => {
          const n = this.plugin.rescheduleUnreviewed();
          await this.plugin.saveSettingsNow();
          this.plugin.refreshUI();
          new Notice(`已重新铺开 ${n} 篇未复习笔记`);
        })
      );

    new Setting(containerEl)
      .setName('扫描并纳入')
      .setDesc('立即把范围内尚未纳入的笔记加入队列（新笔记从 1 天后开始）。')
      .addButton((b) =>
        b.setButtonText('扫描').onClick(async () => {
          await this.plugin.scanNow(false);
          this.display();
        })
      );

    /* ---------------- 数据管理 ---------------- */

    new Setting(containerEl).setName('数据管理').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '复习进度保存在附件目录的 ebbinghaus-roam-data.json，随笔记同步到手机，桌面与安卓共用同一份数据。' +
        '改动会实时写入，另一端同步后自动合并，日常不需要导入导出；导出仅用于手动备份。' +
        '插件目录的 data.json 仅用于旧数据迁移，不再更新。',
    });

    new Setting(containerEl)
      .setName('导出复习数据')
      .setDesc('导出 JSON 备份（含设置与全部复习记录）。')
      .addButton((b) => b.setButtonText('导出').onClick(() => this.plugin.exportData()));

    new Setting(containerEl)
      .setName('导入复习数据')
      .setDesc('从 JSON 备份恢复，会覆盖当前设置与记录。')
      .addButton((b) => b.setButtonText('导入').onClick(() => this.plugin.importData()));

    new Setting(containerEl)
      .setName('清空复习记录')
      .setDesc('只清空进度，不删除笔记。操作不可撤销，建议先导出备份。')
      .addButton((b) => {
        b.setButtonText('清空');
        b.buttonEl.addClass('mod-warning');
        b.onClick(() => this.plugin.resetData());
      });

    containerEl.createEl('p', {
      cls: 'er-version',
      text: `Ebbinghaus Roam v${this.plugin.manifest.version} · 当前记录 ${Object.keys(this.plugin.data.notes).length} 篇`,
    });
  }

  renderFolderPicker(title, selected, onChange) {
    const wrap = this.containerEl.createDiv('er-folder-picker');
    wrap.createDiv({ cls: 'er-folder-title', text: title });

    const searchInput = wrap.createEl('input', {
      type: 'text',
      cls: 'er-folder-search',
      placeholder: '搜索文件夹…',
    });

    const listEl = wrap.createDiv('er-folder-list');
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path && f.path !== '/')
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b, 'zh'));

    let filter = '';
    const render = () => {
      listEl.empty();
      const shown = folders.filter((p) => !filter || p.toLowerCase().includes(filter.toLowerCase()));
      if (!shown.length) {
        listEl.createDiv({ cls: 'er-empty', text: '没有匹配的文件夹' });
        return;
      }
      for (const p of shown) {
        const row = listEl.createEl('label', { cls: 'er-folder-row' });
        const cb = row.createEl('input', { type: 'checkbox' });
        cb.checked = selected.includes(p);
        row.style.paddingLeft = (p.split('/').length - 1) * 14 + 'px';
        row.createSpan({ text: p });
        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (!selected.includes(p)) selected.push(p);
          } else {
            const i = selected.indexOf(p);
            if (i >= 0) selected.splice(i, 1);
          }
          onChange(selected.slice());
        });
      }
    };

    searchInput.addEventListener('input', () => {
      filter = searchInput.value;
      render();
    });

    render();
  }
}

/* ------------------------------------------------------------------ */

// 供 node 测试读取纯调度逻辑，不影响 Obsidian 加载
EbbinghausRoamPlugin.__scheduler = S;

module.exports = EbbinghausRoamPlugin;
