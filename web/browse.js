// Browsing a Library: Timeline drill-down, paged grid, Asset viewer and the
// place filter. Everything is read through the existing JSON API.
import { api, describeError } from "./api.js";
import { el } from "./dom.js";
import { addToAlbumControls } from "./albums.js";

const LEVELS = ["decade", "year", "month", "day"];
const PAGE_SIZE = 60;

/** Query string for the place filter (empty when no filter is set). */
function placeQuery(filter) {
  const params = new URLSearchParams();
  if (filter.mode === "near" && filter.place) {
    params.set("place", filter.place);
    if (filter.radius) params.set("radiusKm", filter.radius);
  } else if (filter.mode === "with") {
    params.set("withLocation", "1");
  } else if (filter.mode === "without") {
    params.set("withoutLocation", "1");
  }
  return params;
}

function queryString(params) {
  const text = params.toString();
  return text ? "?" + text : "";
}

/** Rating badge text for a grid tile: pick flag and stars. */
function ratingBadge(asset) {
  return (asset.flag === "pick" ? "⚑ " : "") + (asset.stars ? "★".repeat(asset.stars) : "");
}

function thumb(asset, onOpen) {
  const img = el("img", { src: asset.thumbnailUrl, alt: asset.filename, loading: "lazy" });
  const tile = el("button", { class: "tile", "aria-label": "Open " + asset.filename, onclick: onOpen }, img);
  paintTile(tile, asset);
  return tile;
}

/** Show the Rating on a tile; Rejects are dimmed. */
function paintTile(tile, asset) {
  tile.classList.toggle("rejected", asset.flag === "reject");
  tile.querySelector(".badge")?.remove();
  const text = ratingBadge(asset);
  if (text) tile.append(el("span", { class: "badge" }, text));
}

/** `datetime-local` value (local time) for an ISO instant. */
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Mount the browser for one Library into `host`; returns nothing. */
export function browse(host, library) {
  const filter = { mode: "all", place: "", radius: "" };
  // trail: [{label, level, key, from, to}] — the Timeline drill-down path.
  // gridSpan: the trail entry (or {} for everything) shown as a grid, else null.
  let trail = [];
  let gridSpan = null;
  let viewing = false;
  let listChanged = false;
  const tiles = new Map();
  let token = 0;

  const status = el("p", { class: "msg", role: "status" });
  const crumbs = el("nav", { class: "crumbs", "aria-label": "Timeline" });
  const body = el("div", { class: "browse-body" });
  const overlay = el("div", { class: "viewer", hidden: "" });
  // The page status sits under the full-screen viewer, so the viewer has its own.
  const viewerStatus = el("p", { class: "msg", role: "status" });

  function fail(err) {
    for (const node of [status, viewerStatus]) {
      node.className = "msg error";
      node.textContent = describeError(err);
    }
  }
  function clear() {
    for (const node of [status, viewerStatus]) {
      node.className = "msg";
      node.textContent = "";
    }
  }

  // ---- place filter ----
  const mode = el(
    "select",
    { "aria-label": "Location" },
    el("option", { value: "all" }, "All photos"),
    el("option", { value: "near" }, "Near a place"),
    el("option", { value: "with" }, "With location"),
    el("option", { value: "without" }, "Without location"),
  );
  const place = el("input", { placeholder: "lat, lon (e.g. 48.85, 2.35)", "aria-label": "Place", hidden: "" });
  const radius = el("input", { type: "number", min: "1", placeholder: "km", "aria-label": "Radius in km", hidden: "" });
  const apply = () => {
    filter.mode = mode.value;
    filter.place = place.value.trim();
    filter.radius = radius.value.trim();
    place.hidden = radius.hidden = mode.value !== "near";
    if (mode.value === "near" && !filter.place) return;
    refresh();
  };
  mode.addEventListener("change", apply);
  place.addEventListener("change", apply);
  radius.addEventListener("change", apply);
  const filters = el("div", { class: "filters" }, mode, place, radius);

  // ---- views ----
  function drawCrumbs() {
    const items = [el("button", { class: "link", onclick: () => { trail = []; gridSpan = null; refresh(); } }, "Timeline")];
    trail.forEach((c, i) => {
      items.push(el("span", { class: "muted" }, " › "));
      items.push(el("button", { class: "link", onclick: () => { trail = trail.slice(0, i + 1); gridSpan = null; refresh(); } }, c.label));
    });
    items.push(el("span", { class: "muted" }, " · "));
    items.push(el("button", { class: "link", onclick: () => { gridSpan = trail.length ? trail[trail.length - 1] : {}; refresh(); } }, "Grid"));
    crumbs.replaceChildren(...items);
  }

  async function showTimeline() {
    const mine = ++token;
    const last = trail[trail.length - 1];
    const level = last ? LEVELS[LEVELS.indexOf(last.level) + 1] : "decade";
    if (!level) return showGrid(last);
    const params = placeQuery(filter);
    params.set("level", level);
    if (last) params.set("parent", last.key);
    let data;
    try {
      data = await api("GET", "/api/libraries/" + library.id + "/timeline" + queryString(params));
    } catch (err) {
      return fail(err);
    }
    if (mine !== token) return;
    clear();
    if (!data.periods.length) {
      body.replaceChildren(el("p", { class: "muted" }, "No photos here yet."));
      return;
    }
    const cards = data.periods.map((p) =>
      el(
        "button",
        {
          class: "period",
          onclick: () => {
            trail.push({ label: p.label, level, key: p.key, from: p.from, to: p.to });
            refresh();
          },
        },
        el("img", { src: p.cover.thumbnailUrl, alt: "", loading: "lazy" }),
        el("span", { class: "period-label" }, p.label),
        el("span", { class: "period-count muted" }, p.count + (p.count === 1 ? " photo" : " photos")),
      ),
    );
    body.replaceChildren(el("div", { class: "periods" }, ...cards));
  }

  async function showGrid(span) {
    const mine = ++token;
    const grid = el("div", { class: "grid" });
    tiles.clear();
    const more = el("button", { class: "primary", hidden: "" }, "Load more");
    const count = el("p", { class: "muted" });
    body.replaceChildren(count, grid, more);
    const base = placeQuery(filter);
    if (span?.from) {
      base.set("from", span.from);
      base.set("to", span.to);
    }
    let offset = 0;
    const load = async () => {
      const params = new URLSearchParams(base);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      more.disabled = true;
      try {
        const data = await api("GET", "/api/libraries/" + library.id + "/assets" + queryString(params));
        if (mine !== token) return;
        clear();
        for (const a of data.assets) {
          const tile = thumb(a, () => open(a, span));
          tiles.set(a.id, tile);
          grid.append(tile);
        }
        count.textContent = data.total + (data.total === 1 ? " photo" : " photos");
        offset = data.nextOffset ?? offset;
        more.hidden = !data.hasMore;
      } catch (err) {
        fail(err);
      } finally {
        more.disabled = false;
      }
    };
    more.addEventListener("click", load);
    await load();
  }

  // ---- viewer ----
  async function open(asset, span) {
    viewing = true;
    await showAsset(asset.id, span);
  }

  async function showAsset(id, span) {
    const params = placeQuery(filter);
    if (span?.from) {
      params.set("from", span.from);
      params.set("to", span.to);
    }
    let data;
    try {
      data = await api("GET", "/api/assets/" + id + "/neighbors" + queryString(params));
    } catch (err) {
      fail(err);
      return false;
    }
    const a = data.asset;
    const img = el("img", { src: a.originalUrl, alt: a.filename });
    // Originals a browser cannot decode (e.g. RAW) fall back to the thumbnail.
    img.addEventListener("error", () => { if (img.src.indexOf("thumbnail") < 0) img.src = a.thumbnailUrl; }, { once: true });
    const prev = el("button", { "aria-label": "Previous", onclick: () => showAsset(data.previous.id, span) }, "‹ Prev");
    const next = el("button", { "aria-label": "Next", onclick: () => showAsset(data.next.id, span) }, "Next ›");
    prev.disabled = !data.previous;
    next.disabled = !data.next;
    const info = el(
      "span",
      { class: "muted" },
      a.filename + (data.position ? " · " + data.position + " of " + data.total : ""),
    );
    const del = el("button", { class: "danger", onclick: () => deleteAsset(a, data, span) }, "Delete");
    const bar = el("div", { class: "viewer-bar" }, prev, info, next, del, el("button", { onclick: close }, "Close"));
    overlay.replaceChildren(
      bar,
      el("div", { class: "viewer-stage" }, img),
      ratingControls(a),
      ...(library.kind === "private" ? [shareControls(a, data, span)] : []),
      viewerStatus,
    );
    overlay.hidden = false;
    return true;
  }

  /** Move the open Asset to Trash, then carry on with a neighbour. */
  async function deleteAsset(a, data, span) {
    if (!confirm("Delete " + a.filename + "? It moves to Trash, where you can restore it.")) return;
    try {
      await api("DELETE", "/api/assets/" + a.id, { confirm: true });
    } catch (err) {
      return fail(err);
    }
    clear();
    await leaveViewer(data, span);
  }

  /** The open Asset left this view (deleted or moved): carry on with a neighbour. */
  async function leaveViewer(data, span) {
    listChanged = true;
    const neighbour = data.next || data.previous;
    if (!neighbour) return close();
    if (!(await showAsset(neighbour.id, span))) {
      // The Asset is gone, so don't leave it on screen with live controls.
      overlay.replaceChildren(
        el("div", { class: "viewer-bar" }, el("button", { onclick: close }, "Close")),
        viewerStatus,
      );
    }
  }

  /** Share the open Asset from the private Library to the Family Library. */
  function shareControls(a, data, span) {
    const panel = el("div", { class: "share-panel", hidden: "" });
    const share = async (mode) => {
      try {
        await api("POST", "/api/assets/" + a.id + "/share", { mode });
      } catch (err) {
        // "forbidden" is worded for Admin-only actions elsewhere; sharing has its own reason.
        if (err.code !== "forbidden") return fail(err);
        viewerStatus.className = "msg error";
        viewerStatus.textContent = "Only the photo's owner can share it.";
        return;
      }
      clear();
      if (mode === "move") await leaveViewer(data, span);
      viewerStatus.className = "msg ok";
      viewerStatus.textContent = mode === "move"
        ? "Moved to the Family Library."
        : "Copied to the Family Library.";
      panel.hidden = true;
    };
    panel.append(
      el("button", { onclick: () => share("move") }, "Move"),
      el("span", { class: "muted" }, "Takes it out of your private Library."),
      el("button", { onclick: () => share("copy") }, "Copy"),
      el("span", { class: "muted" }, "Leaves the original in your private Library."),
    );
    const toggle = el("button", { onclick: () => { panel.hidden = !panel.hidden; } }, "Share to Family");
    return el("div", { class: "share-bar" }, toggle, panel);
  }

  /** Pick/Reject, stars and capture-date correction for the open Asset. */
  function ratingControls(a) {
    const bar = el("div", { class: "rating-bar" });
    const save = async (path, body) => {
      try {
        const updated = await api("PATCH", "/api/assets/" + a.id + path, body);
        clear();
        a = updated;
        const tile = tiles.get(a.id);
        if (tile) paintTile(tile, a);
        draw();
        return updated;
      } catch (err) {
        fail(err);
      }
    };
    const flagButton = (label, flag) =>
      el("button", {
        class: a.flag === flag ? "on" : "",
        "aria-pressed": String(a.flag === flag),
        onclick: () => save("/flag", { flag: a.flag === flag ? "unflagged" : flag }),
      }, label);
    const star = (n) =>
      el("button", {
        class: "star" + (n <= a.stars ? " on" : ""),
        "aria-label": n + (n === 1 ? " star" : " stars"),
        "aria-pressed": String(n === a.stars),
        onclick: () => save("/stars", { stars: n === a.stars ? 0 : n }),
      }, "★");
    function draw() {
      const date = el("input", { type: "datetime-local", "aria-label": "Capture date", value: toLocalInput(a.captureDate) });
      const setDate = el("button", {
        onclick: async () => {
          if (!date.value) return;
          const before = a.captureDate;
          const updated = await save("/date", { date: new Date(date.value).toISOString() });
          if (updated && updated.captureDate !== before) listChanged = true;
        },
      }, "Set date");
      bar.replaceChildren(
        flagButton("Pick", "pick"),
        flagButton("Reject", "reject"),
        el("span", { class: "stars" }, ...[1, 2, 3, 4, 5].map(star)),
        date,
        setDate,
        addToAlbumControls(library, a.id, (text, isError) => {
          status.className = isError ? "msg error" : "msg";
          status.textContent = text;
        }),
      );
    }
    draw();
    return bar;
  }

  function close() {
    viewing = false;
    if (listChanged) {
      // A corrected date or a deletion changes what the Timeline and grid show.
      listChanged = false;
      refresh();
    }
    overlay.hidden = true;
    overlay.replaceChildren();
  }
  const onKey = (e) => {
    if (!viewing || !host.isConnected || e.target.tagName === "INPUT") return;
    const buttons = overlay.querySelectorAll(".viewer-bar button");
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && !buttons[0].disabled) buttons[0].click();
    else if (e.key === "ArrowRight" && !buttons[2].disabled) buttons[2].click();
  };
  document.addEventListener("keydown", onKey);

  function refresh() {
    drawCrumbs();
    return gridSpan ? showGrid(gridSpan.from ? gridSpan : null) : showTimeline();
  }

  host.replaceChildren(filters, crumbs, status, body, overlay);
  return refresh();
}
