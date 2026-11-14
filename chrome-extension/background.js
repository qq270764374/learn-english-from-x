const DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";
let storageQueue = Promise.resolve();

function enqueueStorageTask(fn) {
  const next = storageQueue.then(fn, fn);
  storageQueue = next.catch(() => {});
  return next;
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data || {}));
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function updateBadge(count) {
  const text = count > 0 ? String(count > 999 ? "999+" : count) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#b44322" });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["tweets"], (data) => {
    updateBadge((data.tweets || []).length);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SAVE_TWEETS") {
    enqueueStorageTask(async () => {
      const data = await storageGet(["tweets"]);
      const existing = Array.isArray(data.tweets) ? data.tweets : [];
      const seen = new Set(existing.map((t) => t.id));
      let added = 0;
      for (const item of msg.tweets || []) {
        if (item && item.id && !seen.has(item.id)) {
          existing.push(item);
          seen.add(item.id);
          added += 1;
        }
      }
      await storageSet({ tweets: existing });
      updateBadge(existing.length);
      sendResponse({ added, total: existing.length });
    });
    return true;
  }

  if (msg.type === "GET_STATUS") {
    chrome.storage.local.get(["tweets", "captureEnabled", "backendUrl"], (data) => {
      sendResponse({
        total: (data.tweets || []).length,
        captureEnabled: Boolean(data.captureEnabled),
        backendUrl: data.backendUrl || DEFAULT_BACKEND_URL,
      });
    });
    return true;
  }

  if (msg.type === "CLEAR_TWEETS") {
    enqueueStorageTask(async () => {
      await storageSet({ tweets: [] });
      updateBadge(0);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "PUSH_TO_BACKEND") {
    chrome.storage.local.get(["tweets", "backendUrl"], async (data) => {
      const tweets = Array.isArray(data.tweets) ? data.tweets : [];
      if (tweets.length === 0) {
        sendResponse({ ok: false, error: "当前没有已采集的推文。" });
        return;
      }
      const baseUrl = (msg.backendUrl || data.backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, "");
      try {
        const resp = await fetch(`${baseUrl}/api/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tweets }),
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const json = await resp.json();
        sendResponse({ ok: true, added: json.added, total_tweets: json.total_tweets });
      } catch (err) {
        sendResponse({
          ok: false,
          error: `无法连接本地学习工具 (${baseUrl})，请确认已运行 start.sh，或先点“导出 JSON”手动导入。(${err.message})`,
        });
      }
    });
    return true;
  }

  if (msg.type === "EXPORT_JSON") {
    chrome.storage.local.get(["tweets"], (data) => {
      const tweets = Array.isArray(data.tweets) ? data.tweets : [];
      if (tweets.length === 0) {
        sendResponse({ ok: false, error: "当前没有已采集的推文。" });
        return;
      }
      const jsonStr = JSON.stringify(tweets, null, 2);
      const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(jsonStr);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: `x-tweets-${stamp}.json`,
          saveAs: true,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, downloadId, count: tweets.length });
          }
        }
      );
    });
    return true;
  }

  return false;
});
