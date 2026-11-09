import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectExtensionBrowser } from '../src/extension-install.js';

const chromeAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/158.0.0.0 Safari/537.36';

test('the install button recognizes the desktop browser, with Edge taking precedence over Chrome', () => {
  assert.equal(detectExtensionBrowser({ userAgent: chromeAgent }), 'chrome');
  assert.equal(detectExtensionBrowser({ userAgent: chromeAgent + ' Edg/158.0.0.0' }), 'edge');
  assert.equal(detectExtensionBrowser({ userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/153.0' }), 'firefox');
  assert.equal(detectExtensionBrowser({
    userAgent: chromeAgent,
    userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] },
  }), 'edge');
});

test('unsupported browsers and mobile devices do not get a desktop install target', () => {
  assert.equal(detectExtensionBrowser({ userAgent: 'Mozilla/5.0 Version/19.0 Safari/605.1.15' }), null);
  assert.equal(detectExtensionBrowser({ userAgent: chromeAgent + ' OPR/105.0' }), null);
  assert.equal(detectExtensionBrowser({ userAgent: 'Mozilla/5.0 (Android 15) Mobile Firefox/153.0' }), null);
  assert.equal(detectExtensionBrowser({ userAgent: chromeAgent, userAgentData: { mobile: true } }), null);
});
