// Images returned by the model: storage, gallery, viewer and download.
//
// Image data is kept in IndexedDB, not localStorage: a single generated
// image is often 1–3 MB of base64, and localStorage holds only ~5 MB.
// Messages store small refs instead:
//   { id, mime }  → blob in IndexedDB
//   { url }       → remote http(s) image, or a data: URL if IndexedDB failed

const DB_NAME = "localllm-studio-images";
const STORE = "images";

let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, data] = dataUrl.split(",", 2);
  const mime = head.match(/^data:([^;,]+)/)?.[1] || "image/png";
  const bin = atob(data.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Persist image sources (data: or http URLs) and return message refs. */
export async function storeImages(srcs) {
  const refs = [];
  for (const src of srcs) {
    if (!src.startsWith("data:")) {
      refs.push({ url: src });
      continue;
    }
    try {
      const blob = dataUrlToBlob(src);
      const id = crypto.randomUUID();
      await withStore("readwrite", (s) => s.put(blob, id));
      refs.push({ id, mime: blob.type });
    } catch (err) {
      console.warn("IndexedDB unavailable, keeping image inline", err);
      refs.push({ url: src });
    }
  }
  return refs;
}

export function deleteStoredImages(refs) {
  const ids = refs.filter((r) => r.id).map((r) => r.id);
  if (!ids.length) return Promise.resolve();
  return withStore("readwrite", (s) => {
    ids.forEach((id) => s.delete(id));
  }).catch(() => {});
}

const objectUrls = new Map();

/** Returns a URL usable as <img src>, or null if the image is gone. */
async function resolveUrl(ref) {
  if (ref.url) return ref.url;
  if (objectUrls.has(ref.id)) return objectUrls.get(ref.id);
  const blob = await withStore("readonly", (s) => s.get(ref.id)).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrls.set(ref.id, url);
  return url;
}

async function resolveBlob(ref) {
  if (ref.id) return withStore("readonly", (s) => s.get(ref.id));
  if (ref.url.startsWith("data:")) return dataUrlToBlob(ref.url);
  const res = await fetch(ref.url); // may fail on CORS
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

function fileName(ref, blob, index) {
  const mime = blob?.type || ref.mime || "image/png";
  const ext = { "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] || "png";
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `image-${stamp}${index ? "-" + (index + 1) : ""}.${ext}`;
}

export async function downloadImage(ref, index = 0) {
  let blob;
  try {
    blob = await resolveBlob(ref);
  } catch {
    // cross-origin image without CORS: let the browser open it instead
    window.open(ref.url, "_blank", "noopener");
    return;
  }
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(ref, blob, index);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Web Share with files lets iPhone users choose "画像を保存" (Photos).
async function shareImage(ref, index = 0) {
  const blob = await resolveBlob(ref);
  const file = new File([blob], fileName(ref, blob, index), { type: blob.type });
  await navigator.share({ files: [file] }).catch(() => {});
}

function canShareFiles() {
  try {
    return !!navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

function actionButton(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * Renders the image gallery of a message right after its .content.
 * `pending` adds a "receiving" placeholder while base64 is streaming in.
 */
export function renderImageGallery(msgEl, refs, { pending = false } = {}) {
  let box = msgEl.querySelector(".msg-images");
  if (!refs.length && !pending) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.className = "msg-images";
    msgEl.querySelector(".content").after(box);
  }
  box.innerHTML = "";

  refs.forEach((ref, i) => {
    const fig = document.createElement("figure");
    fig.className = "msg-image";
    const img = document.createElement("img");
    img.alt = `生成画像 ${i + 1}`;
    img.loading = "lazy";
    img.addEventListener("click", () => openImageViewer(refs, i));
    resolveUrl(ref).then((url) => {
      if (url) img.src = url;
      else fig.classList.add("missing");
    });
    fig.appendChild(img);

    const bar = document.createElement("figcaption");
    bar.appendChild(actionButton("🔍 拡大", "大きく表示", () => openImageViewer(refs, i)));
    bar.appendChild(actionButton("⬇ 保存", "ダウンロード", () => downloadImage(ref, i)));
    if (canShareFiles()) {
      bar.appendChild(actionButton("📤 共有", "共有 / 写真に保存", () => shareImage(ref, i)));
    }
    fig.appendChild(bar);
    box.appendChild(fig);
  });

  if (pending) {
    const ph = document.createElement("div");
    ph.className = "msg-image-pending";
    ph.textContent = "🖼 画像を受信中…";
    box.appendChild(ph);
  }
}

export function openImageViewer(refs, start = 0) {
  let index = start;
  const overlay = document.createElement("div");
  overlay.className = "image-viewer";
  overlay.innerHTML = `
    <div class="image-viewer-bar">
      <span class="image-viewer-count"></span>
      <span class="image-viewer-actions"></span>
    </div>
    <div class="image-viewer-stage"><img alt="" /></div>`;
  const img = overlay.querySelector("img");
  const count = overlay.querySelector(".image-viewer-count");
  const actions = overlay.querySelector(".image-viewer-actions");

  const show = async () => {
    count.textContent = refs.length > 1 ? `${index + 1} / ${refs.length}` : "画像";
    img.src = (await resolveUrl(refs[index])) || "";
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const step = (d) => {
    index = (index + d + refs.length) % refs.length;
    show();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && refs.length > 1) step(1);
    else if (e.key === "ArrowLeft" && refs.length > 1) step(-1);
  };

  if (refs.length > 1) {
    actions.appendChild(actionButton("‹", "前の画像", () => step(-1)));
    actions.appendChild(actionButton("›", "次の画像", () => step(1)));
  }
  actions.appendChild(actionButton("⬇ 保存", "ダウンロード", () => downloadImage(refs[index], index)));
  if (canShareFiles()) {
    actions.appendChild(actionButton("📤 共有", "共有 / 写真に保存", () => shareImage(refs[index], index)));
  }
  actions.appendChild(actionButton("✕", "閉じる (Esc)", close));
  overlay.querySelector(".image-viewer-stage").addEventListener("click", (e) => {
    if (e.target !== img) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  show();
}

/* ------------------------------------------------------------------ *
 * Markdown image extraction
 * ------------------------------------------------------------------ */
const MD_IMAGE =
  /!\[[^\]]*\]\(\s*(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+|https?:\/\/[^\s)]+)\s*(?:"[^"]*")?\s*\)/gi;
const MD_IMAGE_PARTIAL = /!\[[^\]]*\]\(\s*data:[^)]*$/i;

/**
 * Pulls ![](…) images out of answer text so they go to the gallery and
 * their base64 is never sent back to the model as history.
 * `pending` is true while a data-URL image is still streaming in.
 */
export function extractMarkdownImages(text) {
  const srcs = [];
  let out = text.replace(MD_IMAGE, (_, src) => {
    srcs.push(src.replace(/\s+/g, ""));
    return "";
  });
  let pending = false;
  out = out.replace(MD_IMAGE_PARTIAL, () => {
    pending = true;
    return "";
  });
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), srcs, pending };
}
