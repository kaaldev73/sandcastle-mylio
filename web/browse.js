// Browsing a Library: Timeline drill-down, paged grid, Asset viewer and the
// place filter. Everything is read through the existing JSON API.
import { api, describeError } from "./api.js";
import { el } from "./dom.js";

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

function thumb(asset, onOpen) {
  const img = el("img", { src: asset.thumbnailUrl, alt: asset.filename, loading: "lazy" });
  return el("button", { class: "tile", "aria-label": "Open " + asset.filename, onclick: onOpen }, img);
}

/** Mount the browser for one Library into `host`; returns nothing. */
export function browse(host, library) {
  const filter = { mode: "all", place: "", radius: "" };
  // trail: [{label, level, key, from, to}] — the Timeline drill-down path.
  // gridSpan: the trail entry (or {} for everything) shown as a grid, else null.
  let trail = [];
  let gridSpan = null;
  let viewing = false;
  let token = 0;

  const status = el("p", { class: "msg", role: "status" });
  const crumbs = el("nav", { class: "crumbs", "aria-label": "Timeline" });
  const body = el("div", { class: "browse-body" });
  const overlay = el("div", { class: "viewer", hidden: "" });

  function fail(err) {
    status.className = "msg error";
    status.textContent = describeError(err);
  }
  function clear() {
    status.className = "msg";
    status.textContent = "";
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
          grid.append(thumb(a, () => open(a, span)));
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
      return fail(err);
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
    const bar = el("div", { class: "viewer-bar" }, prev, info, next, el("button", { onclick: close }, "Close"));
    overlay.replaceChildren(bar, el("div", { class: "viewer-stage" }, img));
    overlay.hidden = false;
  }

  function close() {
    viewing = false;
    overlay.hidden = true;
    overlay.replaceChildren();
  }
  const onKey = (e) => {
    if (!viewing || !host.isConnected) return;
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
