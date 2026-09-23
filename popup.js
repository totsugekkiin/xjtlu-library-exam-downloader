const ALLOWED_HOSTNAME = "etd.xjtlu.edu.cn";
const downloadButton = document.querySelector("#download");
const statusElement = document.querySelector("#status");
const diagnosisElement = document.querySelector("#diagnosis");

let currentTab;
let targetUrl;

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

async function removeLegacyPageScripts() {
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const legacyIds = scripts
    .map((script) => script.id)
    .filter((id) => id.startsWith("browserfile-capture-"));
  if (legacyIds.length) {
    await chrome.scripting.unregisterContentScripts({ ids: legacyIds });
  }
}

downloadButton.addEventListener("click", async () => {
  downloadButton.disabled = true;
  diagnosisElement.hidden = true;
  setStatus("下载中…");

  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      world: "ISOLATED",
      files: ["download-isolated.js"]
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      world: "ISOLATED",
      func: async (url) => globalThis.BrowserFileDownload.download(url),
      args: [targetUrl]
    });
    const result = results[0]?.result;
    if (!result?.ok) {
      throw new Error(result?.error || "页面没有返回下载结果");
    }

    setStatus("已开始下载");
    diagnosisElement.hidden = false;
    diagnosisElement.textContent = `${result.filename} · ${(result.byteLength / 1024 / 1024).toFixed(2)} MB`;
  } catch (error) {
    downloadButton.disabled = false;
    setStatus("下载失败", true);
    diagnosisElement.textContent = error.message || String(error);
  }
});

(async () => {
  await removeLegacyPageScripts();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!currentTab?.id || !currentTab.url) {
    throw new Error("无法读取当前标签页");
  }

  const parsed = BrowserFileDownload.targetFromViewerUrl(currentTab.url, ALLOWED_HOSTNAME);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  targetUrl = parsed.targetUrl;
  setStatus("可下载");
})().catch((error) => {
  downloadButton.disabled = true;
  diagnosisElement.hidden = false;
  diagnosisElement.textContent = error.message || String(error);
  setStatus("当前页面不可下载", true);
});
