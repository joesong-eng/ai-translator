// ─────────────────────────────────────────────────────
//  Site-specific configurations
//  Loaded before content.js in the same isolated world scope
// ─────────────────────────────────────────────────────

var TRANSLATION_SITES = {
  'gemini.google.com': {
    name: 'Gemini',
    inputSelectors: [
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'textarea[aria-label*="Prompt"]'
    ],
    sendSelectors: [
      'button[aria-label*="Send"]',
      'button[aria-label*="送出"]',
      'button[aria-label*="send"]',
      'button[aria-label*="提交"]',
      'button.send-button',
      'button[data-tooltip*="Send"]'
    ],
    // URL patterns for fetch/XHR interception
    requestPatterns: [
      /StreamGenerate/i,
      /batchexecute/i,
      /BardFrontendService/i
    ],
    // Heuristic: look for contenteditable near a button with "send" text/label
    heuristicSendText: ['send', '送出', '發送']
  },

  'chatgpt.com': {
    name: 'ChatGPT',
    inputSelectors: [
      'div#prompt-textarea[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea#prompt-textarea',
      'textarea#chat-message-input',
      '[role="textbox"]'
    ],
    sendSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="送出"]',
      'button[aria-label*="send prompt"]'
    ],
    requestPatterns: [
      /conversation/i,
      /completions/i,
      /backend-api\/conversation/i
    ],
    heuristicSendText: ['send', '送出', '發送']
  }
};

// Get config for current hostname (supports subdomain matching)
function getSiteConfig() {
  var hostname = window.location.hostname;
  for (var key in TRANSLATION_SITES) {
    if (hostname === key || hostname.endsWith('.' + key)) {
      return TRANSLATION_SITES[key];
    }
  }
  return null;
}
