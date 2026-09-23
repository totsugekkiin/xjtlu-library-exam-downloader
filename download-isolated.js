(function installBrowserFileDownload(root) {
  "use strict";

  if (root.BrowserFileDownload?.version === "0.4.5") {
    return;
  }

  function targetFromViewerUrl(viewerUrl, allowedHostname) {
    try {
      const viewer = new URL(viewerUrl);
      if (viewer.hostname.toLowerCase() !== allowedHostname.toLowerCase()) {
        return { ok: false, error: `只支持 ${allowedHostname}` };
      }

      const fileValue = viewer.searchParams.get("file");
      if (!fileValue) {
        return { ok: false, error: "当前页面不是试卷 PDF 查看器：缺少 file 参数" };
      }

      const target = new URL(fileValue, viewer.origin);
      if (target.origin !== viewer.origin) {
        return { ok: false, error: "为安全起见，不允许请求其他网站的文件" };
      }
      if (!/(?:^|\/)browserfile(?:\/|$)/i.test(target.pathname)) {
        return { ok: false, error: "file 参数不是 BrowserFile 接口" };
      }
      return { ok: true, targetUrl: target.href };
    } catch {
      return { ok: false, error: "当前页面地址无效" };
    }
  }

  function hasPdfMagicBytes(bytes) {
    return bytes.length >= 5
      && bytes[0] === 0x25
      && bytes[1] === 0x50
      && bytes[2] === 0x44
      && bytes[3] === 0x46
      && bytes[4] === 0x2d;
  }

  function normalizeBase64(value) {
    let text = String(value || "").trim();
    const dataUrl = text.match(/^data:[^,]*;base64,([\s\S]+)$/i);
    if (dataUrl) {
      text = dataUrl[1];
    }
    text = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padding = text.length % 4;
    return padding ? text + "=".repeat(4 - padding) : text;
  }

  function hasPdfMagicBase64(value) {
    const base64 = normalizeBase64(value);
    if (!/^JVBERi0/i.test(base64)) {
      return false;
    }
    try {
      return atob(base64.slice(0, 12)).startsWith("%PDF-");
    } catch {
      return false;
    }
  }

  function findPdfBase64(value, seen = new WeakSet()) {
    if (typeof value === "string") {
      const base64 = normalizeBase64(value);
      return hasPdfMagicBase64(base64) ? base64 : null;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      return null;
    }
    seen.add(value);
    for (const nested of Object.values(value)) {
      const found = findPdfBase64(nested, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function findPdfBase64InText(text) {
    const direct = findPdfBase64(String(text || ""));
    if (direct) {
      return direct;
    }
    try {
      return findPdfBase64(JSON.parse(text));
    } catch {
      return null;
    }
  }

  function base64ToChunks(base64) {
    const normalized = normalizeBase64(base64);
    const chunks = [];
    let byteLength = 0;
    const base64ChunkSize = 32_768;

    for (let offset = 0; offset < normalized.length; offset += base64ChunkSize) {
      const binary = atob(normalized.slice(offset, offset + base64ChunkSize));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      chunks.push(bytes);
      byteLength += bytes.length;
    }
    return { chunks, byteLength };
  }

  function cleanFilename(value) {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
    return cleaned || "exam.pdf";
  }

  function filenameFromDisposition(disposition) {
    if (!disposition) {
      return null;
    }
    const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (encoded) {
      try {
        return cleanFilename(decodeURIComponent(encoded[1].replace(/^"|"$/g, "")));
      } catch {
        // Fall through to the plain filename form.
      }
    }
    const plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
    return plain ? cleanFilename(plain[1] || plain[2]) : null;
  }

  function fallbackFilename(targetUrl) {
    const url = new URL(targetUrl);
    const recordId = url.searchParams.get("recordId");
    return recordId ? `exam-${cleanFilename(recordId)}.pdf` : `exam-${Date.now()}.pdf`;
  }

  function ensurePdfExtension(filename) {
    const cleaned = cleanFilename(filename);
    return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
  }

  async function download(targetUrl) {
    let response;
    try {
      response = await fetch(targetUrl, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });
    } catch (error) {
      return { ok: false, error: `网络请求失败：${error?.message || error}` };
    }

    if (!response.ok) {
      const permissionHint = response.status === 401 || response.status === 403
        ? "；登录可能已过期，或当前账号没有权限"
        : "";
      return { ok: false, error: `服务器返回 HTTP ${response.status}${permissionHint}` };
    }

    const contentType = response.headers.get("content-type") || "";
    const disposition = response.headers.get("content-disposition");
    const buffer = await response.arrayBuffer();
    const responseBytes = new Uint8Array(buffer);
    let blobParts;
    let byteLength;

    if (hasPdfMagicBytes(responseBytes)) {
      blobParts = [responseBytes];
      byteLength = responseBytes.length;
    } else {
      const text = new TextDecoder().decode(responseBytes);
      if (/text\/html/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(text)) {
        return { ok: false, error: "服务器返回了网页而不是 PDF；请重新登录并从试卷列表打开查看器" };
      }

      const pdfBase64 = findPdfBase64InText(text);
      if (!pdfBase64) {
        return {
          ok: false,
          error: `响应不是有效的 PDF 或 Base64 PDF（Content-Type: ${contentType || "未知"}）`
        };
      }
      const decoded = base64ToChunks(pdfBase64);
      blobParts = decoded.chunks;
      byteLength = decoded.byteLength;
    }

    const filename = ensurePdfExtension(
      filenameFromDisposition(disposition) || fallbackFilename(targetUrl)
    );
    const blobUrl = URL.createObjectURL(new Blob(blobParts, { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);

    return { ok: true, filename, byteLength };
  }

  root.BrowserFileDownload = {
    version: "0.4.5",
    targetFromViewerUrl,
    hasPdfMagicBytes,
    hasPdfMagicBase64,
    findPdfBase64InText,
    ensurePdfExtension,
    download
  };
})(globalThis);
