// ─────────────────────────────────────────────────────
//  background.js — Service worker (Manifest V3)
//  Receives status/error reports from content scripts,
//  updates the extension badge.
// ─────────────────────────────────────────────────────

var lastStatus = 'idle';
var lastSite = '';
var errorCount = 0;

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'status') {
    lastStatus = message.status;
    lastSite = message.site || '';
    errorCount = message.status === 'error' ? errorCount + 1 : 0;

    // Update badge
    var badgeText = '';
    var badgeColor = '#4f8cff';

    switch (message.status) {
      case 'working':  badgeColor = '#00d4aa'; break;
      case 'fallback': badgeColor = '#ffcc00'; badgeText = '!'; break;
      case 'error':    badgeColor = '#ff4757'; badgeText = 'ERR'; break;
      case 'idle':     badgeColor = '#555555'; break;
    }

    var tabId = sender.tab && sender.tab.id;
    if (tabId) {
      chrome.action.setBadgeText({ text: badgeText, tabId: tabId });
      chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId: tabId });
    }

    if (message.error) {
      console.log('[TranslationExt/Background]', message.error);
    }
  }

  if (message.type === 'get_status') {
    sendResponse({ status: lastStatus, site: lastSite, errors: errorCount });
  }

  return true;
});

console.log('[TranslationExt/Background] Service worker loaded');
