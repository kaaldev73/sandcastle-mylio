// Upload: pick many files, send each through the batch endpoint with its own
// progress, retry failures, and resume safely. Every file carries a stable
// upload key, so re-sending after an interruption (or a page reload) returns
// the Asset already saved instead of a second one.
import { api, ApiError, describeError } from "./api.js";
import { el } from "./dom.js";

const MAX_ATTEMPTS = 3;

function fileKey(library, file) {
  return ["web", library.id, file.name, file.size, file.lastModified].join(":");
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function formatSize(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

/** Upload panel for one Library; `onDone` runs when a run saved new files. */
export function uploader(library, onDone) {
  // items: [{file, key, state: queued|sending|done|duplicate|failed, progress, error, row, bar, status, retry}]
  const items = [];
  let running = false;

  const input = el("input", { type: "file", multiple: "", accept: "image/*,video/*,.heic,.heif,.raw,.dng", hidden: "" });
  const pick = el("button", { class: "primary", onclick: () => input.click() }, "Upload photos");
  const overall = el("progress", { max: "1", value: "0", "aria-label": "Overall progress", hidden: "" });
  const summary = el("p", { class: "msg", "aria-live": "polite" });
  const retryAll = el("button", { hidden: "", onclick: () => run() }, "Retry failed");
  const list = el("ul", { class: "uploads" });
  const panel = el("div", { class: "upload" }, el("div", { class: "filters" }, pick, retryAll), overall, summary, list);
  panel.append(input);

  function paint(item) {
    item.bar.value = item.state === "queued" ? 0 : item.progress;
    item.status.textContent = {
      queued: "Waiting",
      sending: Math.round(item.progress * 100) + "%",
      done: "Uploaded",
      duplicate: "Already in Library",
      failed: item.error || "Failed",
    }[item.state];
    item.row.className = "upload-" + item.state;
    item.retry.hidden = item.state !== "failed" || running;
  }

  function paintOverall() {
    const total = items.reduce((n, i) => n + i.file.size, 0) || 1;
    const sent = items.reduce((n, i) => n + i.file.size * (i.state === "queued" || i.state === "failed" ? 0 : i.progress), 0);
    overall.hidden = items.length === 0;
    overall.value = sent / total;
    const count = (s) => items.filter((i) => i.state === s).length;
    const finished = count("done") + count("duplicate");
    const failed = count("failed");
    summary.className = "msg" + (failed ? " error" : "");
    summary.textContent = `${finished} of ${items.length} uploaded` + (failed ? `, ${failed} failed` : "");
    retryAll.hidden = failed === 0 || running;
  }

  async function send(item) {
    item.state = "sending";
    item.progress = 0;
    item.error = "";
    paint(item);
    paintOverall();
    let content;
    try {
      content = toBase64(await item.file.arrayBuffer());
    } catch {
      item.state = "failed";
      item.error = describeError(new ApiError(0, "bad_file"));
      return;
    }
    const body = {
      files: [{ filename: item.file.name, modifiedMs: item.file.lastModified, uploadKey: item.key, contentBase64: content }],
    };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { results } = await api("POST", "/api/libraries/" + library.id + "/assets/batch", body, (p) => {
          item.progress = p;
          paint(item);
          paintOverall();
        });
        const result = results[0];
        if (result.status === "failed") {
          item.state = "failed";
          item.error = describeError(new ApiError(0, result.error, result.message));
        } else {
          item.state = result.status === "uploaded" ? "done" : "duplicate";
          item.progress = 1;
        }
        return;
      } catch (err) {
        // Network drop: the same key makes a resend safe. Server answers are final.
        if (err instanceof ApiError || attempt === MAX_ATTEMPTS) {
          item.state = "failed";
          item.error = describeError(err);
          return;
        }
      }
    }
  }

  async function run() {
    if (running) return;
    running = true;
    let saved = false;
    const pending = items.filter((i) => i.state === "queued" || i.state === "failed");
    const worker = async () => {
      for (let item = pending.shift(); item; item = pending.shift()) {
        await send(item);
        if (item.state === "done") saved = true;
        paint(item);
        paintOverall();
      }
    };
    await Promise.all([worker(), worker()]);
    running = false;
    items.forEach(paint);
    paintOverall();
    if (saved) onDone();
  }

  function add(files) {
    for (const file of files) {
      const key = fileKey(library, file);
      if (items.some((i) => i.key === key && i.state !== "failed")) continue;
      const bar = el("progress", { max: "1", value: "0" });
      const status = el("span", { class: "muted" });
      const retry = el("button", { class: "link", hidden: "" }, "Retry");
      const item = { file, key, state: "queued", progress: 0, error: "", bar, status, retry };
      retry.addEventListener("click", () => {
        item.state = "queued";
        paint(item);
        run();
      });
      item.row = el("li", {}, el("span", { class: "upload-name" }, `${file.name} (${formatSize(file.size)})`), bar, el("span", {}, status, " ", retry));
      items.push(item);
      list.append(item.row);
      paint(item);
    }
    paintOverall();
    run();
  }

  input.addEventListener("change", () => {
    add([...input.files]);
    input.value = "";
  });
  return panel;
}
