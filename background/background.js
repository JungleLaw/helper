// background.js — Service Worker
// 自动控制针对 TEMU 域名启用或休眠插件功能

// 全局默认禁用组件
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.disable();
  chrome.sidePanel.setOptions({ enabled: false });
});

// 让侧边栏跟随 action 按钮自动点按呼出
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

function updateState(tabId, urlStr) {
  if (!urlStr) return;
  
  let isTemu = false;
  try {
    const url = new URL(urlStr);
    isTemu = url.hostname.endsWith('kuajingmaihuo.com') || url.hostname.endsWith('temu.com');
  } catch (e) {}
  
  if (isTemu) {
    chrome.action.enable(tabId);
    chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel/panel.html',
      enabled: true,
    });
  } else {
    chrome.action.disable(tabId);
    chrome.sidePanel.setOptions({
      tabId,
      enabled: false,
    });
  }
}

// 页面加载或更新时检查
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  updateState(tabId, tab.url);
});

// 切换不同标签页时检查
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    updateState(tab.id, tab.url);
  } catch (e) {}
});
