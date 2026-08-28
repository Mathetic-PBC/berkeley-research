'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const STANDARD = 'curl -fsSL https://berkeley.mathetic.com/engelbart/install.sh | sh';
const DEVELOPER = 'npx engelbart-cli';

function fakeElement(mode) {
  const listeners = {};
  const classes = new Set(mode ? ['dm-install-tab'] : []);
  const attrs = mode ? { 'data-install-mode': mode } : {};
  return {
    textContent: '',
    addEventListener(kind, fn) { listeners[kind] = fn; },
    click() { listeners.click(); },
    getAttribute(name) { return attrs[name] || null; },
    setAttribute(name, value) { attrs[name] = value; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force) classes.add(name); else classes.delete(name);
      },
    },
  };
}

test('the landing page defaults to the standard installer', () => {
  const page = fs.readFileSync(path.join(ROOT, 'engelbart', 'index.html'), 'utf8');
  assert.match(page, new RegExp(STANDARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(page, /data-install-mode="standard" aria-pressed="true"/);
  assert.match(page, /data-install-mode="developer" aria-pressed="false"/);
});

test('each tab copies the command it switches to', () => {
  const copyButton = fakeElement();
  const copyIcon = fakeElement();
  const commandText = fakeElement();
  const standard = fakeElement('standard');
  const developer = fakeElement('developer');
  const copied = [];
  const byId = {
    'copy-cmd': copyButton,
    'copy-cmd-icon': copyIcon,
    'install-command': commandText,
  };
  const context = {
    document: {
      getElementById(id) { return byId[id] || null; },
      querySelectorAll() { return [standard, developer]; },
    },
    navigator: { clipboard: { writeText(text) { copied.push(text); return Promise.resolve(); } } },
    setTimeout() { return 1; },
    clearTimeout() {},
    console,
  };
  const source = fs.readFileSync(path.join(ROOT, 'engelbart', 'demo.js'), 'utf8');
  vm.runInNewContext(source, context);

  developer.click();
  assert.equal(commandText.textContent, DEVELOPER);
  assert.equal(copied.at(-1), DEVELOPER);
  assert.equal(developer.getAttribute('aria-pressed'), 'true');

  standard.click();
  assert.equal(commandText.textContent, STANDARD);
  assert.equal(copied.at(-1), STANDARD);
  assert.equal(standard.getAttribute('aria-pressed'), 'true');

  developer.click();
  copyButton.click();
  assert.equal(copied.at(-1), DEVELOPER);
});
