const tweetCountBadge = document.getElementById("tweetCountBadge");
const captureToggle = document.getElementById("captureToggle");
const scrollCountInput = document.getElementById("scrollCount");
const startAutoBtn = document.getElementById("startAutoBtn");
const stopAutoBtn = document.getElementById("stopAutoBtn");
const pushBtn = document.getElementById("pushBtn");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const backendUrlInput = document.getElementById("backendUrl");
const statusMsg = document.getElementById("statusMsg");
const creatorsList = document.getElementById("creatorsList");

let activeCategory = "全部";
let suppressAutoStatusOverwrite = false;
let lastRenderedStopKey = "";

function setStatus(text, isError = false) {
  statusMsg.textContent = text;
  statusMsg.style.color = isError ? "#a1260c" : "#2f3846";
}

function formatStopStatus(res) {
  const captured = typeof res.autoScrollCaptured === "number" ? res.autoScrollCaptured : 0;
  switch (res.autoScrollStopReason) {
    case "target_reached":
      return { text: `自动滚动完成，本次新采集 ${captured} 条推文。`, isError: false };
    case "stalled":
      return {
        text: `已停止自动滚动：页面未继续加载更多推文（可能已到底部、需要登录或触发 X 限流），本次新采集 ${captured} 条。`,
        isError: true,
      };
    case "already_seen_limit":
      return {
        text: `已停止自动滚动：连续多屏均为已收录推文，本次新采集 ${captured} 条。`,
        isError: false,
      };
    case "manual":
      return { text: `已停止自动滚动，本次新采集 ${captured} 条。`, isError: false };
    default:
      return null;
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    tweetCountBadge.textContent = `${res.total} 条`;
    captureToggle.checked = Boolean(res.captureEnabled);
    if (res.backendUrl && document.activeElement !== backendUrlInput) {
      backendUrlInput.value = res.backendUrl;
    }
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id || !tab.url || (!tab.url.includes("x.com") && !tab.url.includes("twitter.com"))) {
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_STATE" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      if (res.autoScrollActive) {
        suppressAutoStatusOverwrite = false;
        lastRenderedStopKey = "";
        startAutoBtn.classList.add("hidden");
        stopAutoBtn.classList.remove("hidden");
        if (res.autoScrollPhase === "waiting_load") {
          setStatus(`正在等待 X.com 加载更多推文 (${res.autoScrollCaptured}/${res.autoScrollTarget})...`);
        } else {
          setStatus(`自动滚动采集中 (${res.autoScrollCaptured}/${res.autoScrollTarget})...`);
        }
      } else {
        startAutoBtn.classList.remove("hidden");
        stopAutoBtn.classList.add("hidden");
        if (!suppressAutoStatusOverwrite && res.autoScrollStopReason) {
          const stopKey = `${res.autoScrollStopReason}:${res.autoScrollCaptured}:${res.autoScrollTarget}`;
          if (stopKey !== lastRenderedStopKey) {
            lastRenderedStopKey = stopKey;
            const info = formatStopStatus(res);
            if (info) {
              setStatus(info.text, info.isError);
            }
          }
        }
      }
    });
  });
}

function sendToActiveXTab(message, onSuccess) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id || !tab.url || (!tab.url.includes("x.com") && !tab.url.includes("twitter.com"))) {
      setStatus("请先在当前标签页打开 x.com（如“推荐博主”里的主页或你的 List）。", true);
      return;
    }
    chrome.tabs.sendMessage(tab.id, message, (res) => {
      if (chrome.runtime.lastError) {
        setStatus("页面脚本尚未就绪，请刷新 X.com 页面后再试。", true);
        return;
      }
      if (onSuccess) onSuccess(res);
    });
  });
}

// Tab switching
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

captureToggle.addEventListener("change", () => {
  const enabled = captureToggle.checked;
  suppressAutoStatusOverwrite = true;
  chrome.storage.local.set({ captureEnabled: enabled });
  sendToActiveXTab({ type: "SET_CAPTURE", enabled }, () => {
    setStatus(enabled ? "已开启英文推文采集，浏览即可自动收集。" : "已暂停采集。");
  });
});

startAutoBtn.addEventListener("click", () => {
  const targetCount = Number(scrollCountInput.value) || 30;
  captureToggle.checked = true;
  suppressAutoStatusOverwrite = false;
  lastRenderedStopKey = "";
  sendToActiveXTab({ type: "START_AUTO_SCROLL", targetCount }, (res) => {
    startAutoBtn.classList.add("hidden");
    stopAutoBtn.classList.remove("hidden");
    setStatus(`开始温和自动滚动采集，目标 ${res.target} 条...`);
  });
});

stopAutoBtn.addEventListener("click", () => {
  suppressAutoStatusOverwrite = false;
  lastRenderedStopKey = "";
  sendToActiveXTab({ type: "STOP_AUTO_SCROLL" }, () => {
    startAutoBtn.classList.remove("hidden");
    stopAutoBtn.classList.add("hidden");
    refreshStatus();
  });
});

backendUrlInput.addEventListener("change", () => {
  chrome.storage.local.set({ backendUrl: backendUrlInput.value.trim() });
});

pushBtn.addEventListener("click", () => {
  suppressAutoStatusOverwrite = true;
  setStatus("正在推送到本地学习工具...");
  chrome.runtime.sendMessage(
    { type: "PUSH_TO_BACKEND", backendUrl: backendUrlInput.value.trim() },
    (res) => {
      if (res && res.ok) {
        setStatus(`推送成功！本次新增 ${res.added} 条，后端共 ${res.total_tweets} 条推文。`);
      } else {
        setStatus((res && res.error) || "推送失败", true);
      }
    }
  );
});

exportBtn.addEventListener("click", () => {
  suppressAutoStatusOverwrite = true;
  chrome.runtime.sendMessage({ type: "EXPORT_JSON" }, (res) => {
    if (res && res.ok) {
      setStatus(`已导出 ${res.count} 条推文为 JSON 文件。`);
    } else {
      setStatus((res && res.error) || "导出失败", true);
    }
  });
});

clearBtn.addEventListener("click", () => {
  suppressAutoStatusOverwrite = true;
  chrome.runtime.sendMessage({ type: "CLEAR_TWEETS" }, () => {
    refreshStatus();
    setStatus("已清空浏览器缓存队列。");
  });
});

function renderCreators() {
  const creators = (window.STARTER_CREATORS || []).filter(
    (c) => activeCategory === "全部" || c.category === activeCategory
  );
  creatorsList.innerHTML = "";
  creators.forEach((creator) => {
    const item = document.createElement("div");
    item.className = "creator-item";
    item.innerHTML = `
      <div class="creator-top">
        <span class="creator-name">${creator.name}</span>
        <span class="creator-tag">${creator.category} · ${creator.difficulty}</span>
      </div>
      <div class="creator-handle">@${creator.handle}</div>
      <div class="creator-note">${creator.note}</div>
    `;
    item.addEventListener("click", () => {
      chrome.tabs.create({ url: `https://x.com/${creator.handle}` });
    });
    creatorsList.appendChild(item);
  });
}

document.querySelectorAll("#creatorFilters .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#creatorFilters .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeCategory = chip.dataset.cat;
    renderCreators();
  });
});

renderCreators();
refreshStatus();
setInterval(refreshStatus, 1800);
