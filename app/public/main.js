// main.js — carpetas | pestañas (Bandeja + un correo por pestaña). Todo texto externo se inserta con textContent.
const $ = (s) => document.querySelector(s);
const state = { safe: new Set(), tab: 0, role: "inbox", account: 0, q: "", sel: 0, selThread: "", selAccount: 0, folder: 0, rows: [], selected: new Map(), anchor: -1, accounts: [], folders: [] };
const ROLES = [["inbox", "Entrada"], ["sent", "Enviados"], ["drafts", "Borradores"], ["archive", "Archivo"], ["junk", "Spam"], ["trash", "Papelera"]];
const ROLE_NAME = Object.fromEntries(ROLES);

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(r.status);
  return r.status === 204 ? null : r.json();
};
const post = (url, data = {}) => api(url, { method: "POST", body: new URLSearchParams(data) });
const el = (tag, attrs = {}, text = "") => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "style" ? e.style.cssText = v : e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};
const fmtDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts * 1000), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};

function renderNav() {
  const nav = $("#nav");
  nav.replaceChildren();
  const unseen = (acc, role) => state.folders.filter((f) => f.role === role && (!acc || f.account_id === acc)).reduce((n, f) => n + f.unseen, 0);
  // role: carpeta con rol (Entrada, Archivo...); folder: carpeta propia del servidor, por id.
  const link = (label, acc, role, folder = null) => {
    const n = folder ? folder.unseen : unseen(acc, role);
    const here = state.account === acc && (folder ? state.folder === folder.id : !state.folder && state.role === role);
    const a = el("a", { class: here ? "on" : "" });
    a.append(el("span", { class: "name" }, label));
    if (folder) {
      const edit = el("button", { class: "edit", title: "Renombrar o eliminar" }, "✎");
      edit.onclick = (e) => { e.stopPropagation(); openFolderDialog(acc, folder); };
      a.append(edit);
    }
    a.append(el("span", { class: "n" }, n ? String(n) : ""));
    a.onclick = () => { state.account = acc; state.role = folder ? "" : role; state.folder = folder ? folder.id : 0; renderNav(); showInbox(); };
    return a;
  };
  const hasRole = (role, acc) => state.folders.some((f) => f.role === role && (!acc || f.account_id === acc));
  // Entrada, Enviados, Borradores y Papelera siempre; Archivo y Spam solo si el servidor los tiene.
  const shown = (role, acc) => ["inbox", "sent", "drafts", "trash"].includes(role) || hasRole(role, acc);

  const all = el("h3", {}, "Todas las cuentas");
  all.prepend(el("span", { class: "dot", style: "background:var(--accent)" }));
  nav.append(all);
  ROLES.filter(([role]) => shown(role, 0)).forEach(([role, label]) => nav.append(link(label, 0, role)));
  state.accounts.forEach((acc) => {
    const h = el("h3", {}, acc.name);
    h.prepend(el("span", { class: "dot", style: `background:${acc.color}` }));
    const add = el("button", { class: "add", title: "Nueva carpeta" }, "＋");
    add.onclick = () => openFolderDialog(acc.id, null);
    const gear = el("button", { class: "gear", title: "Ajustes de la cuenta" }, "⚙");
    gear.onclick = () => openSettings(acc);
    h.append(add, gear);
    nav.append(h);
    ROLES.filter(([role]) => shown(role, acc.id)).forEach(([role, label]) => nav.append(link(label, acc.id, role)));
    state.folders.filter((f) => f.account_id === acc.id && !f.role).sort((a, b) => a.path.localeCompare(b.path))
      .forEach((f) => nav.append(link(f.path, acc.id, "", f)));
  });
}

// ---- selección múltiple -------------------------------------------------------------------
function togglePick(m, idx) {
  if (state.selected.has(m.id)) state.selected.delete(m.id); else state.selected.set(m.id, m);
  state.anchor = idx;
  syncSelectionUI();
}
function pickRange(idx) {
  const [a, b] = [Math.min(state.anchor, idx), Math.max(state.anchor, idx)];
  state.rows.slice(a, b + 1).forEach((m) => state.selected.set(m.id, m));
  syncSelectionUI();
}
function clearSelection() { state.selected.clear(); state.anchor = -1; syncSelectionUI(); }

// Marca las filas y pone en el lector el panel de acciones; sin selección, deja el lector como estaba.
let wasSelecting = false;
function syncSelectionUI() {
  const n = state.selected.size;
  $("#app").classList.toggle("selecting", n > 0);
  document.querySelectorAll("#messages li[data-id]").forEach((li) => {
    const picked = state.selected.has(Number(li.dataset.id));
    li.classList.toggle("picked", picked);
    li.querySelector(".pick").checked = picked;
  });
  if (n > 0) { wasSelecting = true; renderSelectionPanel(); }
  else if (wasSelecting) { wasSelecting = false; closeReader(); }
}

async function bulk(path, data) {
  const ids = [...state.selected.keys()].join("\n");
  try {
    const res = await post(path, { ids, ...data });
    if (res && res.failed) toast(`${res.failed} no se pudieron mover${res.error === "409" ? " (la cuenta no tiene esa carpeta)" : ""}.`);
  } catch { toast("No se pudo completar la acción. Revisa la conexión."); }
  clearSelection();
  await refreshAll();
  sync();
}

function renderSelectionPanel() {
  const r = $("#reader");
  const rows = [...state.selected.values()];
  const box = el("div", { class: "selection" });
  box.append(el("h2", {}, `${rows.length} ${rows.length === 1 ? "conversación seleccionada" : "conversaciones seleccionadas"}`));
  const actions = el("div", { class: "actions" });
  const button = (label, fn, cls = "") => { const b = el("button", cls ? { class: cls } : {}, label); b.onclick = () => fn(b); actions.append(b); return b; };
  const role = state.folder ? "" : state.role;
  if (role !== "archive" && role !== "trash" && role !== "drafts") button("Archivar", () => bulk("/api/messages/move", { to: "archive" }));
  if (role === "junk") button("No es spam", () => bulk("/api/messages/move", { to: "inbox" }));
  else if (role !== "trash" && role !== "drafts") button("Spam", () => bulk("/api/messages/move", { to: "junk" }));
  const mine = new Set(rows.map((m) => m.account_id));
  if (mine.size === 1) button("Mover a…", () => openMovePicker([...mine][0], rows.map((m) => m.folder_id), (fid) => bulk("/api/messages/move", { to: "folder", folder_id: fid })));
  button("Marcar leídas", () => bulk("/api/messages/seen", { seen: 1 }));
  button("Marcar no leídas", () => bulk("/api/messages/seen", { seen: 0 }));
  button(role === "trash" ? "Eliminar definitivamente" : "Eliminar", (b) => {
    if (role !== "trash") return bulk("/api/messages/move", { to: "trash" });
    if (b.dataset.sure !== "1") {   // definitivo: segunda pulsación
      b.dataset.sure = "1"; b.textContent = "¿Seguro? Pulsa otra vez";
      setTimeout(() => { b.dataset.sure = ""; b.textContent = "Eliminar definitivamente"; }, 3000);
      return;
    }
    bulk("/api/messages/move", { to: "delete" });
  });
  box.append(actions);
  const more = el("div", { class: "actions" });
  const all = el("button", {}, "Seleccionar todas las visibles");
  all.onclick = () => { state.rows.forEach((m) => state.selected.set(m.id, m)); syncSelectionUI(); };
  const none = el("button", {}, "Cancelar selección");
  none.onclick = clearSelection;
  more.append(all, none);
  box.append(more, el("p", { class: "hint" }, "Ctrl+clic añade o quita · Mayús+clic selecciona un rango · Esc cancela"));
  r.replaceChildren(box);
}

async function loadList() {
  const rows = await api(`/api/messages?${new URLSearchParams({ role: state.role, folder: state.folder, account: state.account, q: state.q })}`);
  const ul = $("#messages");
  ul.replaceChildren();
  state.rows = rows;
  for (const id of [...state.selected.keys()]) if (!rows.some((r) => r.id === id)) state.selected.delete(id);   // ya no están en la lista
  rows.forEach((m, idx) => {
    const on = m.id === state.sel || (m.thread_id === state.selThread && m.account_id === state.selAccount);
    const li = el("li", { style: `--c:${m.color}`, "data-id": m.id, class: (m.thread_unseen > 0 ? "unseen " : "") + (on ? "on " : "") + (state.selected.has(m.id) ? "picked" : "") });
    const outgoing = state.role === "sent" || state.role === "drafts";   // ahí interesa el destinatario
    const who = outgoing ? (m.to_text ? "Para: " + m.to_text : "(sin destinatario)") : m.from_name || m.from_email;
    const pick = el("input", { type: "checkbox", class: "pick", title: "Seleccionar" });
    pick.checked = state.selected.has(m.id);
    pick.onclick = (e) => { e.stopPropagation(); togglePick(m, idx); };
    const r1 = el("div", { class: "row" });
    const right = el("span", { class: "right" });
    if (m.thread_count > 1) right.append(el("span", { class: "count", title: `${m.thread_count} mensajes en la conversación` }, String(m.thread_count)));
    right.append(el("span", { class: "date" }, fmtDate(m.date)));
    r1.append(pick, el("span", { class: "from" }, who), right);
    li.append(r1, el("div", { class: "subj" }, m.subject || "(sin asunto)"), el("div", { class: "snip" }, (m.has_att ? "📎 " : "") + m.snippet));
    li.oncontextmenu = (e) => showCtx(e, [["Abrir en pestaña", () => openMessage(m.id)], safeItem(m.from_email)]);
    li.onclick = (e) => {
      if (e.shiftKey && state.anchor >= 0) pickRange(idx);
      else if (e.ctrlKey || e.metaKey || state.selected.size) togglePick(m, idx);   // con una selección en curso, un clic añade o quita
      else openMessage(m.id);
    };
    ul.append(li);
  });
  syncSelectionUI();
  ul.querySelector("li.on")?.scrollIntoView({ block: "nearest" });
  if (!rows.length) ul.append(el("li", { class: "none" }, "Sin mensajes"));
}

// El HTML del correo va en un iframe sin scripts ni acceso al origen, con CSP que solo deja
// cargar imágenes (también remotas); nada más sale del iframe.
// Antes se quitan las imágenes que declaran menos de 10 px o están ocultas: son los píxeles de seguimiento
// (salvo en los dominios que el usuario marcó como seguros).
// ponytail: solo se ve lo declarado; un píxel sin tamaño en el HTML (o un fondo CSS) sí se carga.
const tinyImg = (img) => {
  const st = img.getAttribute("style") || "";
  const dim = (k) => { const v = img.getAttribute(k) ?? st.match(new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([\\d.]+)(?:px)?\\s*(?:;|$)`, "i"))?.[1]; return v == null ? NaN : parseFloat(v); };
  return dim("width") < 10 || dim("height") < 10 || /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i.test(st);
};
function htmlDoc(html, safe) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:";
  const doc = new DOMParser().parseFromString(html, "text/html");   // inerte: no carga nada ni ejecuta scripts
  if (!safe) doc.querySelectorAll("img").forEach((i) => tinyImg(i) && i.remove());
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><body style="font:14px system-ui;margin:16px">${doc.head.innerHTML}${doc.body.innerHTML}`;
}

// Conversación del mensaje abierto: todos sus mensajes (también los enviados desde otra carpeta).
const ROLE_LABEL = { sent: "Enviado", drafts: "Borrador", trash: "Papelera", archive: "Archivo", junk: "Spam" };
function threadList(thread, currentId) {
  const box = el("details", { class: "thread" });
  box.append(el("summary", {}, `Conversación · ${thread.length} mensajes`));
  const ul = el("ul");
  thread.forEach((t) => {
    const li = el("li", { class: (t.id === currentId ? "on " : "") + (t.seen ? "" : "unseen") });
    const label = ROLE_LABEL[t.role] ? ` · ${ROLE_LABEL[t.role]}` : "";
    li.append(el("span", { class: "who" }, t.from_name || t.from_email), el("span", { class: "when" }, `${new Date(t.date * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${label}`));
    if (t.id !== currentId) li.onclick = () => openMessage(t.id);
    ul.append(li);
  });
  box.append(ul);
  return box;
}

// ---- mover a una carpeta cualquiera de la cuenta ----------------------------------------------
function openMovePicker(accountId, excludeFolderIds, onPick) {
  const list = $("#move-list");
  list.replaceChildren();
  const mine = state.folders.filter((f) => f.account_id === accountId && !excludeFolderIds.includes(f.id));
  const item = (label, f) => { const li = el("li", {}, label); li.onclick = () => { $("#move-dialog").close(); onPick(f.id); }; list.append(li); };
  ROLES.forEach(([role, label]) => mine.filter((f) => f.role === role).forEach((f) => item(label, f)));
  const custom = mine.filter((f) => !f.role).sort((a, b) => a.path.localeCompare(b.path));
  if (custom.length) list.append(el("li", { class: "sep" }, "Otras carpetas"));
  custom.forEach((f) => item(f.path, f));
  $("#move-dialog").showModal();
}
$("#move-cancel").onclick = () => $("#move-dialog").close();

// ---- acciones sobre el mensaje abierto --------------------------------------------------
const NO_FOLDER = { 409: "Esta cuenta no tiene esa carpeta en el servidor." };
// ---- menú contextual (clic derecho) ----------------------------------------------------------
const domainOf = (email) => (email || "").split("@")[1]?.trim().toLowerCase() || "";
const ctx = el("ul", { id: "ctx", hidden: "" });
document.body.append(ctx);
const hideCtx = () => { ctx.hidden = true; };
function showCtx(e, items) {
  items = items.filter(Boolean);
  if (!items.length) return;
  e.preventDefault();
  ctx.replaceChildren(...items.map(([label, fn]) => { const li = el("li", {}, label); li.onclick = () => { hideCtx(); fn(); }; return li; }));
  ctx.hidden = false;
  ctx.style.left = Math.min(e.clientX, innerWidth - ctx.offsetWidth - 4) + "px";
  ctx.style.top = Math.min(e.clientY, innerHeight - ctx.offsetHeight - 4) + "px";
}
document.addEventListener("click", hideCtx);
window.addEventListener("blur", hideCtx);
async function setSafe(domain, safe) {
  try { await post("/api/safe-domain", { domain, safe: safe ? 1 : 0 }); } catch { toast("No se pudo guardar el dominio."); return; }
  safe ? state.safe.add(domain) : state.safe.delete(domain);
  toast(safe ? `${domain}: sus imágenes se cargan siempre.` : `${domain}: vuelve a filtrar píxeles de seguimiento.`);
  if (state.tab && domainOf(state.current?.from_email) === domain) openMessage(state.tab);   // repinta con el nuevo ajuste
}
const safeItem = (email) => {
  const d = domainOf(email);
  if (!d) return null;
  return state.safe.has(d) ? [`Quitar ${d} de dominios seguros`, () => setSafe(d, false)] : [`Marcar ${d} como seguro para imágenes`, () => setSafe(d, true)];
};

// ---- pestañas: la bandeja (state.tab = 0) y un correo abierto por pestaña (state.tab = id) ---------
const tabs = [];   // { id, title, color }
function renderTabs() {
  const bar = $("#tabs");
  const inbox = el("div", { class: "tab" + (state.tab ? "" : " on") }, "Bandeja");
  inbox.onclick = showInbox;
  bar.replaceChildren(inbox);
  tabs.forEach((t) => {
    const d = el("div", { class: "tab" + (state.tab === t.id ? " on" : ""), style: `--c:${t.color || "transparent"}`, title: t.title });
    const x = el("button", { class: "x", title: "Cerrar pestaña (w)" }, "×");
    x.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
    d.append(el("span", { class: "t" }, t.title), x);
    d.onclick = () => state.tab !== t.id && openMessage(t.id);
    d.onauxclick = (e) => { if (e.button === 1) closeTab(t.id); };
    bar.append(d);
  });
}
function showInbox() {
  state.tab = 0; state.current = null;
  $("#app").classList.remove("reading");
  renderTabs();
  return loadList();
}
function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (state.tab !== id) return renderTabs();
  const next = tabs[i] || tabs[i - 1];
  next ? openMessage(next.id) : showInbox();
}
function stepTab(delta) {
  const ids = [0, ...tabs.map((t) => t.id)];
  const n = ids[(ids.indexOf(state.tab) + delta + ids.length) % ids.length];
  n ? openMessage(n) : showInbox();
}
// Tras mover/eliminar/etc.: cierra la pestaña del correo abierto (o, en la bandeja, solo limpia la selección).
function closeReader() {
  if (state.tab) return closeTab(state.tab);
  state.sel = 0; state.selThread = ""; state.selAccount = 0; state.current = null;
  $("#reader").replaceChildren(el("p", { class: "empty" }, "Selecciona un mensaje"));
}
async function moveMessage(m, to, extra = {}) {
  try { await post(`/api/message/${m.id}/move`, { to, scope: "thread", ...extra }); }
  catch (e) { toast(NO_FOLDER[e.message] || "No se pudo completar la acción. Revisa la conexión."); return; }
  closeReader();
  await refreshAll();
  sync();   // lo movido aparece en su nueva carpeta
}
let confirmTimer;
function deleteMessage(m, btn) {
  if (m.role !== "trash") return moveMessage(m, "trash");   // recuperable: sin confirmación
  if (btn && btn.dataset.sure !== "1") {                    // definitivo: segunda pulsación para confirmar
    btn.dataset.sure = "1"; btn.textContent = "¿Seguro? Pulsa otra vez";
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { btn.dataset.sure = ""; btn.textContent = "Eliminar definitivamente"; }, 3000);
    return;
  }
  return moveMessage(m, "delete");
}
async function markUnread(m) {
  try { await post(`/api/message/${m.id}/unseen`); } catch { toast("No se pudo marcar como no leído."); return; }
  closeReader();
  refreshAll();
}

async function openMessage(id) {
  if (state.selected.size) { state.selected.clear(); state.anchor = -1; wasSelecting = false; $("#app").classList.remove("selecting"); }
  let tab = tabs.find((t) => t.id === id);
  if (!tab) tabs.push(tab = { id, title: "…" });
  state.sel = id; state.tab = id;
  $("#app").classList.add("reading");
  renderTabs();
  let m;
  try { m = await api(`/api/message/${id}`); }
  catch { closeTab(id); toast("No se pudo abrir el mensaje."); return; }
  tab.title = m.subject || "(sin asunto)"; tab.color = m.color;
  renderTabs();
  if (state.tab !== id) return;   // mientras cargaba se cambió de pestaña
  state.current = m;
  state.selThread = m.thread_id;
  state.selAccount = m.account_id;
  const thread = await api(`/api/thread/${id}`).catch(() => []);
  if (state.tab !== id) return;
  const r = $("#reader");
  r.replaceChildren();
  const head = el("header", { style: `--c:${m.color}` });
  const acc = el("span", { class: "tag", style: `--c:${m.color}` }, m.account_email);
  head.append(el("h1", {}, m.subject || "(sin asunto)"),
    el("div", { class: "meta" }, `De: ${m.from.replace(/"/g, "")}`), el("div", { class: "meta" }, `Para: ${m.to}${m.cc ? "  Cc: " + m.cc : ""}`),
    el("div", { class: "meta" }, (m.date ? new Date(m.date * 1000).toLocaleString() : "") + "  "));
  head.lastChild.append(acc);
  head.oncontextmenu = (e) => showCtx(e, [safeItem(m.from_email)]);
  const shown = m.attachments.filter((a) => !(a.cid && (m.html_cid || "").includes("cid:" + a.cid)));   // las imágenes del cuerpo no son "adjuntos"
  if (shown.length) head.append(el("div", { class: "att" }, "📎 " + shown.map((a) => `${a.name} (${Math.ceil(a.size / 1024)} KB)`).join(", ")));
  const actions = el("div", { class: "actions" });
  const button = (label, fn, cls = "", act = "") => { const b = el("button", { ...(cls && { class: cls }), ...(act && { "data-act": act }) }, label); b.onclick = () => fn(b); actions.append(b); };
  if (m.role === "drafts") {
    button("Editar borrador", () => editDraft(m), "primary");
  } else {
    button("Responder", () => composeFrom(m, "reply"));
    button("Responder a todos", () => composeFrom(m, "all"));
    button("Reenviar", () => composeFrom(m, "forward"));
  }
  if (m.role !== "archive" && m.role !== "drafts" && m.role !== "trash") button("Archivar", () => moveMessage(m, "archive"));
  if (m.role === "junk") button("No es spam", () => moveMessage(m, "inbox"));
  else if (m.role !== "drafts" && m.role !== "trash") button("Spam", () => moveMessage(m, "junk"));
  button("Mover a…", () => openMovePicker(m.account_id, [m.folder_id], (fid) => moveMessage(m, "folder", { folder_id: fid })));
  button(m.role === "trash" ? "Eliminar definitivamente" : "Eliminar", (b) => deleteMessage(m, b), "", "delete");
  if (m.role !== "drafts") button("No leído", () => markUnread(m));
  head.append(actions);
  r.append(head);
  if (thread.length > 1) r.append(threadList(thread, id));
  if (m.html) {
    const frame = el("iframe", { sandbox: "" });
    frame.srcdoc = htmlDoc(m.html, state.safe.has(domainOf(m.from_email)));
    r.append(frame);
  } else {
    r.append(el("pre", {}, m.text));
  }
  post(`/api/message/${id}/seen`).then(refreshFolders);
  loadList();
}

const refreshFolders = async () => { state.folders = await api("/api/folders"); renderNav(); };
async function refreshAll() {
  state.accounts = await api("/api/accounts");
  await refreshFolders();
  await loadList();
}

let syncing = false;
async function sync() {
  if (syncing) return;
  if (!state.accounts.length) { await refreshAll(); if (!state.accounts.length) return; }
  syncing = true;
  $("#sync").disabled = true;
  try { await post("/api/sync"); } catch (e) { console.error("sync", e); }
  syncing = false;
  $("#sync").disabled = false;
  refreshAll();
}

// ---- redactar ------------------------------------------------------------------------
// "Nombre <a@x>, b@y" -> ["Nombre <a@x>", "b@y"] (la coma dentro de comillas no separa).
const splitAddrs = (s) => (s || "").match(/(?:[^,"]|"[^"]*")+/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
const emailOf = (a) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase();
const ownEmails = () => new Set(state.accounts.map((a) => a.email.toLowerCase()));
const plainText = (m) => m.text || (m.html ? new DOMParser().parseFromString(m.html, "text/html").body.textContent : "");

function setComposeAccount(id) {
  const acc = state.accounts.find((a) => a.id === Number(id));
  if (!acc) return;
  $("#compose-from").value = String(acc.id);
  $("#compose-dialog").style.setProperty("--c", acc.color);
  const orig = $("#compose-form").dataset.origAccount;
  $("#compose-note").textContent = orig && Number(orig) !== acc.id
    ? `Respondes desde ${acc.email}, que no es la cuenta que recibió el mensaje.` : "";
}

let autosaveFailed = false;  // un segundo fallo seguido deja cerrar: no se atrapa al usuario
let composeDone = false;     // enviado o descartado a propósito: al cerrar no se autoguarda
let composeSnapshot = "";    // contenido en el último guardado: distingue "cambiado" de "tal cual"
const fields = () => {
  const f = $("#compose-form"), lines = (v) => splitAddrs(v).join("\n");
  return { account: f.account.value, to: lines(f.to.value), cc: lines(f.cc.value), bcc: lines(f.bcc.value), subject: f.subject.value,
    body: rich ? editorText() : f.body.value, html: rich ? cleanHtml($("#compose-rich").innerHTML) : "", inline: rich ? inlineIds.join("\n") : "", in_reply_to: f.dataset.inReplyTo || "", references: f.dataset.references || "", attachments: attachments.map((a) => a.id).join("\n") };
};
const snapshot = () => JSON.stringify(fields());
const hasContent = () => { const v = fields(); return Boolean(v.to || v.cc || v.bcc || v.subject.trim() || v.body.trim() || v.attachments); };

// ---- texto enriquecido -------------------------------------------------------------------
// Etiquetas permitidas al enviar; cualquier otra se "desenvuelve" (se conserva su contenido), y de los atributos solo
// sobrevive href en los enlaces http(s) y mailto. Así nada pegado o arrastrado (scripts, estilos, imágenes) sale en el correo.
let rich = false;
const ALLOWED = new Set(["A", "B", "STRONG", "I", "EM", "U", "S", "BR", "P", "DIV", "SPAN", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "H1", "H2", "H3"]);
const DROPPED = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON", "SVG", "VIDEO", "AUDIO"]);
let inlineIds = [];   // imágenes subidas que quedan en el mensaje (se envían como cid:<id>)
const safeUrl = (u) => /^(https?:\/\/|mailto:)/i.test(u.trim());
let forEditor = false;   // true: para mostrar en el editor (las imágenes conservan su ruta local); false: para enviar (cid:)
function cleanNode(node, out) {
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) { out.append(document.createTextNode(n.textContent)); return; }
    if (n.nodeType !== Node.ELEMENT_NODE || DROPPED.has(n.tagName.toUpperCase())) return;
    if (n.tagName === "IMG") {   // solo imágenes que subió esta app (data-upload = id de 16 hex); nada remoto ni data:
      const id = n.getAttribute("data-upload") || "";
      if (/^[0-9a-f]{16}$/.test(id)) {
        const img = document.createElement("img");
        const local = n.getAttribute("src") || "";
        if (forEditor && local.startsWith(`/outbox/${id}/`)) { img.setAttribute("src", local); img.setAttribute("data-upload", id); }
        else img.setAttribute("src", "cid:" + id);
        img.setAttribute("alt", (n.getAttribute("alt") || "").slice(0, 100));
        if (!forEditor) img.setAttribute("style", "max-width:100%");
        out.append(img);
        if (!inlineIds.includes(id)) inlineIds.push(id);
      }
      return;
    }
    if (!ALLOWED.has(n.tagName)) { cleanNode(n, out); return; }
    const copy = document.createElement(n.tagName.toLowerCase());
    if (n.tagName === "A" && n.getAttribute("href") && safeUrl(n.getAttribute("href"))) {
      copy.setAttribute("href", n.getAttribute("href").trim());
      copy.setAttribute("rel", "noopener noreferrer");
    }
    cleanNode(n, copy);
    out.append(copy);
  });
}
function cleanHtml(html, editor = false) {
  inlineIds = [];
  forEditor = editor;
  const doc = new DOMParser().parseFromString(html, "text/html"), out = document.createElement("div");
  cleanNode(doc.body, out);
  return out.innerHTML.trim();
}
const escapeAttr = (t) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escapeHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
const editorText = () => $("#compose-rich").innerText.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// on = enriquecido (con `content` HTML ya limpio, o el texto actual convertido); off = texto plano.
function setMode(on, content = null) {
  const f = $("#compose-form"), ed = $("#compose-rich");
  if (on && !rich) ed.innerHTML = content ?? escapeHtml(f.body.value);
  else if (on) ed.innerHTML = content ?? ed.innerHTML;
  else if (rich) f.body.value = editorText();
  rich = on;
  f.body.hidden = on;
  ed.hidden = !on;
  $("#rich-toolbar").hidden = !on;
  $("#link-row").hidden = true;
  $("#compose-mode").textContent = on ? "Aa Texto plano" : "Aa Enriquecido";
}

let toastTimer;
function toast(msg, ms = 6000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const HINT = "Ctrl+1…9 cuenta · Ctrl+S guarda · Ctrl+Intro envía";
function flashHint(msg) {
  $("#compose-hint").textContent = msg;
  setTimeout(() => { $("#compose-hint").textContent = HINT; }, 3000);
}

// Guarda (o reemplaza) el borrador en el servidor; el Message-ID de la última versión se recuerda
// para retirarla en el siguiente guardado, al enviar o al descartar.
async function saveDraft() {
  const f = $("#compose-form");
  const res = await post("/api/draft", { ...fields(), replaces: f.dataset.draftId || "" });
  f.dataset.draftId = res.message_id;
  composeSnapshot = snapshot();
  return res;
}

function openCompose({ account, to = [], cc = [], bcc = [], subject = "", body = "", html = "", inReplyTo = "", references = "", origAccount = "", draftId = "", note = "" }) {
  if (!state.accounts.length) { $("#account-dialog").showModal(); return; }
  const f = $("#compose-form");
  f.reset();
  f.dataset.origAccount = origAccount;
  f.dataset.inReplyTo = inReplyTo;
  f.dataset.references = references;
  f.dataset.draftId = draftId;
  $("#compose-from").replaceChildren(...state.accounts.map((a) => el("option", { value: a.id }, `${a.name} <${a.email}>`)));
  f.to.value = to.join(", ");
  f.cc.value = cc.join(", ");
  f.bcc.value = bcc.join(", ");
  f.subject.value = subject;
  f.body.value = body;
  rich = false;
  setMode(Boolean(html), html ? cleanHtml(html, true) : null);
  $("#compose-error").textContent = "";
  attachments = [];
  renderFiles();
  setComposeAccount(account || state.account || state.accounts[0].id);
  if (note) $("#compose-note").textContent = note;
  composeDone = false;
  autosaveFailed = false;
  composeSnapshot = snapshot();
  $("#compose-dialog").showModal();
  if (!to.length) f.to.focus();
  else if (rich) $("#compose-rich").focus();
  else { f.body.focus(); f.body.setSelectionRange(0, 0); }
}

// Trae al formulario de redacción los adjuntos de un mensaje guardado (borrador, reenvío).
async function restoreAttachments(m) {
  if (!m.attachments.length) return;
  try {
    attachments = await post(`/api/message/${m.id}/attachments`);
    renderFiles();
    composeSnapshot = snapshot();   // no cuenta como un cambio del usuario
  } catch { $("#compose-error").textContent = "No se pudieron recuperar los adjuntos del mensaje original."; }
}

async function editDraft(m) {
  // Las imágenes del borrador viajan como partes con cid:; se recuperan como subidas nuevas y el HTML se reapunta a ellas.
  let restored = [];
  if (m.attachments.length) {
    try { restored = await post(`/api/message/${m.id}/attachments`); }
    catch { toast("No se pudieron recuperar los adjuntos del borrador."); }
  }
  const byCid = Object.fromEntries(restored.filter((r) => r.cid).map((r) => [r.cid, r]));
  const html = (m.html_cid || m.html || "").replace(/<img\b[^>]*?\bsrc=["']cid:([^"']+)["'][^>]*>/gi, (_all, cid) => {
    const r = byCid[cid];
    return r ? `<img data-upload="${r.id}" src="/outbox/${r.id}/${encodeURIComponent(r.name)}" alt="${escapeAttr(r.name)}">` : "";
  });
  openCompose({
    account: m.account_id, to: splitAddrs(m.to), cc: splitAddrs(m.cc), bcc: splitAddrs(m.bcc), subject: m.subject, body: plainText(m), html,
    inReplyTo: m.in_reply_to, references: m.references, draftId: m.message_id,
  });
  // Lo que no es una imagen del cuerpo vuelve como adjunto normal.
  attachments = restored.filter((r) => !(r.cid && html.includes(`data-upload="${r.id}"`)));
  renderFiles();
  composeSnapshot = snapshot();
}

function composeFrom(m, mode) {
  const own = ownEmails();
  const others = (list) => splitAddrs(list).filter((a) => !own.has(emailOf(a)));
  // La cuenta que recibió el mensaje: la que aparece en Para/Cc; si no, la carpeta donde estaba.
  const recipients = [...splitAddrs(m.to), ...splitAddrs(m.cc)].map(emailOf);
  const receiver = state.accounts.find((a) => recipients.includes(a.email.toLowerCase()))?.id ?? m.account_id;
  const when = new Date(m.date * 1000).toLocaleString();
  const quoted = plainText(m).replace(/\r?\n/g, "\n").trimEnd().split("\n").map((l) => "> " + l).join("\n");
  const re = (p) => (new RegExp(`^${p}:`, "i").test(m.subject) ? m.subject : `${p}: ${m.subject}`);
  if (mode === "forward") {
    openCompose({ account: receiver, subject: re("Fwd"), body: `\n\n---------- Mensaje reenviado ----------\nDe: ${m.from}\nFecha: ${when}\nAsunto: ${m.subject}\nPara: ${m.to}\n\n${plainText(m)}` });
    return restoreAttachments(m);
  }
  openCompose({
    account: receiver, origAccount: receiver,
    to: mode === "all" ? [m.from, ...others(m.to)] : [m.from],
    cc: mode === "all" ? others(m.cc) : [],
    subject: re("Re"),
    body: `\n\nEl ${when}, ${m.from} escribió:\n${quoted}\n`,
    inReplyTo: m.message_id,
    references: `${m.references} ${m.message_id}`.trim(),
  });
}

// adjuntos
let attachments = [];
const MAX_ATTACH = 15 * 1024 * 1024;   // por fichero; el servidor corta a 16 MB de cuerpo
function renderFiles() {
  const box = $("#compose-filelist");
  box.replaceChildren();
  attachments.forEach((file, i) => {
    const chip = el("span", {}, `${file.name} (${Math.ceil(file.size / 1024)} KB) `);
    const x = el("a", { href: "#" }, "✕");
    x.onclick = (e) => { e.preventDefault(); attachments.splice(i, 1); renderFiles(); };
    chip.append(x);
    box.append(chip);
  });
}
$("#compose-attach").onclick = () => $("#compose-files").click();
$("#compose-files").onchange = async (e) => {
  const picked = [...e.target.files];
  e.target.value = "";
  $("#compose-error").textContent = "";
  for (const file of picked) {
    if (file.size > MAX_ATTACH) { $("#compose-error").textContent = `${file.name} supera los 15 MB.`; continue; }
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const up = await api("/api/upload", { method: "POST", body: fd });
      attachments.push({ id: up.id, name: up.name, size: up.size });
    } catch { $("#compose-error").textContent = `No se pudo subir ${file.name}.`; }
    renderFiles();
  }
};

// autocompletado de destinatarios: completa el último tramo tras la coma
const ac = el("ul", { class: "ac", hidden: "" });
let acItems = [], acIdx = 0, acInput = null;
const acClose = () => { ac.hidden = true; acItems = []; };
function acPick(c) {
  const parts = acInput.value.split(",");
  parts[parts.length - 1] = " " + (c.name ? `${c.name} <${c.email}>` : c.email);
  acInput.value = parts.join(",").replace(/^ /, "") + ", ";
  acClose();
  acInput.focus();
}
function acRender() {
  ac.replaceChildren(...acItems.map((c, i) => {
    const li = el("li", { class: i === acIdx ? "on" : "" }, c.name || c.email);
    if (c.name) li.append(el("small", {}, c.email));
    li.onmousedown = (e) => { e.preventDefault(); acPick(c); };
    return li;
  }));
  ac.hidden = !acItems.length;
}
["to", "cc", "bcc"].forEach((name) => {
  const input = $("#compose-form")[name];
  input.addEventListener("input", async () => {
    acInput = input;
    const q = input.value.split(",").pop().trim();
    if (!q) return acClose();
    acItems = (await api(`/api/contacts?q=${encodeURIComponent(q)}`)).filter((c) => !input.value.toLowerCase().includes(c.email));
    acIdx = 0;
    input.parentElement.append(ac);
    acRender();
  });
  input.addEventListener("keydown", (e) => {
    if (ac.hidden || !acItems.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); acIdx = (acIdx + (e.key === "ArrowDown" ? 1 : acItems.length - 1)) % acItems.length; acRender(); }
    else if ((e.key === "Enter" && !e.ctrlKey) || e.key === "Tab") { e.preventDefault(); acPick(acItems[acIdx]); }
    else if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); acClose(); }
  });
  input.addEventListener("blur", acClose);
});

$("#new-mail").onclick = () => openCompose({});
$("#compose-from").onchange = (e) => setComposeAccount(e.target.value);
$("#compose-cancel").onclick = async () => {   // Descartar: borra también la versión guardada
  const f = $("#compose-form");
  composeDone = true;
  $("#compose-dialog").close();
  if (f.dataset.draftId) {
    try { await post("/api/draft/discard", { account: f.account.value, message_id: f.dataset.draftId }); } catch { toast("No se pudo borrar el borrador del servidor."); }
    sync();
  }
};
$("#compose-save").onclick = async () => {
  try { await saveDraft(); flashHint("Borrador guardado " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })); sync(); }
  catch { $("#compose-error").textContent = "No se pudo guardar el borrador. ¿La cuenta tiene carpeta de Borradores?"; }
};
// Cerrar con Esc (o de cualquier otra forma que no sea enviar/descartar) guarda el borrador si hay algo que perder.
$("#compose-dialog").addEventListener("close", async () => {
  if (composeDone || !hasContent() || snapshot() === composeSnapshot) return;
  try { await saveDraft(); toast("Borrador guardado"); sync(); }
  catch {
    if (autosaveFailed) { autosaveFailed = false; toast("No se pudo guardar el borrador; se cerró sin guardar.", 10000); return; }
    autosaveFailed = true;   // la primera vez no se pierde nada: se reabre con el contenido intacto
    $("#compose-error").textContent = "No se pudo guardar el borrador; sigue aquí. Descártalo o inténtalo de nuevo.";
    $("#compose-dialog").showModal();
  }
});
$("#compose-dialog").addEventListener("keydown", (e) => {
  if (!e.ctrlKey) return;
  if (e.key === "s") { e.preventDefault(); $("#compose-save").click(); }
  else if (/^[1-9]$/.test(e.key) && state.accounts[Number(e.key) - 1]) {
    e.preventDefault();
    setComposeAccount(state.accounts[Number(e.key) - 1].id);
  } else if (e.key === "Enter") {
    e.preventDefault();
    $("#compose-form").requestSubmit();
  }
});
$("#compose-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, send = $("#compose-send");
  if (!splitAddrs(f.to.value + "," + f.cc.value + "," + f.bcc.value).length) { $("#compose-error").textContent = "Falta algún destinatario."; return; }
  send.disabled = true;
  $("#compose-error").textContent = "";
  try {
    const res = await post("/api/send", { ...fields(), draft: f.dataset.draftId || "" });
    composeDone = true;
    $("#compose-dialog").close();
    if (res.warning) toast(res.warning, 12000);
    sync();
  } catch (err) {
    $("#compose-error").textContent = "No se pudo enviar el mensaje. Revisa la cuenta y la conexión.";
  }
  send.disabled = false;
};

$("#sync").onclick = sync;
let searchTimer;
$("#search").oninput = (e) => {   // sin consulta por cada tecla
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value; loadList(); }, 200);
};
$("#add-account").onclick = () => { $("#account-test").replaceChildren(); $("#account-error").textContent = ""; $("#account-dialog").showModal(); };
// Servidores habituales: al escribir el correo se sugieren los campos que estén vacíos (siempre editables).
const PROVIDERS = {
  "outlook.com": ["outlook.office365.com", "smtp-mail.outlook.com"], "hotmail.com": ["outlook.office365.com", "smtp-mail.outlook.com"],
  "live.com": ["outlook.office365.com", "smtp-mail.outlook.com"], "yahoo.com": ["imap.mail.yahoo.com", "smtp.mail.yahoo.com"],
  "yahoo.es": ["imap.mail.yahoo.com", "smtp.mail.yahoo.com"], "icloud.com": ["imap.mail.me.com", "smtp.mail.me.com"],
  "me.com": ["imap.mail.me.com", "smtp.mail.me.com"], "gmx.com": ["imap.gmx.com", "mail.gmx.com"], "gmx.es": ["imap.gmx.com", "mail.gmx.com"],
  "zoho.com": ["imap.zoho.com", "smtp.zoho.com"], "fastmail.com": ["imap.fastmail.com", "smtp.fastmail.com"],
  "gmail.com": ["imap.gmail.com", "smtp.gmail.com"],   // con contraseña de aplicación (verificación en dos pasos)
};
$("#account-form").email.addEventListener("blur", (e) => {
  const f = e.target.form, domain = e.target.value.split("@")[1]?.trim().toLowerCase();
  if (!domain) return;
  const [imap, smtp] = PROVIDERS[domain] || [`imap.${domain}`, `smtp.${domain}`];   // lo más habitual en hosting propio
  if (!f.imap_host.value) f.imap_host.value = imap;
  if (!f.smtp_host.value) f.smtp_host.value = smtp;
});
$("#account-try").onclick = async () => {
  const f = $("#account-form"), out = $("#account-test");
  $("#account-error").textContent = "";
  out.replaceChildren();
  if (!f.email.value || !f.password.value || !f.imap_host.value || !f.smtp_host.value) { $("#account-error").textContent = "Rellena correo, contraseña y servidores para probar."; return; }
  const b = $("#account-try");
  b.disabled = true; b.textContent = "Probando…";
  try {
    const r = await post("/api/accounts/test", Object.fromEntries(new FormData(f)));
    [["Recibir (IMAP)", r.imap], ["Enviar (SMTP)", r.smtp]].forEach(([label, x]) => out.append(el("li", { class: x.ok ? "ok" : "bad" }, `${label}: ${x.message}`)));
  } catch { $("#account-error").textContent = "No se pudo hacer la prueba."; }
  b.disabled = false; b.textContent = "Probar conexión";
};
$("#account-cancel").onclick = () => $("#account-dialog").close();
$("#account-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post("/api/accounts", Object.fromEntries(new FormData(e.target)));
    $("#account-dialog").close();
    e.target.reset();
    await refreshAll();
    sync();
  } catch (err) {
    $("#account-error").textContent = "No se pudo guardar la cuenta (¿está instalado secret-tool?)";
  }
};

// ---- barra del editor enriquecido ----------------------------------------------------------
$("#compose-mode").onclick = () => setMode(!rich);
$("#rich-toolbar").addEventListener("mousedown", (e) => e.preventDefault());   // no pierde la selección del editor
document.querySelectorAll("#rich-toolbar [data-cmd]").forEach((b) => { b.onclick = () => { $("#compose-rich").focus(); document.execCommand(b.dataset.cmd); }; });
let savedRange = null;
$("#rich-link").onclick = () => {
  const sel = getSelection();
  savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  $("#link-row").hidden = false;
  $("#link-url").value = "https://";
  $("#link-url").focus();
};
function applyLink() {
  const url = $("#link-url").value.trim();
  $("#link-row").hidden = true;
  const ed = $("#compose-rich");
  ed.focus();
  if (savedRange) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
  if (safeUrl(url) && url.length > 8) document.execCommand("createLink", false, url);
  else $("#compose-error").textContent = "El enlace debe empezar por http://, https:// o mailto:";
}
$("#link-ok").onclick = applyLink;
$("#link-url").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); applyLink(); } });
$("#rich-image").onclick = () => $("#rich-image-file").click();
$("#rich-image-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > MAX_ATTACH) { $("#compose-error").textContent = `${file.name} supera los 15 MB.`; return; }
  try {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const up = await api("/api/upload", { method: "POST", body: fd });
    const ed = $("#compose-rich");
    ed.focus();
    document.execCommand("insertHTML", false, `<img data-upload="${up.id}" src="/outbox/${up.id}/${encodeURIComponent(up.name)}" alt="${escapeAttr(up.name)}">`);
  } catch { $("#compose-error").textContent = `No se pudo subir ${file.name}.`; }
};
// Se pega siempre como texto plano: lo que venga de una web o de un documento no mete estilos ni etiquetas ajenas.
$("#compose-rich").addEventListener("paste", (e) => {
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});

// ---- carpetas propias -------------------------------------------------------------------------
let folderTarget = null, folderTimer;
function openFolderDialog(account, folder) {
  folderTarget = { account, folder };
  const f = $("#folder-form");
  f.reset();
  f.name.value = folder ? folder.path : "";
  $("#folder-title").textContent = folder ? "Renombrar carpeta" : "Nueva carpeta";
  $("#folder-error").textContent = "";
  const del = $("#folder-delete");
  del.hidden = !folder;
  del.dataset.sure = ""; del.textContent = "Eliminar carpeta";
  $("#folder-dialog").showModal();
  f.name.select();
}
const FOLDER_ERRORS = { 400: "Nombre no válido: sin «/» ni «\\», y no vacío.", 409: "Ya existe una carpeta con ese nombre." };
$("#folder-cancel").onclick = () => $("#folder-dialog").close();
$("#folder-form").onsubmit = async (e) => {
  e.preventDefault();
  const { account, folder } = folderTarget, name = e.target.name.value.trim();
  try {
    if (folder) await post(`/api/folders/${folder.id}/rename`, { name });
    else await post("/api/folders", { account, name });
  } catch (err) { $("#folder-error").textContent = FOLDER_ERRORS[err.message] || "No se pudo guardar. Revisa la conexión."; return; }
  $("#folder-dialog").close();
  await refreshAll();
  sync();
};
$("#folder-delete").onclick = async (e) => {
  const b = e.target;
  if (b.dataset.sure !== "1") {   // IMAP borra también los mensajes de la carpeta: pide confirmar
    b.dataset.sure = "1"; b.textContent = "¿Seguro? Borra sus mensajes";
    clearTimeout(folderTimer);
    folderTimer = setTimeout(() => { b.dataset.sure = ""; b.textContent = "Eliminar carpeta"; }, 4000);
    return;
  }
  const { folder } = folderTarget;
  try { await post(`/api/folders/${folder.id}/delete`); }
  catch { $("#folder-error").textContent = "No se pudo eliminar. Revisa la conexión."; return; }
  $("#folder-dialog").close();
  if (state.folder === folder.id) { state.folder = 0; state.role = "inbox"; closeReader(); }
  await refreshAll();
};

// ---- ajustes de cuenta ---------------------------------------------------------------
let settingsAccount = null, removeTimer;
function openSettings(acc) {
  settingsAccount = acc;
  const f = $("#settings-form");
  f.reset();
  f.name.value = acc.name;
  f.color.value = acc.color;
  f.signature.value = acc.signature || "";
  $("#settings-title").textContent = acc.email;
  $("#settings-error").textContent = "";
  const del = $("#settings-delete");
  del.dataset.sure = ""; del.textContent = "Quitar cuenta";
  $("#settings-dialog").showModal();
}
$("#settings-cancel").onclick = () => $("#settings-dialog").close();
$("#settings-delete").onclick = async (e) => {
  const b = e.target;
  if (b.dataset.sure !== "1") {   // quitar la cuenta borra su correo local: pide confirmar
    b.dataset.sure = "1"; b.textContent = "¿Seguro? Borra su correo local";
    clearTimeout(removeTimer);
    removeTimer = setTimeout(() => { b.dataset.sure = ""; b.textContent = "Quitar cuenta"; }, 4000);
    return;
  }
  try { await post(`/api/accounts/${settingsAccount.id}/delete`); }
  catch { $("#settings-error").textContent = "No se pudo quitar la cuenta."; return; }
  $("#settings-dialog").close();
  if (state.account === settingsAccount.id) state.account = 0;
  tabs.length = 0; showInbox();
  refreshAll();
};
$("#settings-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await post(`/api/accounts/${settingsAccount.id}/update`, { name: f.name.value, color: f.color.value, signature: f.signature.value, password: f.password.value });
  } catch { $("#settings-error").textContent = "No se pudo guardar (¿está instalado secret-tool?)."; return; }
  $("#settings-dialog").close();
  refreshAll();
};

// ---- menú nativo ---------------------------------------------------------------------
// Un clic en el menú de la ventana ejecuta fetch("/menu/<accion>") dentro de esta página
// (el mecanismo de Lux Desktop: HTTP por loopback); aquí se atiende sin llegar al servidor.
const goto = (role) => { state.account = 0; state.role = role; renderNav(); loadList(); };
const menu = {
  new: () => openCompose({}),
  sync,
  reply: () => state.current && composeFrom(state.current, "reply"),
  "reply-all": () => state.current && composeFrom(state.current, "all"),
  forward: () => state.current && composeFrom(state.current, "forward"),
  "go-inbox": () => goto("inbox"),
  "go-sent": () => goto("sent"),
  search: () => $("#search").focus(),
  archive: () => state.current && state.current.role !== "archive" && moveMessage(state.current, "archive"),
  delete: () => state.current && deleteMessage(state.current, document.querySelector('#reader [data-act="delete"]')),
  unseen: () => state.current && markUnread(state.current),
  spam: () => state.current && state.current.role !== "junk" && moveMessage(state.current, "junk"),
  move: () => state.current && openMovePicker(state.current.account_id, [state.current.folder_id], (fid) => moveMessage(state.current, "folder", { folder_id: fid })),
};
// ---- teclado ----------------------------------------------------------------------------
// Teclas directas cuando no se está escribiendo (el menú usa Ctrl+… para no robar las de los campos de texto).
// j/k o ↓/↑ recorren la lista; x marca la fila; / busca; c redacta; r responder, a responder a todos, f reenviar;
// e archiva, ! spam, m mueve, u no leído, Supr elimina; ? muestra esta ayuda.
const HELP = "j/k o ↓/↑ moverse · Intro abrir en pestaña · w o Esc cerrar pestaña · [ ] cambiar de pestaña · x marcar · / buscar · c redactar · r responder · a responder a todos · f reenviar · e archivar · ! spam · m mover · u no leído · Supr eliminar · Esc cancelar";
function stepList(delta) {
  const rows = state.rows;
  if (state.tab || !rows.length) return;
  const cur = rows.findIndex((r) => r.id === state.sel || (r.thread_id === state.selThread && r.account_id === state.selAccount));
  const next = Math.min(rows.length - 1, Math.max(0, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta));
  state.anchor = next;
  Object.assign(state, { sel: rows[next].id, selThread: rows[next].thread_id, selAccount: rows[next].account_id });
  loadList();   // solo mueve el resaltado; Intro abre el correo en su pestaña
}
const KEYS = {
  j: () => stepList(1), ArrowDown: () => stepList(1), k: () => stepList(-1), ArrowUp: () => stepList(-1),
  x: () => { const cur = state.rows.findIndex((r) => r.id === state.sel); if (cur >= 0) togglePick(state.rows[cur], cur); },
  Enter: () => { if (!state.tab && state.rows.some((r) => r.id === state.sel)) openMessage(state.sel); },
  w: () => state.tab && closeTab(state.tab), "[": () => stepTab(-1), "]": () => stepTab(1),
  "/": () => $("#search").focus(), c: () => menu.new(), "?": () => toast(HELP, 12000),
  r: () => menu.reply(), a: () => menu["reply-all"](), f: () => menu.forward(),
  e: () => menu.archive(), "!": () => menu.spam(), m: () => menu.move(), u: () => menu.unseen(), Delete: () => menu.delete(),
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ctx.hidden) { hideCtx(); return; }
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (state.selected.size) clearSelection(); else if (state.tab) closeTab(state.tab);
    return;
  }
  if (e.key === "Enter" && e.target !== document.body) return;   // no robar Intro a un botón enfocado
  if (e.ctrlKey || e.altKey || e.metaKey || document.querySelector("dialog[open]")) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const act = KEYS[e.key];
  if (act) { e.preventDefault(); act(); }
});
const realFetch = window.fetch.bind(window);
window.fetch = (url, opts) => {
  if (typeof url === "string" && url.startsWith("/menu/") && url !== "/menu/quit") {
    // con un diálogo abierto (redactando...) los atajos del menú no actúan sobre el mensaje de fondo
    if (!document.querySelector("dialog[open]")) menu[url.slice(6)]?.();
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  return realFetch(url, opts);
};
post("/api/setup-window").catch(() => {});   // en un navegador (sin ventana nativa) no existe: se ignora

// ---- actualizaciones (como Drive de escritorio): al abrir se compara con GitHub ----------------
async function checkUpdate() {
  let r;
  try { r = await api("/api/update"); } catch { return; }
  if (!r.available) return;
  $("#update-commits").replaceChildren(...r.commits.map((c) => {
    const i = c.indexOf(" "), li = el("li");
    li.append(el("code", {}, c.slice(0, i)), " " + c.slice(i + 1));
    return li;
  }));
  $("#update-dialog").showModal();
}
$("#update-later").onclick = () => $("#update-dialog").close();
$("#update-go").onclick = async () => {
  const go = $("#update-go"), later = $("#update-later"), log = $("#update-log"), hint = $("#update-hint");
  if (go.dataset.done) { go.disabled = true; post("/api/restart").catch(() => {}); return; }   // un doble clic abría dos ventanas
  go.disabled = later.disabled = true; log.hidden = false; log.textContent = "Empezando…";
  try { await post("/api/update"); } catch { log.textContent = "No se pudo empezar."; go.disabled = later.disabled = false; return; }
  const poll = setInterval(async () => {
    let l;
    try { l = await api("/api/update/log"); } catch { return; }
    log.textContent = l.log; log.scrollTop = log.scrollHeight;
    if (l.state === "running") return;
    clearInterval(poll);
    go.disabled = later.disabled = false;
    if (l.state === "done") { go.dataset.done = "1"; go.textContent = "Reiniciar Mail"; hint.textContent = "Actualizado. Reinicia la ventana para usar la versión nueva."; }
    else { go.textContent = "Reintentar"; hint.textContent = "No se pudo actualizar. Abajo está el motivo."; }
  }, 1500);
};

// ---- móvil: cajón de carpetas y "atrás" (el Activity de Android llama a luxBack) ---------------
const drawer = (on) => $("#app").classList.toggle("drawer", on);
$("#menu-btn").onclick = () => drawer(true);
$("#app").addEventListener("click", (e) => { if (e.target === $("#app") || e.target.closest("#nav a, #new-mail, #sync, #add-account")) drawer(false); });
// Deslizar a la derecha abre el cajón; a la izquierda lo cierra. Se ignora sobre campos, pestañas (que se desplazan)
// y diálogos, y se exige un gesto claramente horizontal (el desplazamiento vertical de la lista no lo dispara).
let swipe = null;
document.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  swipe = e.touches.length === 1 && !e.target.closest("input, textarea, select, #tabs, dialog[open], [contenteditable]") ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, open = $("#app").classList.contains("drawer");
  if (Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) * 0.5 && matchMedia("(max-width:700px)").matches) {
    if (dx > 0 && !open && swipe.x < innerWidth * 0.6) drawer(true);
    else if (dx < 0 && open) drawer(false);
  }
  swipe = null;
}, { passive: true });
window.luxBack = () => {
  const dlg = document.querySelector("dialog[open]");
  if (dlg) { dlg.close(); return true; }
  if ($("#app").classList.contains("drawer")) { drawer(false); return true; }
  if (state.selected.size) { clearSelection(); return true; }
  if (state.tab) { closeTab(state.tab); return true; }
  return false;
};

renderTabs();
api("/api/safe-domains").then((r) => { state.safe = new Set(r.map((x) => x.domain)); }).catch(() => {});
refreshAll().then(sync);
checkUpdate();
// En la APK sincroniza un servicio en segundo plano (SyncService), también con la app cerrada: aquí solo se repinta.
if (/; wv\)/.test(navigator.userAgent)) {
  setInterval(refreshAll, 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });
} else setInterval(sync, 3 * 60 * 1000);   // ponytail: sondeo cada 3 min; IMAP IDLE no está disponible con libcurl
