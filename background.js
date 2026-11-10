// Toolbar button or Alt+Shift+C -> toggle the picker in the active tab (top frame).
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ACI_TOGGLE' }, { frameId: 0 }).catch(() => {});
});
