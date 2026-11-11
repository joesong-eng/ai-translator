// ─────────────────────────────────────────────────────
//  interceptor.js — runs in the MAIN world
//  Overrides window.fetch and XMLHttpRequest to intercept
//  outgoing chat requests and inject the translation system prompt.
//
//  Communicates with content.js (isolated world) via custom DOM events:
//    content.js → interceptor:  __tx_ext_state  {active, prompt, patterns}
//    interceptor → content.js:  __tx_ext_result  {url, found, method, error}
// ─────────────────────────────────────────────────────

(function () {
  'use strict';

  var TAG = '[TranslationExt/Interceptor]';
  var active = false;
  var systemPrompt = '';
  var requestPatterns = [];
  var doubleGuard = false; // prevent Strategy A + Strategy B both injecting

  // ── Listen for state updates from content.js ──
  document.addEventListener('__tx_ext_state', function (e) {
    active = !!e.detail.active;
    systemPrompt = e.detail.prompt || '';
    requestPatterns = e.detail.patterns || [];
    console.log(TAG, 'State: active=' + active + ', patterns=' + requestPatterns.length);
  });

  // Content.js signals when DOM interception has already handled the message
  document.addEventListener('__tx_ext_dom_handled', function () {
    doubleGuard = true;
    setTimeout(function () { doubleGuard = false; }, 3000);
  });

  // ── Notify content.js of interception result ──
  function notifyResult(detail) {
    document.dispatchEvent(new CustomEvent('__tx_ext_result', { detail: detail }));
  }

  // ── Check if URL matches any request pattern ──
  function urlMatches(url) {
    if (!url) return false;
    for (var i = 0; i < requestPatterns.length; i++) {
      if (requestPatterns[i].test(url)) return true;
    }
    return false;
  }

  // ── Core: try to find and modify user message in request body ──
  function tryModifyBody(body) {
    if (!body) return null;

    var bodyStr = '';
    var returnType = 'string';

    if (typeof body === 'string') {
      bodyStr = body;
    } else if (body instanceof URLSearchParams) {
      bodyStr = body.toString();
    } else if (body instanceof FormData) {
      // FormData is tricky — try to find text fields
      var modified = false;
      var newFD = new FormData();
      for (var pair of body.entries()) {
        if (typeof pair[1] === 'string' && pair[1].length > 2 && pair[1].length < 50000) {
          if (looksLikeUserMessage(pair[0], pair[1])) {
            newFD.append(pair[0], systemPrompt + '\n\n' + pair[1]);
            modified = true;
            console.log(TAG, 'Modified FormData field:', pair[0]);
          } else {
            newFD.append(pair[0], pair[1]);
          }
        } else {
          newFD.append(pair[0], pair[1]);
        }
      }
      return modified ? newFD : null;
    } else if (body instanceof ArrayBuffer || body instanceof Blob) {
      console.log(TAG, 'Binary body, skipping');
      return null;
    } else {
      try { bodyStr = String(body); } catch (e) { return null; }
    }

    // Strategy 1: Plain JSON
    try {
      var json = JSON.parse(bodyStr);
      if (modifyJSON(json, 0)) {
        console.log(TAG, 'Modified JSON body');
        return JSON.stringify(json);
      }
    } catch (e) { /* not JSON */ }

    // Strategy 2: Google batchexecute format (f.req=...)
    if (bodyStr.indexOf('f.req=') !== -1) {
      var result = modifyBatchExecute(bodyStr);
      if (result) {
        console.log(TAG, 'Modified batchexecute body');
        return result;
      }
    }

    // Strategy 3: URL-encoded JSON
    try {
      var decoded = decodeURIComponent(bodyStr);
      var json2 = JSON.parse(decoded);
      if (modifyJSON(json2, 0)) {
        console.log(TAG, 'Modified URL-encoded JSON body');
        return encodeURIComponent(JSON.stringify(json2));
      }
    } catch (e) { /* not URL-encoded JSON */ }

    // Strategy 4: Multipart form-data (some APIs use this for chat)
    if (bodyStr.indexOf('------') !== -1 && bodyStr.indexOf('Content-Disposition') !== -1) {
      console.log(TAG, 'Multipart body detected, attempting field modification');
      // Extract parts and try to find message field
      var modifiedMulti = modifyMultipart(bodyStr);
      if (modifiedMulti) return modifiedMulti;
    }

    // Could not parse — log for debugging
    console.log(TAG, 'Could not parse body. First 500 chars:', bodyStr.substring(0, 500));
    notifyResult({ url: '', found: false, method: 'fetch', error: 'parse_failed' });
    return null;
  }

  // ── Recursively search JSON for message-like fields ──
  var MESSAGE_KEYS = [
    'message', 'text', 'prompt', 'input', 'content',
    'query', 'userMessage', 'user_input', 'userText',
    'textValue', 'messageText', 'chatMessage', 'promptText'
  ];

  function modifyJSON(obj, depth) {
    if (depth > 12 || obj === null || obj === undefined) return false;
    var modified = false;

    if (typeof obj === 'string') {
      // Could be a JSON-encoded string inside JSON
      if ((obj.charAt(0) === '[' || obj.charAt(0) === '{') && obj.length < 100000) {
        try {
          var inner = JSON.parse(obj);
          if (modifyJSON(inner, depth + 1)) {
            // Can't replace the string reference directly — caller handles
            return false; // TODO: handle nested JSON strings in array elements
          }
        } catch (e) { /* not JSON */ }
      }
      return false;
    }

    if (typeof obj !== 'object') return false;

    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        if (typeof obj[i] === 'string' && obj[i].length > 5 && obj[i].length < 50000) {
          // If this string itself is a JSON containing message fields, try to parse and modify
          if (obj[i].charAt(0) === '[' || obj[i].charAt(0) === '{') {
            try {
              var innerObj = JSON.parse(obj[i]);
              if (modifyJSON(innerObj, depth + 1)) {
                obj[i] = JSON.stringify(innerObj);
                modified = true;
                continue;
              }
            } catch (e) { /* not JSON */ }
          }
        }
        if (modifyJSON(obj[i], depth + 1)) modified = true;
      }
    } else {
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var val = obj[key];

        // Check if this key looks like a message field
        if (MESSAGE_KEYS.indexOf(key) !== -1 && typeof val === 'string' && val.length > 0 && val.length < 50000) {
          if (!alreadyHasPrompt(val)) {
            obj[key] = systemPrompt + '\n\n' + val;
            modified = true;
            console.log(TAG, 'Modified JSON field:', key);
          }
        }

        // If the value is a JSON string, try to parse and modify recursively
        if (typeof val === 'string' && (val.charAt(0) === '[' || val.charAt(0) === '{') && val.length < 100000) {
          try {
            var parsed = JSON.parse(val);
            if (modifyJSON(parsed, depth + 1)) {
              obj[key] = JSON.stringify(parsed);
              modified = true;
            }
          } catch (e) { /* not JSON */ }
        }

        if (modifyJSON(val, depth + 1)) modified = true;
      }
    }

    return modified;
  }

  // ── Modify Google batchexecute format ──
  function modifyBatchExecute(bodyStr) {
    try {
      var match = bodyStr.match(/f\.req=([^&]*)/);
      if (!match) return null;

      var decoded = decodeURIComponent(match[1]);
      var req = JSON.parse(decoded);
      var modified = false;

      function searchAndModify(arr, depth) {
        if (!Array.isArray(arr) || depth > 15) return;
        for (var i = 0; i < arr.length; i++) {
          if (typeof arr[i] === 'string' && (arr[i].charAt(0) === '[' || arr[i].charAt(0) === '{')) {
            try {
              var inner = JSON.parse(arr[i]);
              if (modifyJSON(inner, 0)) {
                arr[i] = JSON.stringify(inner);
                modified = true;
                console.log(TAG, 'Modified inner JSON in batchexecute');
              }
            } catch (e) { /* not JSON */ }
          }
          if (Array.isArray(arr[i])) {
            searchAndModify(arr[i], depth + 1);
          }
        }
      }

      searchAndModify(req, 0);

      if (modified) {
        var newReq = JSON.stringify(req);
        return bodyStr.replace(/f\.req=[^&]*/, 'f.req=' + encodeURIComponent(newReq));
      }
    } catch (e) {
      console.warn(TAG, 'batchexecute parse error:', e.message);
    }
    return null;
  }

  // ── Modify multipart form-data ──
  function modifyMultipart(bodyStr) {
    // Very rough attempt — look for message-like fields in form data
    var boundary = bodyStr.match(/------[^\r\n]*/);
    if (!boundary) return null;
    var b = boundary[0];
    var parts = bodyStr.split(b);
    var modified = false;

    for (var i = 0; i < parts.length; i++) {
      // Find name="..." in the header
      var nameMatch = parts[i].match(/name="([^"]*)"/);
      if (!nameMatch) continue;
      var fieldName = nameMatch[1];

      if (MESSAGE_KEYS.indexOf(fieldName) !== -1) {
        // Get the value (after the blank line)
        var valueStart = parts[i].indexOf('\r\n\r\n');
        if (valueStart === -1) valueStart = parts[i].indexOf('\n\n');
        if (valueStart !== -1) {
          var value = parts[i].substring(valueStart).trim();
          if (value && !alreadyHasPrompt(value)) {
            parts[i] = parts[i].substring(0, valueStart) + '\r\n\r\n' + systemPrompt + '\n\n' + value;
            modified = true;
            console.log(TAG, 'Modified multipart field:', fieldName);
          }
        }
      }
    }

    return modified ? parts.join(b) : null;
  }

  // ── Check if the text already has our prompt (avoid double-injection) ──
  function alreadyHasPrompt(text) {
    if (!text || text.length < 10) return false;
    return text.indexOf('翻譯引擎') !== -1 || text.indexOf('translation engine') !== -1;
  }

  // ── Check if a field name/value pair looks like a user message ──
  function looksLikeUserMessage(fieldName, value) {
    if (MESSAGE_KEYS.indexOf(fieldName) !== -1) return true;
    return false;
  }

  // ═════════════════════════════════════════════════════
  //  Override window.fetch
  // ═════════════════════════════════════════════════════
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    if (!active || !systemPrompt || doubleGuard) {
      return originalFetch.apply(this, arguments);
    }

    var url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url;

    if (!urlMatches(url)) {
      return originalFetch.apply(this, arguments);
    }

    // Clone init to avoid mutating the original
    init = init ? Object.assign({}, init) : {};
    if (init.body) {
      try {
        var modified = tryModifyBody(init.body);
        if (modified !== null) {
          init.body = modified;
          doubleGuard = true;
          setTimeout(function () { doubleGuard = false; }, 3000);
          notifyResult({ url: url, found: true, method: 'fetch' });
          console.log(TAG, '✓ Modified fetch to', url);
        }
      } catch (err) {
        console.warn(TAG, 'fetch interception error:', err.message);
        notifyResult({ url: url, found: false, method: 'fetch', error: err.message });
      }
    }

    return originalFetch.apply(this, [input, init]);
  };

  // ═════════════════════════════════════════════════════
  //  Override XMLHttpRequest
  // ═════════════════════════════════════════════════════
  var originalXHROpen = XMLHttpRequest.prototype.open;
  var originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__txUrl = url;
    this.__txMethod = method;
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (!active || !systemPrompt || doubleGuard) {
      return originalXHRSend.apply(this, arguments);
    }

    if (urlMatches(this.__txUrl) && body) {
      try {
        var modified = tryModifyBody(body);
        if (modified !== null) {
          body = modified;
          doubleGuard = true;
          setTimeout(function () { doubleGuard = false; }, 3000);
          notifyResult({ url: this.__txUrl, found: true, method: 'xhr' });
          console.log(TAG, '✓ Modified XHR to', this.__txUrl);
        }
      } catch (err) {
        console.warn(TAG, 'XHR interception error:', err.message);
        notifyResult({ url: this.__txUrl, found: false, method: 'xhr', error: err.message });
      }
    }

    return originalXHRSend.apply(this, [body]);
  };

  console.log(TAG, 'Interceptor loaded (MAIN world)');
})();
