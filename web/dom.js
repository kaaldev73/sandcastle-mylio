// Tiny DOM builder shared by the screens.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/** Write a status line: `kind` is "error", "ok" or empty (plain). */
export function setStatus(node, text = "", kind = "") {
  node.className = kind ? `msg ${kind}` : "msg";
  node.textContent = text;
}
