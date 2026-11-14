(() => {
  const MAX_SESSION_SCROLL_LIMIT = 150;
  let captureEnabled = false;
  let autoScrollTimer = null;
  let autoScrollActive = false;
  let autoScrollTarget = 30;
  let autoScrollCaptured = 0;
  let idleRounds = 0;
  let observer = null;
  let badgePill = null;

  const seenSessionIds = new Set();

  function detectSourcePage() {
    const path = location.pathname;
    if (path.includes("/lists/")) return "list";
    if (path.includes("/bookmarks")) return "bookmarks";
    if (path.startsWith("/search")) return "search";
    if (path === "/home") return "home";
    return "profile";
  }

  function isMostlyEnglish(text, langAttr) {
    if (langAttr && langAttr !== "en" && !langAttr.startsWith("en-")) {
      return false;
    }
    const clean = text.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim();
    if (clean.length < 18) return false;
    const asciiLetters = (clean.match(/[A-Za-z]/g) || []).length;
    const cjkChars = (clean.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    if (cjkChars > 4 && cjkChars > asciiLetters * 0.2) return false;
    return asciiLetters >= 12;
  }

  function parseTweetArticle(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return null;

    const text = (textEl.innerText || "").trim();
    const langAttr = textEl.getAttribute("lang");
    if (!isMostlyEnglish(text, langAttr)) return null;

    const linkEl = article.querySelector('a[href*="/status/"]');
    if (!linkEl) return null;
    const href = linkEl.getAttribute("href") || "";
    const match = href.match(/\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;

    const handleFromUrl = match[1];
    const tweetId = match[2];
    const url = `https://x.com/${handleFromUrl}/status/${tweetId}`;

    let authorName = handleFromUrl;
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    if (userNameEl) {
      const firstSpan = userNameEl.querySelector("span");
      if (firstSpan && firstSpan.innerText) {
        authorName = firstSpan.innerText.trim();
      }
    }

    const timeEl = article.querySelector("time[datetime]");
    const createdAt = timeEl ? timeEl.getAttribute("datetime") || "" : "";

    return {
      id: tweetId,
      url,
      author_handle: handleFromUrl,
      author_name: authorName,
      text,
      created_at: createdAt,
      source_page: detectSourcePage(),
    };
  }

  function ensurePill() {
    if (badgePill) return badgePill;
    const pill = document.createElement("div");
    pill.id = "lex-capture-pill";
    Object.assign(pill.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      zIndex: "99999",
      background: "#14181f",
      color: "#faf8f5",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "12px",
      fontWeight: "600",
      padding: "8px 14px",
      borderRadius: "999px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
      border: "1px solid rgba(255,255,255,0.14)",
      display: "none",
      alignItems: "center",
      gap: "8px",
    });
    document.body.appendChild(pill);
    badgePill = pill;
    return pill;
  }

  function updatePill(totalSaved) {
    const pill = ensurePill();
    if (!captureEnabled && !autoScrollActive) {
      pill.style.display = "none";
      return;
    }
    pill.style.display = "flex";
    if (autoScrollActive) {
      pill.textContent = `自动滚动采集中 (${autoScrollCaptured}/${autoScrollTarget}) · 已存 ${totalSaved} 条`;
    } else {
      pill.textContent = `英文采集开启 · 已存 ${totalSaved} 条`;
    }
  }

  function scanVisibleTweets() {
    if (!captureEnabled && !autoScrollActive) return 0;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const batch = [];
    articles.forEach((article) => {
      const parsed = parseTweetArticle(article);
      if (parsed && !seenSessionIds.has(parsed.id)) {
        seenSessionIds.add(parsed.id);
        batch.push(parsed);
      }
    });

    if (batch.length > 0) {
      chrome.runtime.sendMessage({ type: "SAVE_TWEETS", tweets: batch }, (res) => {
        if (chrome.runtime.lastError) return;
        const total = res && typeof res.total === "number" ? res.total : seenSessionIds.size;
        if (autoScrollActive && res && typeof res.added === "number") {
          autoScrollCaptured += res.added;
        }
        updatePill(total);
      });
    }
    return batch.length;
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      scanVisibleTweets();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanVisibleTweets();
  }

  function stopAutoScroll() {
    autoScrollActive = false;
    if (autoScrollTimer) {
      clearTimeout(autoScrollTimer);
      autoScrollTimer = null;
    }
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
      updatePill((res && res.total) || 0);
    });
  }

  function scheduleNextScroll() {
    if (!autoScrollActive) return;
    if (autoScrollCaptured >= autoScrollTarget) {
      stopAutoScroll();
      return;
    }
    const newlyFound = scanVisibleTweets();
    if (newlyFound === 0) {
      idleRounds += 1;
    } else {
      idleRounds = 0;
    }

    if (idleRounds >= 5) {
      stopAutoScroll();
      return;
    }

    // Gentle randomized scroll distance and human-like pause (1.8s - 3.4s)
    const distance = 580 + Math.floor(Math.random() * 340);
    window.scrollBy({ top: distance, behavior: "smooth" });
    const delayMs = 1800 + Math.floor(Math.random() * 1600);
    autoScrollTimer = setTimeout(scheduleNextScroll, delayMs);
  }

  function startAutoScroll(targetCount) {
    captureEnabled = true;
    chrome.storage.local.set({ captureEnabled: true });
    startObserver();
    autoScrollTarget = Math.min(Math.max(Number(targetCount) || 30, 5), MAX_SESSION_SCROLL_LIMIT);
    autoScrollCaptured = 0;
    idleRounds = 0;
    autoScrollActive = true;
    scheduleNextScroll();
  }

  chrome.storage.local.get(["captureEnabled", "tweets"], (data) => {
    captureEnabled = Boolean(data.captureEnabled);
    if (Array.isArray(data.tweets)) {
      data.tweets.forEach((t) => seenSessionIds.add(t.id));
    }
    if (captureEnabled) {
      startObserver();
      updatePill((data.tweets || []).length);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "SET_CAPTURE") {
      captureEnabled = Boolean(msg.enabled);
      if (captureEnabled) {
        startObserver();
      } else {
        stopAutoScroll();
      }
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
        updatePill((res && res.total) || 0);
      });
      sendResponse({ ok: true, captureEnabled });
      return true;
    }

    if (msg.type === "START_AUTO_SCROLL") {
      startAutoScroll(msg.targetCount);
      sendResponse({ ok: true, target: autoScrollTarget });
      return true;
    }

    if (msg.type === "STOP_AUTO_SCROLL") {
      stopAutoScroll();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "GET_PAGE_STATE") {
      sendResponse({
        captureEnabled,
        autoScrollActive,
        autoScrollCaptured,
        autoScrollTarget,
      });
      return true;
    }

    return false;
  });
})();
