'use strict';

/*
 * 最小 Obsidian DOM mock。
 *
 * 关键点：Obsidian 的 createDiv/createSpan/createEl 第二个（或第三个）参数
 * 是回调函数，不是配置对象。传对象会抛 TypeError —— 这里按同样语义实现，
 * 让测试能复现真实客户端的行为。
 */

class ClassList {
  constructor() {
    this._tokens = new Set();
  }
  add(...names) {
    for (const name of names) {
      String(name)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((t) => this._tokens.add(t));
    }
  }
  remove(...names) {
    for (const name of names) {
      String(name)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((t) => this._tokens.delete(t));
    }
  }
  contains(name) {
    return this._tokens.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this._tokens.has(name) : !!force;
    if (on) this._tokens.add(name);
    else this._tokens.delete(name);
    return on;
  }
  get length() {
    return this._tokens.size;
  }
  toString() {
    return Array.from(this._tokens).join(' ');
  }
}

class MockElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new ClassList();
    this.style = {};
    this.title = '';
    this.scrollTop = 0;
    this._text = '';
    this._attrs = {};
    this._listeners = {};
  }

  get className() {
    return this.classList.toString();
  }
  set className(value) {
    this.classList = new ClassList();
    this.classList.add(value);
  }

  get childElementCount() {
    return this.children.length;
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this._text = value == null ? '' : String(value);
    this.children = [];
  }

  addClass(...names) {
    this.classList.add(...names);
    return this;
  }
  removeClass(...names) {
    this.classList.remove(...names);
    return this;
  }
  toggleClass(name, force) {
    this.classList.toggle(name, force);
    return this;
  }
  hasClass(name) {
    return this.classList.contains(name);
  }
  setText(text) {
    this.textContent = text;
    return this;
  }

  setAttr(key, value) {
    this._attrs[key] = String(value);
    return this;
  }
  setAttrs(obj) {
    for (const key of Object.keys(obj || {})) this.setAttr(key, obj[key]);
    return this;
  }
  getAttribute(key) {
    return Object.prototype.hasOwnProperty.call(this._attrs, key) ? this._attrs[key] : null;
  }
  setAttribute(key, value) {
    this.setAttr(key, value);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  empty() {
    this.children = [];
    this._text = '';
    return this;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  click() {
    for (const fn of this._listeners.click || []) fn({ type: 'click', target: this });
  }

  _applyInfo(info) {
    if (info == null) return;
    if (typeof info === 'string') {
      this.addClass(info);
      return;
    }
    if (typeof info !== 'object') {
      throw new TypeError('DomElementInfo 必须是字符串或对象');
    }
    if (Array.isArray(info.cls)) info.cls.forEach((c) => this.addClass(c));
    else if (info.cls) this.addClass(info.cls);
    if (info.text !== undefined) this.textContent = info.text;
    if (info.title !== undefined) this.title = String(info.title);
    if (info.attr) {
      for (const [key, value] of Object.entries(info.attr)) {
        if (value !== null && value !== undefined && value !== false) this.setAttr(key, value);
      }
    }
    for (const key of ['type', 'value', 'placeholder', 'href']) {
      if (info[key] !== undefined) this[key] = info[key];
    }
  }

  createEl(tag, info, callback) {
    // 兼容 createEl('div', callback)
    if (typeof info === 'function') {
      callback = info;
      info = undefined;
    }
    const el = new MockElement(tag);
    el._applyInfo(info);
    this.appendChild(el);

    // 与 Obsidian 一致：后续参数是回调，不是配置对象
    if (callback !== undefined) {
      if (typeof callback !== 'function') {
        throw new TypeError('callback is not a function');
      }
      callback(el);
    }
    return el;
  }

  createDiv(info, callback) {
    return this.createEl('div', info, callback);
  }
  createSpan(info, callback) {
    return this.createEl('span', info, callback);
  }
}

function createEl(tag) {
  return new MockElement(tag || 'div');
}

module.exports = { MockElement, createEl };
