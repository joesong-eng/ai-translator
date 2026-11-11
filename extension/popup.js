// ─────────────────────────────────────────────────────
//  popup.js — Settings popup logic
// ─────────────────────────────────────────────────────

(function () {
  'use strict';

  var els = {
    activeToggle: document.getElementById('activeToggle'),
    directionSelect: document.getElementById('directionSelect'),
    speakToggle: document.getElementById('speakToggle'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    statusDetail: document.getElementById('statusDetail')
  };

  // ── Load current settings ──
  chrome.storage.sync.get(
    { txActive: false, txDirection: 'auto', txAutoSpeak: false },
    function (items) {
      els.activeToggle.classList.toggle('on', items.txActive);
      els.directionSelect.value = items.txDirection;
      els.speakToggle.classList.toggle('on', items.txAutoSpeak);
      updateStatusText(items.txActive);
    }
  );

  // ── Toggle handlers ──
  els.activeToggle.addEventListener('click', function () {
    var on = !els.activeToggle.classList.contains('on');
    els.activeToggle.classList.toggle('on', on);
    chrome.storage.sync.set({ txActive: on });
    updateStatusText(on);
  });

  els.speakToggle.addEventListener('click', function () {
    var on = !els.speakToggle.classList.contains('on');
    els.speakToggle.classList.toggle('on', on);
    chrome.storage.sync.set({ txAutoSpeak: on });
  });

  els.directionSelect.addEventListener('change', function () {
    chrome.storage.sync.set({ txDirection: els.directionSelect.value });
  });

  // ── Status display ──
  function updateStatusText(active) {
    if (!active) {
      els.statusText.textContent = '翻譯模式：關閉';
      els.statusDot.className = 'dot';
      els.statusDetail.textContent = '';
      return;
    }

    // Query background for current status
    chrome.runtime.sendMessage({ type: 'get_status' }, function (resp) {
      if (chrome.runtime.lastError || !resp) {
        els.statusText.textContent = '翻譯模式：啟動中...';
        els.statusDot.className = 'dot';
        els.statusDetail.textContent = '';
        return;
      }

      var labels = {
        idle: '待命中',
        working: '運作中 ✓',
        fallback: '使用 fallback 模式',
        error: '錯誤 — 找不到輸入框'
      };

      els.statusDot.className = 'dot ' + (resp.status || 'idle');
      els.statusText.textContent = labels[resp.status] || resp.status || '未知';

      var detail = [];
      if (resp.site) detail.push('站點: ' + resp.site);
      if (resp.errors > 0) detail.push('錯誤次數: ' + resp.errors);
      els.statusDetail.textContent = detail.join('  |  ');
    });
  }

  // Listen for storage changes while popup is open
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    if (changes.txActive) {
      els.activeToggle.classList.toggle('on', changes.txActive.newValue);
      updateStatusText(changes.txActive.newValue);
    }
    if (changes.txAutoSpeak) {
      els.speakToggle.classList.toggle('on', changes.txAutoSpeak.newValue);
    }
  });
})();
