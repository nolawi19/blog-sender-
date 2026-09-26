/**
 * Automation Engine tools for Google Apps Script.
 *
 * SAFE TO ADD to your existing Apps Script project as a new file: every name here
 * starts with "ae", so nothing replaces your existing functions
 * (sendExistingPosts, your polling function, ...).
 *
 *   aeDiagnose()        Read-only report in the execution log: triggers (and duplicates),
 *                       Script Property NAMES (never values), engine /health through the
 *                       tunnel, and which of the latest posts would be sent as photo or text.
 *   aeEnsureTrigger()   Makes sure exactly ONE 5-minute trigger runs AE_POLL_HANDLER.
 *                       Creates it only if missing; removes duplicates. Never adds a second.
 *   aeExtractImage(x)   First usable image URL for a Blogger feed entry, a Blogger API v3
 *                       post, or an HTML string; '' when the post has no usable image.
 *                       Use it in your payload: image: aeExtractImage(entry)
 */

/** Your blog. */
var AE_BLOG_URL = 'https://yakobsendeku.blogspot.com';
/** Name of YOUR existing polling function (the one the 5-minute trigger should call). */
var AE_POLL_HANDLER = 'checkNewPosts';
var AE_POLL_MINUTES = 5;
/** The global object, to check whether functions exist in this project. */
var aeGlobal_ = (function () {
  return this;
})();

/**
 * Returns the first usable image URL ('' if none):
 *  1. first <img src> in the post HTML (skips data: URIs, 1x1 tracking pixels and emoji)
 *  2. the feed thumbnail (media$thumbnail), upgraded from 72px to full size
 *  3. Blogger API v3 images[0].url
 * Protocol-relative URLs become https. Blogger size segments (s72-c, w640-h360) become s1600.
 */
function aeExtractImage(postOrHtml) {
  var html = '';
  var candidates = [];
  if (typeof postOrHtml === 'string') {
    html = postOrHtml;
  } else if (postOrHtml) {
    var p = postOrHtml;
    if (p.content && typeof p.content.$t === 'string') html = p.content.$t;
    else if (p.summary && typeof p.summary.$t === 'string') html = p.summary.$t;
    else if (typeof p.content === 'string') html = p.content;
    if (p.media$thumbnail && p.media$thumbnail.url) candidates.push(p.media$thumbnail.url);
    if (p.images && p.images.length && p.images[0].url) candidates.push(p.images[0].url);
  }
  var imgTag = /<img\b[^>]*>/gi;
  var tag;
  var fromHtml = [];
  while ((tag = imgTag.exec(html)) !== null) {
    var src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    if (!src) continue;
    var width = /\bwidth\s*=\s*["']?(\d+)/i.exec(tag[0]);
    var height = /\bheight\s*=\s*["']?(\d+)/i.exec(tag[0]);
    if ((width && Number(width[1]) <= 2) || (height && Number(height[1]) <= 2)) continue;
    fromHtml.push(src[2] || src[3] || src[4] || '');
  }
  var all = fromHtml.concat(candidates);
  for (var i = 0; i < all.length; i++) {
    var url = aeNormalizeImageUrl_(all[i]);
    if (url) return url;
  }
  return '';
}

function aeNormalizeImageUrl_(raw) {
  if (typeof raw !== 'string') return '';
  var url = raw.trim().replace(/&amp;/g, '&');
  if (url.indexOf('//') === 0) url = 'https:' + url;
  if (!/^https?:\/\/[^\s/?#]+\.[^\s/?#]+[^\s]*$/i.test(url)) return '';
  if (/\/emoji\/|\.svg(\?|$)/i.test(url)) return '';
  // Blogger/Google image sizes: /s72-c/ /w640-h360-c/ path segments, or =s72-c suffixes.
  if (/(blogger\.googleusercontent\.com|bp\.blogspot\.com|googleusercontent\.com)/i.test(url)) {
    url = url.replace(/\/(s\d+|w\d+-h\d+)(-[a-z0-9-]+)?\//i, '/s1600/').replace(/=(s\d+|w\d+-h\d+)(-[a-z0-9-]+)?$/i, '=s1600');
  }
  return url;
}

/** Makes sure exactly one time-based trigger calls AE_POLL_HANDLER every AE_POLL_MINUTES. */
function aeEnsureTrigger() {
  var matching = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === AE_POLL_HANDLER && String(t.getEventType()) === 'CLOCK';
  });
  if (matching.length === 1) {
    Logger.log('OK: one time-based trigger already runs ' + AE_POLL_HANDLER + '(); nothing changed.');
    return 'kept';
  }
  if (matching.length > 1) {
    for (var i = 1; i < matching.length; i++) ScriptApp.deleteTrigger(matching[i]);
    Logger.log('FIXED: removed ' + (matching.length - 1) + ' duplicate trigger(s) for ' + AE_POLL_HANDLER + '().');
    return 'deduplicated';
  }
  ScriptApp.newTrigger(AE_POLL_HANDLER).timeBased().everyMinutes(AE_POLL_MINUTES).create();
  Logger.log('CREATED: ' + AE_POLL_HANDLER + '() will run every ' + AE_POLL_MINUTES + ' minutes.');
  return 'created';
}

/** Read-only health report. Never logs Script Property values. */
function aeDiagnose() {
  var problems = 0;
  function line(status, text) {
    if (status === 'FAIL') problems++;
    Logger.log(status + '  ' + text);
  }

  // 1. Triggers
  var triggers = ScriptApp.getProjectTriggers();
  var perHandler = {};
  triggers.forEach(function (t) {
    var key = t.getHandlerFunction() + ' (' + t.getEventType() + ')';
    perHandler[key] = (perHandler[key] || 0) + 1;
  });
  if (triggers.length === 0) line('FAIL', 'No triggers: new posts are not checked automatically. Run aeEnsureTrigger().');
  Object.keys(perHandler).forEach(function (key) {
    line(perHandler[key] > 1 ? 'FAIL' : 'OK  ', 'Trigger ' + key + ' x' + perHandler[key] + (perHandler[key] > 1 ? '  <- duplicates, run aeEnsureTrigger()' : ''));
  });
  var pollExists = triggers.some(function (t) {
    return t.getHandlerFunction() === AE_POLL_HANDLER;
  });
  if (triggers.length > 0 && !pollExists) {
    line('WARN', 'No trigger calls ' + AE_POLL_HANDLER + '(). If your polling function has another name, set AE_POLL_HANDLER.');
  }
  if (typeof aeGlobal_[AE_POLL_HANDLER] !== 'function') line('WARN', 'Function ' + AE_POLL_HANDLER + '() not found in this project.');
  line(typeof aeGlobal_.sendExistingPosts === 'function' ? 'OK  ' : 'WARN', 'sendExistingPosts() ' + (typeof aeGlobal_.sendExistingPosts === 'function' ? 'exists' : 'not found'));

  // 2. Script Properties: names only
  var props = PropertiesService.getScriptProperties().getProperties();
  var names = Object.keys(props);
  line('INFO', 'Script Property names: ' + (names.length ? names.join(', ') : '(none)'));
  var webhookUrl = '';
  names.forEach(function (n) {
    if (/\/webhooks\/blog\/?$/.test(String(props[n]))) webhookUrl = String(props[n]);
  });
  var hasToken = names.some(function (n) {
    return /TOKEN|SECRET|KEY/i.test(n);
  });
  line(webhookUrl ? 'OK  ' : 'WARN', 'Webhook URL property ' + (webhookUrl ? 'SET' : 'not found in Script Properties (it may be hard-coded in the script)'));
  line(hasToken ? 'OK  ' : 'WARN', 'Token-like property ' + (hasToken ? 'SET' : 'not found in Script Properties'));

  // 3. Engine reachability through the tunnel (GET /health, no token needed)
  if (webhookUrl) {
    var healthUrl = webhookUrl.replace(/\/webhooks\/blog\/?$/, '/health');
    try {
      var res = UrlFetchApp.fetch(healthUrl, { muteHttpExceptions: true, followRedirects: false });
      var code = res.getResponseCode();
      line(code === 200 ? 'OK  ' : 'FAIL', 'Engine /health through the tunnel: HTTP ' + code + (code === 200 ? '' : '  <- is cloudflared running, and is the tunnel URL current?'));
    } catch (e) {
      line('FAIL', 'Engine /health unreachable: ' + e + '  <- start cloudflared and update the webhook URL if it changed');
    }
  }

  // 4. Latest posts: what would be sent
  try {
    var feed = JSON.parse(
      UrlFetchApp.fetch(AE_BLOG_URL + '/feeds/posts/default?alt=json&orderby=published&max-results=5', { muteHttpExceptions: true }).getContentText(),
    );
    var entries = (feed.feed && feed.feed.entry) || [];
    line('INFO', 'Latest ' + entries.length + ' post(s) on ' + AE_BLOG_URL + ':');
    entries.forEach(function (e) {
      var image = aeExtractImage(e);
      line('    ', (image ? 'photo  ' : 'text   ') + (e.title && e.title.$t) + (image ? '  [' + image.slice(0, 80) + ']' : '  [no usable image]'));
    });
  } catch (e2) {
    line('FAIL', 'Could not read the Blogger feed: ' + e2);
  }

  Logger.log(problems ? problems + ' problem(s) found.' : 'No problems found.');
  return problems;
}
