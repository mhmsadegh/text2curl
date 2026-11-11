/* global importScripts, T2CAI */
importScripts('ai.js');

// Toolbar button or Alt+Shift+C -> toggle the picker in the active tab (top frame).
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ACI_TOGGLE' }, { frameId: 0 }).catch(() => {});
});

// The key lives in session storage (memory) unless the user chose "Remember". Keep session storage
// out of reach of content scripts (this is Chrome's default; set it explicitly).
if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
}
function getAi(cb) {
  chrome.storage.local.get(['ai', 'aiKey'], (l) => {
    const ai = Object.assign({}, l.ai || {});
    if (l.aiKey) { ai.apiKey = l.aiKey; return cb(ai); }
    chrome.storage.session.get('aiKey', (s) => { ai.apiKey = s.aiKey || ''; cb(ai); });
  });
}

// AI calls run here, so the API key never enters the web page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension's own scripts.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!msg) return false;
  if (msg.type === 'T2C_OPEN_OPTIONS') { chrome.runtime.openOptionsPage(); return false; }
  if (msg.type === 'T2C_AI_STATUS') {
    getAi((ai) => sendResponse({ ready: !!(ai.model && ai.baseUrl), model: ai.model }));
    return true;
  }
  if (msg.type === 'T2C_AI_REWRITE') {
    getAi((ai) => {
      T2CAI.rewriteQuery(ai, msg.question)
        .then((r) => sendResponse({ ok: true, result: r }))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    });
    return true;
  }
  if (msg.type === 'T2C_AI_SEARCH') {
    getAi((ai) => {
      T2CAI.search(ai, msg.question, msg.items)
        .then((r) => sendResponse({ ok: true, result: r }))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    });
    return true; // async response
  }
  return false;
});
