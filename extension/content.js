// ─────────────────────────────────────────────────────
//  content.js — runs in the ISOLATED world
//  Main orchestrator: UI toggle, DOM interception, element finder,
//  error monitoring, self-adaptation, TTS.
//
//  Communicates with interceptor.js (MAIN world) via custom DOM events:
//    content.js → interceptor:  __tx_ext_state       {active, prompt, patterns}
//    content.js → interceptor:  __tx_ext_dom_handled  (signal that DOM already injected)
//    interceptor → content.js:  __tx_ext_result       {url, found, method, error}
// ─────────────────────────────────────────────────────

(function () {
  'use strict';

  var TAG = '[TranslationExt/Content]';
  var siteConfig = getSiteConfig();
  if (!siteConfig) {
    console.log(TAG, 'No site config for', window.location.hostname);
    return;
  }

  // ─────────────────────────────────────────────────────
  //  Translation System Prompt (the constraint injected every time)
  // ─────────────────────────────────────────────────────
  var SYSTEM_PROMPT_ZH = [
    '你是一個專業翻譯引擎。嚴格遵守以下規則：',
    '1. 只輸出翻譯結果文字，不加任何解釋、說明、問候或評論',
    '2. 中文輸入 → 翻譯成英文',
    '3. 英文輸入 → 翻譯成中文',
    '4. 混合語言輸入 → 根據主要語言判斷翻譯方向',
    '5. 嚴禁回答問題、嚴禁聊天對話、嚴禁加任何前綴或後綴',
    '6. 保持原文語氣和語意，翻譯要自然流暢',
    '7. 輸出只能是翻譯結果，沒有其他任何內容',
    ''
  ].join('\n');

  // ─────────────────────────────────────────────────────
  //  State
  // ─────────────────────────────────────────────────────
  var state = {
    active: false,           // translation mode on/off
    direction: 'auto',       // 'auto' | 'zh-en' | 'en-zh'
    autoSpeak: false,        // TTS for AI responses
    lastStatus: 'idle',      // 'idle' | 'working' | 'fallback' | 'error'
    cacheHit: 0,
    cacheMiss: 0,
    interceptCount: 0,
    lastError: null,
    cachedInputSelector: null,
    cachedSendSelector: null
  };

  var inputElement = null;
  var sendElement = null;
  var uiButton = null;
  var monitorInterval = null;
  var ttsObserver = null;
  var ttsLastText = '';
  var ttsTimer = null;

  // ─────────────────────────────────────────────────────
  //  Load settings from chrome.storage
  // ─────────────────────────────────────────────────────
  // Known-bad selectors that must never be used
  var INVALID_SELECTORS = [
    'button mat-icon:has-text("send")'
  ];

  function isValidSelector(sel) {
    if (!sel) return false;
    if (INVALID_SELECTORS.indexOf(sel) !== -1) return false;
    try { document.querySelector(sel); return true; } catch (e) { return false; }
  }

  function loadSettings(callback) {
    chrome.storage.sync.get(
      { txActive: false, txDirection: 'auto', txAutoSpeak: false,
        txInputSelector: null, txSendSelector: null },
      function (items) {
        state.active = items.txActive;
        state.direction = items.txDirection;
        state.autoSpeak = items.txAutoSpeak;
        // Validate cached selectors — discard if invalid
        state.cachedInputSelector = isValidSelector(items.txInputSelector) ? items.txInputSelector : null;
        state.cachedSendSelector  = isValidSelector(items.txSendSelector)  ? items.txSendSelector  : null;
        if (!state.cachedInputSelector || !state.cachedSendSelector) {
          // Clear any stale cached values from storage
          chrome.storage.sync.remove(['txInputSelector', 'txSendSelector']);
          console.log(TAG, 'Cleared stale selector cache');
        }
        if (callback) callback();
      }
    );
  }

  function saveSettings() {
    chrome.storage.sync.set({
      txActive: state.active,
      txDirection: state.direction,
      txAutoSpeak: state.autoSpeak,
      txInputSelector: state.cachedInputSelector,
      txSendSelector: state.cachedSendSelector
    });
  }

  // ─────────────────────────────────────────────────────
  //  Push state to interceptor.js (MAIN world)
  // ─────────────────────────────────────────────────────
  function pushStateToInterceptor() {
    document.dispatchEvent(new CustomEvent('__tx_ext_state', {
      detail: {
        active: state.active,
        prompt: getPromptForDirection(),
        patterns: siteConfig.requestPatterns
      }
    }));
  }

  // Get the system prompt, possibly adjusted by direction setting
  function getPromptForDirection() {
    if (state.direction === 'zh-en') {
      return SYSTEM_PROMPT_ZH + '\n翻譯方向：中文 → 英文';
    } else if (state.direction === 'en-zh') {
      return SYSTEM_PROMPT_ZH + '\n翻譯方向：英文 → 中文';
    }
    return SYSTEM_PROMPT_ZH;
  }

  // ─────────────────────────────────────────────────────
  //  Element Finder — multi-layer fallback
  // ─────────────────────────────────────────────────────

  function findInputElement() {
    // Layer 1: cached selector
    if (state.cachedInputSelector) {
      try {
        var el = document.querySelector(state.cachedInputSelector);
        if (el && isInputVisible(el)) {
          state.cacheHit++;
          return el;
        }
      } catch (e) {
        state.cachedInputSelector = null;
      }
      state.cacheMiss++;
    }

    // Layer 2: site-specific selectors
    for (var i = 0; i < siteConfig.inputSelectors.length; i++) {
      try {
        var el2 = document.querySelector(siteConfig.inputSelectors[i]);
        if (el2 && isInputVisible(el2)) {
          state.cachedInputSelector = siteConfig.inputSelectors[i];
          saveSettings();
          console.log(TAG, 'Found input via site selector:', siteConfig.inputSelectors[i]);
          updateStatus('fallback');
          return el2;
        }
      } catch (e) {
        console.warn(TAG, 'Invalid input selector:', siteConfig.inputSelectors[i]);
      }
    }

    // Layer 3: heuristics
    var heuristicEl = findInputHeuristic();
    if (heuristicEl) {
      // Try to generate a selector for caching
      var selector = generateSelector(heuristicEl);
      if (selector) {
        state.cachedInputSelector = selector;
        saveSettings();
        console.log(TAG, 'Found input via heuristic, cached as:', selector);
      }
      updateStatus('fallback');
      return heuristicEl;
    }

    return null;
  }

  function findSendButton(inputEl) {
    // Layer 1: cached
    if (state.cachedSendSelector) {
      try {
        var el = document.querySelector(state.cachedSendSelector);
        if (el) return el;
      } catch (e) {
        state.cachedSendSelector = null;
      }
    }

    // Layer 2: site selectors
    for (var i = 0; i < siteConfig.sendSelectors.length; i++) {
      try {
        var el2 = document.querySelector(siteConfig.sendSelectors[i]);
        if (el2) {
          state.cachedSendSelector = siteConfig.sendSelectors[i];
          saveSettings();
          return el2;
        }
      } catch (e) {
        console.warn(TAG, 'Invalid send selector:', siteConfig.sendSelectors[i]);
      }
    }

    // Layer 3: heuristic — find a button near the input with send-like label
    if (inputEl) {
      var btn = findSendButtonHeuristic(inputEl);
      if (btn) {
        var selector = generateSelector(btn);
        if (selector) {
          state.cachedSendSelector = selector;
          saveSettings();
        }
        return btn;
      }
    }

    return null;
  }

  // Heuristic: find input element
  function findInputHeuristic() {
    // All contenteditable elements
    var editables = document.querySelectorAll('[contenteditable="true"]');
    if (editables.length === 1) return editables[0];

    // If multiple, prefer ones with certain attributes
    for (var i = 0; i < editables.length; i++) {
      var el = editables[i];
      if (el.getAttribute('role') === 'textbox') return el;
      if (el.getAttribute('aria-label') && el.getAttribute('aria-label').toLowerCase().indexOf('prompt') !== -1) return el;
      if (el.getAttribute('aria-multiline') === 'true') return el;
    }

    // Try textareas
    var textareas = document.querySelectorAll('textarea');
    for (var j = 0; j < textareas.length; j++) {
      var ta = textareas[j];
      if (ta.placeholder && (ta.placeholder.toLowerCase().indexOf('message') !== -1 ||
          ta.placeholder.toLowerCase().indexOf('prompt') !== -1 ||
          ta.placeholder.indexOf('訊息') !== -1 || ta.placeholder.indexOf('輸入') !== -1)) {
        return ta;
      }
    }

    // Last resort: the largest visible contenteditable
    if (editables.length > 0) {
      var best = editables[0];
      var bestArea = 0;
      for (var k = 0; k < editables.length; k++) {
        var rect = editables[k].getBoundingClientRect();
        var area = rect.width * rect.height;
        if (area > bestArea && area > 100) {
          bestArea = area;
          best = editables[k];
        }
      }
      return best;
    }

    return null;
  }

  // Heuristic: find send button near input
  function findSendButtonHeuristic(inputEl) {
    var container = inputEl.closest('form') || inputEl.parentElement;
    if (!container) container = document.body;

    // Look for buttons within the same container
    var buttons = container.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
      var sendTexts = siteConfig.heuristicSendText || ['send', '送出', '發送'];
      for (var j = 0; j < sendTexts.length; j++) {
        if (label.indexOf(sendTexts[j]) !== -1) return btn;
      }
    }

    // Look in parent containers (up to 3 levels)
    var parent = inputEl.parentElement;
    for (var level = 0; level < 3 && parent; level++) {
      var btns = parent.querySelectorAll('button[aria-label], button[data-testid]');
      for (var m = 0; m < btns.length; m++) {
        var lbl = (btns[m].getAttribute('aria-label') || '').toLowerCase();
        if (lbl.indexOf('send') !== -1 || lbl.indexOf('送') !== -1) return btns[m];
      }
      parent = parent.parentElement;
    }

    return null;
  }

  function isInputVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Generate a CSS selector for an element (for caching)
  function generateSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';

    // Try: tag + contenteditable
    var tag = el.tagName.toLowerCase();
    if (el.getAttribute('contenteditable') === 'true') {
      var selector = tag + '[contenteditable="true"]';
      // Add class if present
      if (el.className && typeof el.className === 'string' && el.className.trim()) {
        var firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass) selector += '.' + CSS.escape(firstClass);
      }
      // Add aria-label if present
      var aria = el.getAttribute('aria-label');
      if (aria) selector += '[aria-label="' + aria + '"]';
      return selector;
    }
    if (el.tagName === 'TEXTAREA') {
      return 'textarea' + (el.id ? '#' + CSS.escape(el.id) : '');
    }
    return null;
  }

  // ─────────────────────────────────────────────────────
  //  DOM-level Interception (Strategy B)
  // ─────────────────────────────────────────────────────

  function setupDOMInterception() {
    if (!inputElement) return;

    // Intercept Enter key in capture phase (before page handler)
    inputElement.addEventListener('keydown', onKeyDownCapture, true);

    // Also try to intercept send button clicks
    if (sendElement) {
      sendElement.addEventListener('click', onSendClickCapture, true);
    }

    console.log(TAG, 'DOM interception set up');
  }

  function teardownDOMInterception() {
    if (inputElement) {
      inputElement.removeEventListener('keydown', onKeyDownCapture, true);
    }
    if (sendElement) {
      sendElement.removeEventListener('click', onSendClickCapture, true);
    }
  }

  function onKeyDownCapture(e) {
    if (!state.active) return;
    // Only intercept plain Enter (not Shift+Enter, Ctrl+Enter, etc.)
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;

    injectTranslationPrompt();
  }

  function onSendClickCapture(e) {
    if (!state.active) return;
    injectTranslationPrompt();
  }

  function injectTranslationPrompt() {
    if (!inputElement) return;

    var currentText = getInputText(inputElement);
    if (!currentText || currentText.trim().length === 0) return;

    // Avoid double-injection
    if (currentText.indexOf('翻譯引擎') !== -1 || currentText.indexOf('translation engine') !== -1) return;

    var prompt = getPromptForDirection();
    var newText = prompt + currentText;

    // Set the modified text back into the input
    var success = setInputText(inputElement, newText);

    if (success) {
      // Notify interceptor that DOM already handled it (prevent double-inject)
      document.dispatchEvent(new CustomEvent('__tx_ext_dom_handled'));
      state.interceptCount++;
      updateStatus('working');
      updateUI();
      console.log(TAG, 'Injected translation prompt via DOM');

      // Set up TTS watching if auto-speak is on
      if (state.autoSpeak) {
        startTTSWatcher();
      }
    } else {
      console.warn(TAG, 'Failed to set modified text via DOM');
      updateStatus('error');
    }
  }

  // Read text from input element (handles both contenteditable and textarea)
  function getInputText(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return el.value;
    }
    return el.textContent || el.innerText || '';
  }

  // Set text in input element (handles both contenteditable and textarea)
  function setInputText(el, text) {
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        // For textarea/input, use native setter to trigger React onChange
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) {
          setter.set.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      // For contenteditable divs
      el.focus();

      // Method 1: execCommand (deprecated but works in Chrome, triggers React onChange)
      // Select all content
      var range = document.createRange();
      range.selectNodeContents(el);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      // Use execCommand to insert text (triggers input event)
      var inserted = document.execCommand('insertText', false, text);
      if (inserted) return true;

      // Method 2: fallback — set textContent and dispatch input event
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: text,
        inputType: 'insertText'
      }));
      return true;
    } catch (err) {
      console.warn(TAG, 'setInputText error:', err.message);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────
  //  TTS — watch for AI response and speak it
  // ─────────────────────────────────────────────────────

  function startTTSWatcher() {
    stopTTSWatcher();
    ttsLastText = '';

    // Watch the document for new text additions
    ttsObserver = new MutationObserver(function (mutations) {
      // Collect all new text
      var newText = '';
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes) {
          for (var j = 0; j < mutations[i].addedNodes.length; j++) {
            var node = mutations[i].addedNodes[j];
            if (node.nodeType === Node.TEXT_NODE) {
              newText += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              newText += node.textContent || '';
            }
          }
        }
      }

      if (newText.trim()) {
        ttsLastText += newText;
        // Debounce — speak when text stops changing for 1.5s
        if (ttsTimer) clearTimeout(ttsTimer);
        ttsTimer = setTimeout(function () {
          if (ttsLastText.trim().length > 5) {
            speakText(ttsLastText.trim());
            ttsLastText = '';
          }
        }, 1500);
      }
    });

    // Observe the main content area
    ttsObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Safety: stop after 30 seconds
    setTimeout(stopTTSWatcher, 30000);
  }

  function stopTTSWatcher() {
    if (ttsObserver) {
      ttsObserver.disconnect();
      ttsObserver = null;
    }
    if (ttsTimer) {
      clearTimeout(ttsTimer);
      ttsTimer = null;
    }
    ttsLastText = '';
  }

  function speakText(text) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    var utter = new SpeechSynthesisUtterance(text);
    // Detect language from text
    var isChinese = /[\u4e00-\u9fff]/.test(text);
    utter.lang = isChinese ? 'zh-TW' : 'en-US';
    utter.rate = 1.0;
    speechSynthesis.speak(utter);
    console.log(TAG, 'TTS:', text.substring(0, 50) + '...');
  }

  // ─────────────────────────────────────────────────────
  //  Floating UI Toggle
  // ─────────────────────────────────────────────────────

  function createUI() {
    if (uiButton) return;

    uiButton = document.createElement('div');
    uiButton.id = '__tx_ext_toggle';
    uiButton.style.cssText = [
      'position:fixed',
      'top:80px',
      'right:16px',
      'z-index:2147483647',
      'width:48px',
      'height:48px',
      'border-radius:50%',
      'background:#1a1a2e',
      'border:2px solid #2a2a4a',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'cursor:pointer',
      'font-size:22px',
      'user-select:none',
      'box-shadow:0 2px 12px rgba(0,0,0,0.3)',
      'transition:background 0.2s, border-color 0.2s',
      'font-family:sans-serif'
    ].join(';');

    // Status dot
    var dot = document.createElement('div');
    dot.id = '__tx_ext_dot';
    dot.style.cssText = [
      'position:absolute',
      'bottom:-2px',
      'right:-2px',
      'width:12px',
      'height:12px',
      'border-radius:50%',
      'border:2px solid #1a1a2e'
    ].join(';');
    uiButton.appendChild(dot);

    // Icon
    var icon = document.createElement('span');
    icon.textContent = '🌐';
    icon.style.pointerEvents = 'none';
    uiButton.appendChild(icon);

    updateUI();

    // Click to toggle
    uiButton.addEventListener('click', function (e) {
      e.stopPropagation();
      state.active = !state.active;
      saveSettings();
      pushStateToInterceptor();
      updateUI();
      if (state.active) {
        reFindElements();
      }
      console.log(TAG, 'Translation mode:', state.active ? 'ON' : 'OFF');
    });

    // Make draggable
    makeDraggable(uiButton);

    // Delay adding to DOM until body exists
    if (document.body) {
      document.body.appendChild(uiButton);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(uiButton);
      });
    }
  }

  function updateUI() {
    if (!uiButton) return;
    var dot = document.getElementById('__tx_ext_dot');
    var icon = uiButton.querySelector('span');

    if (state.active) {
      uiButton.style.background = '#4f8cff';
      uiButton.style.borderColor = '#4f8cff';
      uiButton.style.boxShadow = '0 0 16px rgba(79,140,255,0.4)';
      if (icon) icon.textContent = '🌐';

      if (dot) {
        switch (state.lastStatus) {
          case 'working':  dot.style.background = '#00d4aa'; break;
          case 'fallback': dot.style.background = '#ffcc00'; break;
          case 'error':   dot.style.background = '#ff4757'; break;
          default:        dot.style.background = '#00d4aa';
        }
      }
    } else {
      uiButton.style.background = '#1a1a2e';
      uiButton.style.borderColor = '#2a2a4a';
      uiButton.style.boxShadow = '0 2px 12px rgba(0,0,0,0.3)';
      if (icon) icon.textContent = '🌐';
      if (dot) dot.style.background = '#555';
    }
  }

  function updateStatus(status) {
    state.lastStatus = status;
    updateUI();
    // Notify background.js
    chrome.runtime.sendMessage({
      type: 'status',
      status: status,
      site: siteConfig.name,
      interceptCount: state.interceptCount,
      cacheHit: state.cacheHit,
      cacheMiss: state.cacheMiss,
      error: state.lastError
    }).catch(function () { /* background might not be ready */ });
  }

  function makeDraggable(el) {
    var isDragging = false;
    var startX = 0, startY = 0;
    var startLeft = 0, startTop = 0;
    var hasMoved = false;

    el.addEventListener('mousedown', function (e) {
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(el.style.right) || 16;
      startTop = parseInt(el.style.top) || 80;
      el.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;

      // Use left/top positioning when dragging
      var newLeft = (window.innerWidth - startLeft - 48) + dx;
      var newTop = startTop + dy;
      newLeft = Math.max(0, Math.min(window.innerWidth - 48, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - 48, newTop));
      el.style.left = newLeft + 'px';
      el.style.right = 'auto';
      el.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', function () {
      if (isDragging) {
        isDragging = false;
        el.style.transition = '';
      }
    });

    // Touch support
    el.addEventListener('touchstart', function (e) {
      isDragging = true;
      hasMoved = false;
      var t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startLeft = parseInt(el.style.right) || 16;
      startTop = parseInt(el.style.top) || 80;
      el.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!isDragging) return;
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      var newLeft = (window.innerWidth - startLeft - 48) + dx;
      var newTop = startTop + dy;
      newLeft = Math.max(0, Math.min(window.innerWidth - 48, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - 48, newTop));
      el.style.left = newLeft + 'px';
      el.style.right = 'auto';
      el.style.top = newTop + 'px';
    }, { passive: true });

    document.addEventListener('touchend', function () {
      if (isDragging) {
        isDragging = false;
        el.style.transition = '';
      }
    });
  }

  // ─────────────────────────────────────────────────────
  //  Error Monitoring & Self-adaptation
  // ─────────────────────────────────────────────────────

  function startMonitor() {
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(function () {
      // Check if input element is still in the DOM and visible
      if (inputElement && !document.contains(inputElement)) {
        console.log(TAG, 'Input element lost, re-finding...');
        inputElement = null;
        sendElement = null;
        reFindElements();
      }

      // Check if input is still visible
      if (inputElement && !isInputVisible(inputElement)) {
        // Might be in a different view/tab — try to find a new one
        reFindElements();
      }
    }, 5000);
  }

  function reFindElements() {
    teardownDOMInterception();

    var newInput = findInputElement();
    if (newInput) {
      inputElement = newInput;
      sendElement = findSendButton(inputElement);
      setupDOMInterception();
      updateStatus(state.active ? 'working' : 'idle');
      console.log(TAG, 'Elements found:', !!inputElement, !!sendElement);
    } else {
      updateStatus('error');
      state.lastError = 'Input element not found';
      console.warn(TAG, 'Could not find input element');
    }
  }

  // ─────────────────────────────────────────────────────
  //  Listen for interceptor results
  // ─────────────────────────────────────────────────────
  document.addEventListener('__tx_ext_result', function (e) {
    var detail = e.detail;
    if (detail.found) {
      state.interceptCount++;
      updateStatus('working');
      console.log(TAG, 'Interceptor success:', detail.method, detail.url);
    } else {
      console.log(TAG, 'Interceptor could not parse:', detail.url || 'unknown');
    }
  });

  // ─────────────────────────────────────────────────────
  //  Listen for settings changes from popup
  // ─────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    var needUpdate = false;

    if (changes.txActive) {
      state.active = changes.txActive.newValue;
      needUpdate = true;
    }
    if (changes.txDirection) {
      state.direction = changes.txDirection.newValue;
      needUpdate = true;
    }
    if (changes.txAutoSpeak) {
      state.autoSpeak = changes.txAutoSpeak.newValue;
    }

    if (needUpdate) {
      pushStateToInterceptor();
      updateUI();
      if (state.active) reFindElements();
    }
  });

  // ─────────────────────────────────────────────────────
  //  Keyboard shortcut: Ctrl+Shift+T
  // ─────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
      e.preventDefault();
      state.active = !state.active;
      saveSettings();
      pushStateToInterceptor();
      updateUI();
      if (state.active) reFindElements();
      console.log(TAG, 'Shortcut toggled:', state.active ? 'ON' : 'OFF');
    }
  });

  // ─────────────────────────────────────────────────────
  //  SPA navigation detection
  // ─────────────────────────────────────────────────────
  var lastURL = window.location.href;
  setInterval(function () {
    if (window.location.href !== lastURL) {
      lastURL = window.location.href;
      console.log(TAG, 'URL changed, re-finding elements');
      setTimeout(reFindElements, 1000); // wait for new content to load
    }
  }, 1000);

  // ─────────────────────────────────────────────────────
  //  Init
  // ─────────────────────────────────────────────────────
  function init() {
    loadSettings(function () {
      // Create UI (wait for body)
      var initUI = function () {
        createUI();
        pushStateToInterceptor();
        updateUI();

        // Find elements after a short delay (let the page load)
        setTimeout(function () {
          reFindElements();
          startMonitor();
        }, 2000);

        console.log(TAG, 'Initialized for', siteConfig.name);
      };

      if (document.body) {
        initUI();
      } else {
        document.addEventListener('DOMContentLoaded', initUI);
      }
    });
  }

  init();
})();
