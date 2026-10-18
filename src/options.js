const DEFAULTS = {
  enabled: true,
  translateContent: true,
  machineFallback: true,
  provider: 'google',
  targetLang: 'zh-CN',
  glossary: '',
  floatingButton: false,
  showOriginalOnHover: false,
  deeplKey: '',
  deeplPro: false,
  azureKey: '',
  azureRegion: '',
  openaiBase: 'https://api.openai.com/v1',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
};

const TEXT_FIELDS = [
  'targetLang', 'provider', 'glossary',
  'deeplKey', 'azureKey', 'azureRegion',
  'openaiBase', 'openaiKey', 'openaiModel',
];
const CHECK_FIELDS = ['enabled', 'translateContent', 'machineFallback', 'floatingButton', 'showOriginalOnHover', 'deeplPro'];

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };

function setSaveState(text, cls = 'muted') {
  const el = $('save-state');
  el.textContent = text;
  el.className = cls;
  if (cls !== 'muted') {
    clearTimeout(setSaveState.timer);
    setSaveState.timer = setTimeout(() => { el.textContent = ''; el.className = 'muted'; }, 2600);
  }
}

function syncProviderBlocks() {
  const provider = $('provider').value;
  for (const block of document.querySelectorAll('.provider-block')) {
    block.classList.toggle('active', block.dataset.provider === provider);
  }
}

function readForm() {
  const next = { ...settings };
  for (const name of CHECK_FIELDS) next[name] = $(name).checked;
  for (const name of TEXT_FIELDS) next[name] = $(name).value;
  return next;
}

function fillForm(values) {
  for (const name of CHECK_FIELDS) $(name).checked = !!values[name];
  for (const name of TEXT_FIELDS) $(name).value = values[name] ?? DEFAULTS[name] ?? '';
  syncProviderBlocks();
}

async function save() {
  const next = readForm();
  if ((next.glossary || '').length > 7000) {
    setSaveState('自定义词条过长，请精简到 7000 字以内', 'bad');
    return false;
  }
  try {
    await chrome.storage.sync.set({ settings: next });
    settings = next;
    setSaveState('已保存', 'ok');
    return true;
  } catch (err) {
    // sync 配额不足时退回 local，保证功能可用
    try {
      await chrome.storage.local.set({ settingsFallback: next });
      setSaveState('同步存储已满，设置已存到本地（换设备不会同步）', 'bad');
      settings = next;
      return true;
    } catch (e) {
      setSaveState(`保存失败：${err.message || err}`, 'bad');
      return false;
    }
  }
}

async function testConnection() {
  const resultEl = $('test-result');
  resultEl.textContent = '正在测试…';
  resultEl.className = 'muted';
  const saved = await save();
  if (!saved) { resultEl.textContent = ''; return; }
  chrome.runtime.sendMessage({ type: 'ghzh:test' }, (resp) => {
    if (chrome.runtime.lastError) {
      resultEl.textContent = `后台无响应：${chrome.runtime.lastError.message}`;
      resultEl.className = 'bad';
      return;
    }
    if (resp && resp.ok) {
      resultEl.textContent = `成功：Hello, world! → ${resp.sample}`;
      resultEl.className = 'ok';
    } else {
      resultEl.textContent = `失败：${resp ? resp.error : '未知错误'}`;
      resultEl.className = 'bad';
    }
  });
}

async function clearCache() {
  const el = $('cache-result');
  el.textContent = '清理中…';
  chrome.runtime.sendMessage({ type: 'ghzh:clearCache' }, (resp) => {
    if (chrome.runtime.lastError) {
      el.textContent = `失败：${chrome.runtime.lastError.message}`;
      return;
    }
    el.textContent = resp && resp.ok ? `已清空 ${resp.removed} 条缓存` : '清理失败';
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.sync.get('settings');
  let values = stored.settings;
  if (!values) {
    const fallback = await chrome.storage.local.get('settingsFallback');
    values = fallback.settingsFallback;
  }
  settings = { ...DEFAULTS, ...(values || {}) };
  fillForm(settings);

  $('provider').addEventListener('change', syncProviderBlocks);
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', testConnection);
  $('clear-cache').addEventListener('click', clearCache);

  // 改动即提示未保存
  for (const el of document.querySelectorAll('input, select, textarea')) {
    el.addEventListener('input', () => setSaveState('有未保存的修改'));
    el.addEventListener('change', () => setSaveState('有未保存的修改'));
  }
});
