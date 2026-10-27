const $ = (id) => document.getElementById(id);
const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
  const r = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(
      data.error
        ? typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error)
        : r.statusText,
    );
  return data;
};
let threadId = null;

async function refresh() {
  let me;
  try {
    me = await api("/api/me");
  } catch {
    $("auth").classList.remove("hidden");
    $("app").classList.add("hidden");
    $("who").textContent = "";
    return;
  }
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("who").textContent = me.email;
  $("banks").innerHTML = me.banks.length
    ? me.banks
        .map(
          (b) =>
            `<div class="bank"><strong>${esc(b.institution || "Bank")}</strong><span class="pill">${esc(b.status)}</span>${b.accounts.map((a) => `<div class="small">${esc(a.name)} ••${esc(a.mask || "")}${a.mostlyBusiness ? '<span class="pill">business</span>' : ""}</div>`).join("")}</div>`,
        )
        .join("")
    : '<p class="muted small">No bank linked yet.</p>';
  $("gmail").innerHTML = me.gmail
    ? `<div class="small">${esc(me.gmail.email)}<span class="pill">read-only</span></div>`
    : '<p class="muted small">Not connected. Used only to find receipts and last year\'s 1040.</p>';
  $("estimates").innerHTML = me.estimates.length
    ? me.estimates
        .map(
          (e) =>
            `<div class="small">Q${e.quarter} ${e.taxYear}: $${Number(e.installmentDue).toLocaleString(undefined, { minimumFractionDigits: 2 })} due ${esc(e.dueDate)}<span class="pill">${esc(e.status)}</span></div>`,
        )
        .join("")
    : '<p class="muted small">No estimate yet. Ask in chat.</p>';
}
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || "login";
  const fd = new FormData(e.target);
  $("authError").textContent = "";
  try {
    await api(`/auth/${mode}`, { email: fd.get("email"), password: fd.get("password") });
    await refresh();
  } catch (err) {
    $("authError").textContent = err.message;
  }
});
$("logout").onclick = async () => {
  await api("/auth/logout", {});
  threadId = null;
  $("messages").innerHTML = "";
  refresh();
};

$("linkBank").onclick = async () => {
  try {
    const { linkToken } = await api("/api/plaid/link-token", {});
    if (!window.Plaid || linkToken.startsWith("link-fixture")) {
      await api("/api/plaid/exchange", { publicToken: "public-fixture" });
      return refresh();
    }
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken) => {
        await api("/api/plaid/exchange", { publicToken });
        refresh();
      },
    });
    handler.open();
  } catch (err) {
    alert(err.message);
  }
};
$("syncBank").onclick = async () => {
  try {
    await api("/api/plaid/sync", {});
    refresh();
  } catch (err) {
    alert(err.message);
  }
};
$("linkGmail").onclick = async () => {
  try {
    const { url, mode } = await api("/api/gmail/auth-url", {});
    if (mode !== "merge") {
      window.location.href = url;
      return;
    }
    // Merge's Magic Link ends on Merge's own page. It must load as a top-level tab (Merge sets a CSRF
    // cookie that browsers drop in popups/embedded frames), so show a real link the user clicks, and
    // watch for the connection from here.
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open Google sign-in (via Merge)";
    const box = $("gmail");
    box.innerHTML = "";
    box.appendChild(a);
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="small">Approve in the new tab, then come back here; this page updates on its own. If Merge shows a "CSRF" error, open the link in a normal browser tab (not an embedded preview).</div>`,
    );
    const started = Date.now();
    const poll = async () => {
      const st = await api("/api/gmail/status", {});
      if (st.connected) return refresh();
      if (Date.now() - started > 30 * 60_000) {
        $("gmail").innerHTML =
          `<div class="small">The link expired. Click Connect Gmail again.</div>`;
        return;
      }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  } catch (err) {
    alert(err.message);
  }
};

/** Minimal safe markdown: escape first, then **bold**, `code`, and "- " bullets. */
function renderMarkdown(text) {
  const lines = esc(text).split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    if (bullet) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    html += `${line}\n`;
  }
  if (inList) html += "</ul>";
  return html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n$/, "");
}

function setText(el, text) {
  el.innerHTML = renderMarkdown(text);
}

function addMsg(cls, text) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  setText(div, text);
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  addMsg("user", text);
  const ai = addMsg("ai", "…");
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: text, threadId: threadId || undefined }),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).error;
    ai.textContent = `Error: ${detail || `request failed (HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""})`}${
      r.status === 401 || r.status === 403 ? " — reload the page and sign in again" : ""
    }`;
    return;
  }
  threadId = r.headers.get("x-thread-id") || threadId;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let streamed = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const frame of frames) {
      const ev = Object.fromEntries(
        frame
          .split("\n")
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
      );
      if (!ev.data) continue;
      const payload = JSON.parse(ev.data);
      if (ev.event === "token") {
        streamed += payload.content || "";
        setText(ai, streamed);
      } else if (ev.event === "message") {
        setText(ai, payload.content || streamed || "(no reply)");
      } else if (ev.event === "interrupt") {
        addMsg("interrupt", `Needs your confirmation: ${JSON.stringify(payload.interrupt)}`);
      } else if (ev.event === "error") {
        ai.textContent = `Error: ${payload.error}`;
      } else if (ev.event === "done") {
        refresh();
      }
      $("messages").scrollTop = $("messages").scrollHeight;
    }
  }
});

refresh();
