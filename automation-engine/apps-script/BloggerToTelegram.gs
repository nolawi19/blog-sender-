/**
 * OPTIONAL reference Apps Script: Blogger -> Automation Engine (-> Telegram channel).
 *
 * Use this ONLY if your current script fails aeDiagnose() and you want a
 * known-good replacement. Do not keep it next to another script that defines
 * sendExistingPosts() or checkNewPosts(): Apps Script shares one global scope.
 * Requires AutomationEngineTools.gs in the same project (for aeExtractImage and
 * aeEnsureTrigger).
 *
 * Script Properties (Project Settings -> Script Properties), never in code:
 *   WEBHOOK_URL    e.g. https://<your-tunnel>.trycloudflare.com/webhooks/blog
 *   WEBHOOK_TOKEN  the bearer token printed by create-workflow
 *
 * Functions:
 *   sendExistingPosts()  send every post not sent before (oldest first); safe to re-run
 *   checkNewPosts()      send posts published since the last run (5-minute trigger)
 *   setupTrigger()       create the 5-minute trigger once (never duplicates it)
 *
 * Duplicates are prevented twice: this script remembers sent post ids, and the
 * engine rejects any post id it has already accepted (HTTP 200 "duplicate").
 */

var BT_BLOG_URL = 'https://yakobsendeku.blogspot.com';
var BT_PAGE_SIZE = 25;
var BT_MAX_REMEMBERED = 300;

function checkNewPosts() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('checkNewPosts: previous run still active, skipping.');
    return null;
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var sent = btLoadSent_(props);
    var entries = btFetchEntries_(1, BT_PAGE_SIZE);
    if (!props.getProperty('BT_BASELINE')) {
      // First run: do not flood the channel with old posts; sendExistingPosts() is for that.
      entries.forEach(function (e) {
        sent[btPostId_(e)] = 1;
      });
      btSaveSent_(props, sent);
      props.setProperty('BT_BASELINE', new Date().toISOString());
      Logger.log('checkNewPosts: first run, marked ' + entries.length + ' existing post(s) as handled. New posts are sent from now on.');
      return { sent: 0, duplicate: 0, failed: 0, baseline: entries.length };
    }
    var fresh = entries
      .filter(function (e) {
        return !sent[btPostId_(e)];
      })
      .reverse();
    var result = btSendAll_(fresh, sent, props, 0);
    Logger.log('checkNewPosts: ' + JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function sendExistingPosts() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('sendExistingPosts: another run is active, try again later.');
    return null;
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var sent = btLoadSent_(props);
    var all = [];
    for (var start = 1; start <= 500; start += BT_PAGE_SIZE) {
      var page = btFetchEntries_(start, BT_PAGE_SIZE);
      all = all.concat(page);
      if (page.length < BT_PAGE_SIZE) break;
    }
    if (!props.getProperty('BT_BASELINE')) props.setProperty('BT_BASELINE', new Date().toISOString());
    var todo = all
      .filter(function (e) {
        return !sent[btPostId_(e)];
      })
      .reverse();
    Logger.log('sendExistingPosts: ' + all.length + ' post(s) found, ' + todo.length + ' not sent yet.');
    // Pause between posts: Telegram allows about 20 messages per minute in one channel.
    var result = btSendAll_(todo, sent, props, 3000);
    Logger.log('sendExistingPosts: ' + JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function setupTrigger() {
  AE_POLL_HANDLER = 'checkNewPosts';
  return aeEnsureTrigger();
}

// ---------------------------------------------------------------------------

function btSendAll_(entries, sent, props, pauseMs) {
  var result = { sent: 0, duplicate: 0, failed: 0 };
  for (var i = 0; i < entries.length; i++) {
    var payload = btPayload_(entries[i]);
    var outcome = btPost_(payload);
    if (outcome === 'accepted' || outcome === 'duplicate') {
      sent[payload.id] = 1;
      btSaveSent_(props, sent);
      result[outcome === 'accepted' ? 'sent' : 'duplicate']++;
    } else {
      result.failed++; // left unmarked: retried on the next run
      if (outcome === 'unauthorized') {
        Logger.log('Webhook token rejected (HTTP 401): check the WEBHOOK_TOKEN Script Property. Stopping.');
        break;
      }
    }
    if (pauseMs && i < entries.length - 1) Utilities.sleep(pauseMs);
  }
  return result;
}

function btPost_(payload) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBHOOK_URL');
  var token = props.getProperty('WEBHOOK_TOKEN');
  if (!url || !token) throw new Error('Set the Script Properties WEBHOOK_URL and WEBHOOK_TOKEN first.');
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code === 202) return 'accepted';
    if (code === 200) return 'duplicate';
    if (code === 401) return 'unauthorized';
    Logger.log('Post ' + payload.id + ': HTTP ' + code + ' ' + String(res.getContentText()).slice(0, 200));
    return 'failed';
  } catch (e) {
    Logger.log('Post ' + payload.id + ': ' + e + ' (is cloudflared running and WEBHOOK_URL current?)');
    return 'failed';
  }
}

function btFetchEntries_(startIndex, count) {
  var url = BT_BLOG_URL + '/feeds/posts/default?alt=json&orderby=published&start-index=' + startIndex + '&max-results=' + count;
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Blogger feed returned HTTP ' + res.getResponseCode() + ' (is the blog feed enabled?)');
  var feed = JSON.parse(res.getContentText());
  return (feed.feed && feed.feed.entry) || [];
}

function btPostId_(entry) {
  var raw = String(entry.id && entry.id.$t);
  var match = /post-(\d+)/.exec(raw);
  return match ? match[1] : raw;
}

function btPayload_(entry) {
  var link = (entry.link || []).filter(function (l) {
    return l.rel === 'alternate';
  })[0];
  var html = (entry.content && entry.content.$t) || (entry.summary && entry.summary.$t) || '';
  var text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return {
    id: btPostId_(entry),
    type: 'post.published',
    title: (entry.title && entry.title.$t) || '',
    excerpt: text.slice(0, 1000),
    url: link ? link.href : BT_BLOG_URL,
    image: aeExtractImage(entry),
    author: { name: (entry.author && entry.author[0] && entry.author[0].name && entry.author[0].name.$t) || '' },
    published: (entry.published && entry.published.$t) || '',
  };
}

function btLoadSent_(props) {
  var sent = {};
  try {
    JSON.parse(props.getProperty('BT_SENT_IDS') || '[]').forEach(function (id) {
      sent[id] = 1;
    });
  } catch (e) {
    // Corrupt value: start over; the engine still rejects duplicates.
  }
  return sent;
}

function btSaveSent_(props, sent) {
  var ids = Object.keys(sent);
  props.setProperty('BT_SENT_IDS', JSON.stringify(ids.slice(Math.max(0, ids.length - BT_MAX_REMEMBERED))));
}
