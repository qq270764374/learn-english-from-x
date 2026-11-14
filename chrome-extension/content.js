(() => {
  const MAX_SESSION_SCROLL_LIMIT = 150;
  const MAX_STALLED_ROUNDS = 5;
  const MAX_LOADING_WAIT_ROUNDS = 8;
  const MAX_ALREADY_SEEN_ROUNDS = 30;

  let captureEnabled = false;
  let autoScrollTimer = null;
  let nudgeTimer = null;
  let scanDebounceTimer = null;
  let scrollScanTimer = null;

  let autoScrollActive = false;
  let autoScrollTarget = 30;
  let autoScrollCaptured = 0;
  let autoScrollPhase = "idle"; // "idle" | "scrolling" | "waiting_load" | "stopped"
  let autoScrollStopReason = ""; // "" | "target_reached" | "stalled" | "already_seen_limit" | "manual"

  let stalledRounds = 0;
  let alreadySeenRounds = 0;
  let roundIndex = 0;
  let newAddedSinceTick = false;
  let pendingSaveCount = 0;
  let prevScrollY = 0;
  let prevScrollHeight = 0;
  let prevVisibleSignature = "";
  let lastKnownTotal = 0;

  let observer = null;
  let scrollListenerAttached = false;
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

    const timeEl = article.querySelector("time[datetime]");
    const timeLink = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
    const linkEl = timeLink || article.querySelector('a[href*="/status/"]');
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
    if (!document.body) return null;
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
    if (!pill) return;
    if (!captureEnabled && !autoScrollActive) {
      pill.style.display = "none";
      return;
    }
    pill.style.display = "flex";
    if (autoScrollActive) {
      if (autoScrollPhase === "waiting_load") {
        pill.textContent = `等待页面加载更多 (${autoScrollCaptured}/${autoScrollTarget}) · 已存 ${totalSaved} 条`;
      } else {
        pill.textContent = `自动滚动采集中 (${autoScrollCaptured}/${autoScrollTarget}) · 已存 ${totalSaved} 条`;
      }
    } else {
      pill.textContent = `英文采集开启 · 已存 ${totalSaved} 条`;
    }
  }

  function getScrollMetrics() {
    const doc = document.scrollingElement || document.documentElement;
    const scrollY = window.scrollY ?? (doc ? doc.scrollTop : 0) ?? 0;
    const scrollHeight = doc ? doc.scrollHeight : 0;
    const viewportHeight = window.innerHeight || (doc ? doc.clientHeight : 0) || 0;
    const atBottom = viewportHeight + scrollY >= scrollHeight - 60;
    return { scrollY, scrollHeight, viewportHeight, atBottom };
  }

  function getVisibleTweetSnapshot() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const ids = [];
    articles.forEach((article) => {
      const link = article.querySelector('a[href*="/status/"]');
      const href = link ? link.getAttribute("href") || "" : "";
      const match = href.match(/\/status\/(\d+)/);
      if (match) ids.push(match[1]);
    });
    return {
      count: articles.length,
      signature: ids.join(","),
    };
  }

  function isXLoadingMore() {
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary) return false;
    const spinners = primary.querySelectorAll('[role="progressbar"]');
    for (const el of spinners) {
      if (!el.closest('article[data-testid="tweet"]')) {
        return true;
      }
    }
    return false;
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
      pendingSaveCount += 1;
      chrome.runtime.sendMessage({ type: "SAVE_TWEETS", tweets: batch }, (res) => {
        pendingSaveCount = Math.max(0, pendingSaveCount - 1);
        if (chrome.runtime.lastError) return;
        if (res && typeof res.total === "number") {
          lastKnownTotal = res.total;
        }
        if (autoScrollActive && res && typeof res.added === "number" && res.added > 0) {
          autoScrollCaptured += res.added;
          newAddedSinceTick = true;
          stalledRounds = 0;
          alreadySeenRounds = 0;
          if (autoScrollCaptured >= autoScrollTarget) {
            stopAutoScroll("target_reached");
            return;
          }
        }
        updatePill(lastKnownTotal);
      });
    }
    return batch.length;
  }

  function scheduleScan(delay = 220) {
    if (!captureEnabled && !autoScrollActive) return;
    if (scanDebounceTimer) return;
    scanDebounceTimer = setTimeout(() => {
      scanDebounceTimer = null;
      scanVisibleTweets();
    }, delay);
  }

  function startObserver() {
    if (!observer && document.body) {
      observer = new MutationObserver(() => {
        scheduleScan(220);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    if (!scrollListenerAttached) {
      scrollListenerAttached = true;
      window.addEventListener(
        "scroll",
        () => {
          if (!captureEnabled && !autoScrollActive) return;
          if (scrollScanTimer) clearTimeout(scrollScanTimer);
          scrollScanTimer = setTimeout(() => {
            scrollScanTimer = null;
            scanVisibleTweets();
          }, 260);
        },
        { passive: true }
      );
    }
    scanVisibleTweets();
  }

  function stopAutoScroll(reason = "manual") {
    autoScrollActive = false;
    autoScrollPhase = "stopped";
    autoScrollStopReason = reason;
    if (autoScrollTimer) {
      clearTimeout(autoScrollTimer);
      autoScrollTimer = null;
    }
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
    updatePill(lastKnownTotal);
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && typeof res.total === "number") {
        lastKnownTotal = res.total;
        updatePill(lastKnownTotal);
      }
    });
  }

  function nudgeBottomForLoad() {
    if (!autoScrollActive) return;
    window.scrollBy({ top: -180, behavior: "auto" });
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (!autoScrollActive) return;
      const { scrollHeight } = getScrollMetrics();
      window.scrollTo({ top: scrollHeight, behavior: "smooth" });
    }, 180);
  }

  function scheduleNextScroll() {
    if (!autoScrollActive) return;
    if (autoScrollCaptured >= autoScrollTarget) {
      stopAutoScroll("target_reached");
      return;
    }

    const newlyFoundSync = scanVisibleTweets();
    const { scrollY, scrollHeight, atBottom } = getScrollMetrics();
    const snapshot = getVisibleTweetSnapshot();
    const isLoading = isXLoadingMore();

    if (roundIndex === 0) {
      prevScrollY = scrollY;
      prevScrollHeight = scrollHeight;
      prevVisibleSignature = snapshot.signature;
      newAddedSinceTick = false;
      autoScrollPhase = "scrolling";
      updatePill(lastKnownTotal);
    } else {
      const hadCaptureProgress = newAddedSinceTick || newlyFoundSync > 0 || pendingSaveCount > 0;
      const scrollMoved = scrollY > prevScrollY + 20;
      const heightGrew = scrollHeight > prevScrollHeight + 20;
      const visibleChanged = snapshot.signature !== prevVisibleSignature && snapshot.signature !== "";

      if (hadCaptureProgress) {
        stalledRounds = 0;
        alreadySeenRounds = 0;
        autoScrollPhase = "scrolling";
      } else if (scrollMoved || heightGrew || visibleChanged) {
        stalledRounds = 0;
        alreadySeenRounds += 1;
        autoScrollPhase = "scrolling";
        if (alreadySeenRounds >= MAX_ALREADY_SEEN_ROUNDS) {
          stopAutoScroll("already_seen_limit");
          return;
        }
      } else {
        stalledRounds += 1;
        autoScrollPhase = "waiting_load";

        if (atBottom && (stalledRounds === 1 || stalledRounds === 3)) {
          nudgeBottomForLoad();
        }

        const maxStall = isLoading ? MAX_LOADING_WAIT_ROUNDS : MAX_STALLED_ROUNDS;
        if (stalledRounds >= maxStall) {
          stopAutoScroll("stalled");
          return;
        }
      }

      prevScrollY = scrollY;
      prevScrollHeight = scrollHeight;
      if (snapshot.signature) {
        prevVisibleSignature = snapshot.signature;
      }
      newAddedSinceTick = false;
      updatePill(lastKnownTotal);
    }

    roundIndex += 1;

    // Gentle randomized scroll distance and human-like pause (1.8s - 3.4s)
    if (autoScrollPhase !== "waiting_load") {
      const distance = 580 + Math.floor(Math.random() * 340);
      window.scrollBy({ top: distance, behavior: "smooth" });
    } else if (!atBottom) {
      window.scrollBy({ top: 320, behavior: "smooth" });
    }

    const delayMs = 1800 + Math.floor(Math.random() * 1600);
    autoScrollTimer = setTimeout(scheduleNextScroll, delayMs);
  }

  function startAutoScroll(targetCount) {
    if (autoScrollTimer) {
      clearTimeout(autoScrollTimer);
      autoScrollTimer = null;
    }
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
    captureEnabled = true;
    chrome.storage.local.set({ captureEnabled: true });

    autoScrollTarget = Math.min(Math.max(Number(targetCount) || 30, 5), MAX_SESSION_SCROLL_LIMIT);
    autoScrollCaptured = 0;
    autoScrollPhase = "scrolling";
    autoScrollStopReason = "";
    stalledRounds = 0;
    alreadySeenRounds = 0;
    roundIndex = 0;
    newAddedSinceTick = false;
    pendingSaveCount = 0;
    autoScrollActive = true;

    startObserver();
    updatePill(lastKnownTotal);
    scheduleNextScroll();
  }

  chrome.storage.local.get(["captureEnabled", "tweets"], (data) => {
    captureEnabled = Boolean(data.captureEnabled);
    const tweets = Array.isArray(data.tweets) ? data.tweets : [];
    lastKnownTotal = tweets.length;
    tweets.forEach((t) => {
      if (t && t.id) seenSessionIds.add(t.id);
    });
    if (captureEnabled) {
      startObserver();
      updatePill(lastKnownTotal);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.tweets) {
      const nextTweets = Array.isArray(changes.tweets.newValue) ? changes.tweets.newValue : [];
      if (nextTweets.length === 0) {
        seenSessionIds.clear();
      } else {
        nextTweets.forEach((t) => {
          if (t && t.id) seenSessionIds.add(t.id);
        });
      }
      lastKnownTotal = nextTweets.length;
      updatePill(lastKnownTotal);
    }
    if (changes.captureEnabled) {
      captureEnabled = Boolean(changes.captureEnabled.newValue);
      if (captureEnabled) {
        startObserver();
      } else if (autoScrollActive) {
        stopAutoScroll("manual");
      }
      updatePill(lastKnownTotal);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "SET_CAPTURE") {
      captureEnabled = Boolean(msg.enabled);
      if (captureEnabled) {
        startObserver();
      } else {
        stopAutoScroll("manual");
      }
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
        if (!chrome.runtime.lastError && res && typeof res.total === "number") {
          lastKnownTotal = res.total;
        }
        updatePill(lastKnownTotal);
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
      stopAutoScroll("manual");
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "GET_PAGE_STATE") {
      sendResponse({
        captureEnabled,
        autoScrollActive,
        autoScrollCaptured,
        autoScrollTarget,
        autoScrollPhase,
        autoScrollStopReason,
      });
      return true;
    }

    return false;
  });
})();
