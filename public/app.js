const tokenKey = "st-proxy-api-key";
const loginScreen = document.querySelector("#loginScreen");
const appLayout = document.querySelector("#appLayout");
const logoutBtn = document.querySelector("#logoutBtn");
const toast = document.querySelector("#toast");
const channelsEl = document.querySelector("#channels");
const usageRows = document.querySelector("#usageRows");
const addModal = document.querySelector("#addModal");
const editModal = document.querySelector("#editModal");
const editForm = document.querySelector("#editForm");

let apiKey = localStorage.getItem(tokenKey) || "";
let channels = [];

const baseUrlEl = document.querySelector("#baseUrl");
baseUrlEl.textContent = location.origin;
baseUrlEl.title = "点击复制";
baseUrlEl.addEventListener("click", () => copyText(location.origin, "Base URL 已复制"));

// ─── Toast ─────────────────────────────────────────────

function showToast(message, type = "info") {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 4600);
}

// ─── API Request ───────────────────────────────────────

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Request failed: ${res.status}`);
  return body;
}

// ─── Auth ──────────────────────────────────────────────

function setLoggedIn(loggedIn) {
  loginScreen.classList.toggle("hidden", loggedIn);
  appLayout.classList.toggle("hidden", !loggedIn);
}

document.querySelector("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const nextKey = document.querySelector("#loginKey").value.trim();
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: nextKey })
    });
    if (!res.ok) throw new Error("API Key 不正确");
    apiKey = nextKey;
    localStorage.setItem(tokenKey, apiKey);
    setLoggedIn(true);
    await loadAll();
  } catch (error) {
    showToast(error.message, "error");
  }
});

logoutBtn.addEventListener("click", () => {
  apiKey = "";
  localStorage.removeItem(tokenKey);
  setLoggedIn(false);
});

// ─── Add Channel Modal ─────────────────────────────────

document.querySelector("#addChannelBtn").addEventListener("click", () => {
  addModal.classList.remove("hidden");
  addModal.querySelector("input[name='apiBase']").focus();
});

function closeAddModal() {
  addModal.classList.add("hidden");
  document.querySelector("#channelForm").reset();
}

document.querySelector("#addCloseBtn").addEventListener("click", closeAddModal);
document.querySelector("#addCancelBtn").addEventListener("click", closeAddModal);
addModal.addEventListener("click", event => {
  if (event.target === addModal) closeAddModal();
});

document.querySelector("#channelForm").addEventListener("submit", async event => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const submitBtn = formEl.querySelector("button[type='submit']");
  const payload = Object.fromEntries(new FormData(formEl).entries());
  submitBtn.disabled = true;
  try {
    const channel = await request("/api/channels", { method: "POST", body: JSON.stringify(payload) });
    closeAddModal();
    await loadChannels();
    showToast("渠道已保存，正在自动获取模型...", "success");
    try {
      await request(`/api/channels/${channel.id}/fetch-models`, { method: "POST" });
      showToast("渠道已保存，模型列表已自动获取", "success");
    } catch (modelError) {
      showToast(`渠道已保存，但自动获取模型失败：${modelError.message}`, "error");
    }
    await loadChannels();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

// ─── Edit Channel Modal ────────────────────────────────

document.querySelector("#editCloseBtn").addEventListener("click", closeEditModal);
document.querySelector("#editCancelBtn").addEventListener("click", closeEditModal);
editModal.addEventListener("click", event => {
  if (event.target === editModal) closeEditModal();
});

editForm.addEventListener("submit", async event => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const submitBtn = formEl.querySelector("button[type='submit']");
  const payload = Object.fromEntries(new FormData(formEl).entries());
  const id = payload.id;
  delete payload.id;
  if (!payload.apiKey) delete payload.apiKey;
  submitBtn.disabled = true;
  try {
    await request(`/api/channels/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    closeEditModal();
    showToast("渠道已更新", "success");
    await loadChannels();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (!editModal.classList.contains("hidden")) closeEditModal();
    if (!addModal.classList.contains("hidden")) closeAddModal();
  }
});

// ─── Buttons ───────────────────────────────────────────

document.querySelector("#refreshBtn").addEventListener("click", loadChannels);
document.querySelector("#usageBtn").addEventListener("click", loadUsage);
document.querySelector("#clearUsageBtn").addEventListener("click", clearUsage);

// ─── Load Data ─────────────────────────────────────────

async function loadAll() {
  await Promise.all([loadChannels(), loadUsage()]);
}

async function loadChannels() {
  try {
    channels = await request("/api/channels");
    renderChannels();
  } catch (error) {
    showToast(error.message, "error");
    if (error.message === "Unauthorized") setLoggedIn(false);
  }
}

async function loadUsage() {
  try {
    const rows = await request("/api/usage?limit=200");
    usageRows.innerHTML = rows.length
      ? rows.map(row => `
          <tr>
            <td>${new Date(row.time).toLocaleString()}</td>
            <td class="${row.success ? "status-ok" : "status-fail"}">${row.success ? "成功" : "失败"}</td>
            <td>${escapeHtml(row.model || "")}</td>
            <td>${escapeHtml(row.sourceModel || "")}</td>
            <td>${escapeHtml(row.channelNote || row.channelId || "")}</td>
            <td>${row.tokenUsage ?? "—"}</td>
            <td class="error-cell">${failureDetail(row)}</td>
            <td><button type="button" class="btn danger sm" data-usage-delete="${escapeAttr(row.id)}">删除</button></td>
          </tr>
        `).join("")
      : `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:32px">暂无使用记录</td></tr>`;

    usageRows.querySelectorAll("[data-usage-delete]").forEach(button => {
      button.addEventListener("click", () => deleteUsage(button.dataset.usageDelete));
    });
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function clearUsage() {
  if (!confirm("确认清空所有使用记录？")) return;
  try {
    await request("/api/usage", { method: "DELETE" });
    showToast("使用记录已清空", "success");
    await Promise.all([loadUsage(), loadChannels()]);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteUsage(id) {
  if (!confirm("确认删除这条使用记录？")) return;
  try {
    await request(`/api/usage/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("记录已删除", "success");
    await Promise.all([loadUsage(), loadChannels()]);
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ─── Render Channels ───────────────────────────────────

function renderChannels() {
  if (!channels.length) {
    channelsEl.innerHTML = `<div class="empty-hint">还没有渠道，点击右上角"添加渠道"开始使用。</div>`;
    return;
  }

  channelsEl.innerHTML = channels.map(channel => {
    const enabledModels = (channel.models || []).filter(m => m.enabled);
    const modelChips = enabledModels.slice(0, 6).map(m =>
      `<span class="model-chip">${escapeHtml(m.alias || m.id)}</span>`
    ).join("");
    const moreChip = enabledModels.length > 6
      ? `<span class="model-chip more">+${enabledModels.length - 6}</span>` : "";
    const noModels = !enabledModels.length
      ? `<span class="no-models-hint">未启用模型</span>` : "";
    const isEnabled = channel.enabled !== false;

    return `
      <div class="channel-card" data-id="${channel.id}">
        <div class="card-body">
          <div class="card-top">
            <div class="card-title-row">
              <span class="card-name">${escapeHtml(channel.note || channel.apiBase)}</span>
              <label class="toggle-wrap">
                <input type="checkbox" data-action="toggle-enabled" ${isEnabled ? "checked" : ""}>
                <span class="toggle-track"></span>
                <span class="toggle-label">${isEnabled ? "启用中" : "已停用"}</span>
              </label>
            </div>
            <button type="button" class="btn ghost sm" data-action="edit">编辑</button>
          </div>
          <div class="card-meta">
            <span class="badge">${escapeHtml(channel.providerType || "auto")}</span>
            <span class="meta-sep">·</span>
            <span>使用 ${Number(channel.usageCount || 0)} 次</span>
            ${channel.note ? `<span class="meta-sep">·</span><span>${escapeHtml(channel.apiBase)}</span>` : ""}
            ${channel.providerLink ? `<span class="meta-sep">·</span><a href="${escapeAttr(channel.providerLink)}" target="_blank" rel="noreferrer">服务商</a>` : ""}
          </div>
          <div class="model-chips">${modelChips}${moreChip}${noModels}</div>
          <div class="card-actions">
            <button type="button" class="btn ghost sm" data-action="test">测试</button>
            <button type="button" class="btn ghost sm" data-action="fetch">获取模型</button>
            <button type="button" class="btn ghost sm" data-action="toggle-models">展开模型</button>
            <button type="button" class="btn danger sm" data-action="delete">删除</button>
          </div>
        </div>
        <div class="models-section hidden">
          ${(channel.models || []).length ? `
            <div class="model-tools">
              <button type="button" class="btn ghost sm" data-action="select-all">全选</button>
              <button type="button" class="btn ghost sm" data-action="select-none">全不选</button>
              <button type="button" class="btn ghost sm" data-action="invert-selection">反选</button>
              <button type="button" class="btn primary sm" data-action="save-models">保存</button>
            </div>
            <p class="model-alias-hint">模型别名用于匹配相同模型；多个渠道使用同一别名时，请求会按别名匹配，并在失败时自动轮询下一个可用渠道。</p>
            <div class="model-row model-row-head">
              <span></span>
              <span>模型名</span>
              <span>模型别名</span>
            </div>
          ` : ""}
          <div class="model-rows">
            ${(channel.models || []).map(model => `
              <label class="model-row">
                <input type="checkbox" data-model-enabled="${escapeAttr(model.id)}" ${model.enabled ? "checked" : ""}>
                <code>${escapeHtml(model.id)}</code>
                <input type="text" data-model-alias="${escapeAttr(model.id)}" value="${escapeAttr(model.alias || model.id)}" placeholder="别名">
              </label>
            `).join("") || `<p class="no-models-hint">尚未获取模型，请点击"获取模型"。</p>`}
          </div>
        </div>
      </div>
    `;
  }).join("");

  channelsEl.querySelectorAll("[data-action]").forEach(control => {
    if (control.tagName === "BUTTON") {
      control.addEventListener("click", () =>
        channelAction(control.closest(".channel-card").dataset.id, control.dataset.action, control)
      );
    }
    if (control.matches("input[type='checkbox'][data-action='toggle-enabled']")) {
      control.addEventListener("change", () =>
        channelAction(control.closest(".channel-card").dataset.id, control.dataset.action, control)
      );
    }
  });
}

// ─── Channel Actions ───────────────────────────────────

async function channelAction(id, action, control) {
  const cardEl = channelsEl.querySelector(`[data-id="${id}"]`);
  try {
    if (action === "toggle-enabled") {
      await request(`/api/channels/${id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled: control.checked }) });
      showToast(control.checked ? "渠道已启用" : "渠道已停用", "success");
      await loadChannels();
      return;
    }
    if (action === "edit") {
      openEditModal(id);
      return;
    }
    if (action === "test") {
      showToast("正在发送对话测试：你好", "info");
      try {
        const result = await request(`/api/channels/${id}/test`, { method: "POST", body: JSON.stringify({ message: "你好" }) });
        if (result.ok) {
          showToast(`渠道可用：${result.response || result.alias || result.model}`, "success");
        } else {
          showToast(`渠道不可用：${testFailureText(result)}`, "error");
        }
        await loadUsage();
      } catch (error) {
        if (error.message === "Not found") {
          showToast("测试接口不存在：请重建并重启容器", "error");
        } else {
          showToast(error.message, "error");
        }
      }
      return;
    }
    if (action === "toggle-models") {
      const modelsEl = cardEl.querySelector(".models-section");
      const btn = cardEl.querySelector('[data-action="toggle-models"]');
      const willOpen = modelsEl.classList.contains("hidden");
      modelsEl.classList.toggle("hidden", !willOpen);
      btn.textContent = willOpen ? "折叠模型" : "展开模型";
      return;
    }
    if (action === "select-all" || action === "select-none" || action === "invert-selection") {
      const checks = [...cardEl.querySelectorAll("[data-model-enabled]")];
      for (const cb of checks) {
        if (action === "select-all") cb.checked = true;
        if (action === "select-none") cb.checked = false;
        if (action === "invert-selection") cb.checked = !cb.checked;
      }
      return;
    }
    if (action === "fetch") {
      await request(`/api/channels/${id}/fetch-models`, { method: "POST" });
      showToast("模型列表已更新", "success");
      await loadChannels();
      return;
    }
    if (action === "delete") {
      if (!confirm("确认删除这个渠道？")) return;
      await request(`/api/channels/${id}`, { method: "DELETE" });
      await loadChannels();
      return;
    }
    if (action === "save-models") {
      const models = [...cardEl.querySelectorAll("[data-model-alias]")].map(input => {
        const modelId = input.dataset.modelAlias;
        return {
          id: modelId,
          alias: input.value.trim() || modelId,
          enabled: cardEl.querySelector(`[data-model-enabled="${cssEscape(modelId)}"]`).checked
        };
      });
      await request(`/api/channels/${id}/models`, { method: "PUT", body: JSON.stringify({ models }) });
      showToast("模型设置已保存", "success");
      await loadChannels();
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ─── Edit Modal ────────────────────────────────────────

async function openEditModal(id) {
  let channel = channels.find(c => c.id === id);
  if (!channel) return showToast("渠道不存在", "error");
  try {
    channel = await request(`/api/channels/${id}`);
  } catch (error) {
    showToast(error.message, "error");
    return;
  }
  editForm.elements.id.value = channel.id;
  editForm.elements.apiBase.value = channel.apiBase || "";
  editForm.elements.apiKey.value = channel.apiKey || "";
  editForm.elements.note.value = channel.note || "";
  editForm.elements.providerLink.value = channel.providerLink || "";
  editForm.elements.providerType.value = channel.providerType || "auto";
  editModal.classList.remove("hidden");
  editForm.elements.apiBase.focus();
}

function closeEditModal() {
  editModal.classList.add("hidden");
  editForm.reset();
}

// ─── Utilities ─────────────────────────────────────────

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function copyText(value, successMessage) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    showToast(successMessage, "success");
  } catch (error) {
    showToast("复制失败，请手动复制", "error");
  }
}

function failureDetail(row) {
  if (row.success) return "";
  const parts = [];
  if (row.error) parts.push(row.error);
  if (row.upstreamStatus) parts.push(`HTTP ${row.upstreamStatus}`);
  if (row.upstreamBody) parts.push(row.upstreamBody);
  return escapeHtml(parts.join("\n"));
}

function testFailureText(result) {
  const parts = [result.message];
  if (result.upstreamStatus) parts.push(`HTTP ${result.upstreamStatus}`);
  if (result.upstreamBody) parts.push(result.upstreamBody);
  return parts.filter(Boolean).join(" / ");
}

// ─── Init ──────────────────────────────────────────────

if (apiKey) {
  setLoggedIn(true);
  loadAll();
} else {
  setLoggedIn(false);
}
