const DEFAULTS = {
  enabled: true,
  translateContent: true,
  machineFallback: true,
  provider: 'google',
  targetLang: 'zh-CN',
  glossary: '',
  floatingButton: false,
  showOriginalOnHover: false,
};

const PROVIDER_LABEL = {
  google: 'Google（免密钥）',
  deepl: 'DeepL API',
  azure: 'Microsoft Translator',
  openai: 'OpenAI 兼容接口',
};

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let activeTab = null;

async function loadSettings() {
  const { settings: stored } = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULTS, ...(stored || {}) };
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set({ settings });
  render();
}

function render() {
  $('enabled').checked = !!settings.enabled;
  for (const btn of document.querySelectorAll('#mode button')) {
    btn.classList.toggle('active', btn.dataset.mode === (settings.translateContent ? 'full' : 'ui'));
    btn.disabled = !settings.enabled;
  }
  $('machineFallback').checked = !!settings.machineFallback;
  $('machineFallback').disabled = !settings.enabled;
  $('provider-name').textContent = PROVIDER_LABEL[settings.provider] || settings.provider;
  $('tip').textContent = settings.provider === 'google'
    ? '不配置也能用：默认走免密钥的 Google 翻译端点。'
    : '已选择第三方翻译服务，Key 与模型在「设置」里配置。';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isGitHub(url) {
  return typeof url === 'string' && /^https:\/\/(gist\.)?github\.com\//.test(url);
}

function sendToTab(payload) {
  return new Promise((resolve) => {
    if (!activeTab || !activeTab.id) { resolve(null); return; }
    chrome.tabs.sendMessage(activeTab.id, payload, (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp || null);
    });
  });
}

function showError(text) {
  const el = $('error');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = text;
}

async function refreshStats() {
  if (!isGitHub(activeTab?.url)) {
    $('status').textContent = '当前页面不是 GitHub';
    $('stat-ui').textContent = '—';
    $('stat-content').textContent = '—';
    $('stat-dict').textContent = '—';
    $('retranslate').disabled = true;
    $('revert').disabled = true;
    return;
  }
  const status = await sendToTab({ type: 'ghzh:status' });
  if (!status || !status.ok) {
    $('status').textContent = '请刷新 GitHub 页面后重试';
    $('stat-ui').textContent = '0';
    $('stat-content').textContent = '0';
    $('stat-dict').textContent = '—';
    return;
  }
  $('stat-ui').textContent = status.count ?? 0;
  $('stat-content').textContent = status.contentCount ?? 0;
  $('stat-dict').textContent = status.dictEntries ?? '—';
  const extra = status.machineCount ? ` · 机翻补全 ${status.machineCount}` : '';
  const pass = status.timings?.lastPassMs ? ` · 单块 ${status.timings.lastPassMs}ms` : '';
  $('status').textContent = (status.enabled ? '运行中' : '已停止') + extra + pass;
  if (status.lastError) showError(`翻译服务错误：${status.lastError}`);
  else showError('');
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  render();

  const manifest = chrome.runtime.getManifest();
  $('version').textContent = `v${manifest.version}`;
  activeTab = await getActiveTab();
  await refreshStats();

  $('enabled').addEventListener('change', async (e) => {
    await saveSettings({ enabled: e.target.checked });
    if (e.target.checked) setTimeout(refreshStats, 400);
    else { $('stat-ui').textContent = '0'; $('stat-content').textContent = '0'; $('status').textContent = '已停止'; }
  });

  for (const btn of document.querySelectorAll('#mode button')) {
    btn.addEventListener('click', async () => {
      await saveSettings({ translateContent: btn.dataset.mode === 'full' });
      setTimeout(refreshStats, 600);
    });
  }

  $('machineFallback').addEventListener('change', async (e) => {
    await saveSettings({ machineFallback: e.target.checked });
    setTimeout(refreshStats, 800);
  });

  $('retranslate').addEventListener('click', async () => {
    const resp = await sendToTab({ type: 'ghzh:retranslate' });
    if (!resp) showError('无法连接页面脚本，请刷新 GitHub 页面');
    setTimeout(refreshStats, 500);
  });

  $('revert').addEventListener('click', async () => {
    await sendToTab({ type: 'ghzh:revert' });
    await saveSettings({ enabled: false });
    $('stat-ui').textContent = '0';
    $('stat-content').textContent = '0';
    $('status').textContent = '已还原英文';
    showError('');
  });

  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
