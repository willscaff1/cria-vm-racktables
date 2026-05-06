const state = {
  vcenters: [],
  racktablesConfigs: [],
  inventory: null,
  racktables: {
    equipeResponsavel: [],
    orgaos: [],
    situacoes: [],
    tags: []
  },
  freeSids: [],
  freeIps: [],
  networks: []
};

const selectedTagIds = new Set();
let vmDisks = [];
let selectedTemplateDetails = null;
let editingVcenterId = null;
let editingRackTablesId = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", async () => {
  setupNavigation();
  setupForms();
  await initialLoad();
});

function setupNavigation() {
  $$(".nav-button").forEach((button) => {
    button.addEventListener("click", async () => {
      $$(".nav-button").forEach((item) => item.classList.remove("active"));
      $$(".view").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`#view-${button.dataset.view}`).classList.add("active");
      if (button.dataset.view === "jobs") await loadJobs();
    });
  });
}

function setupForms() {
  $("#open-vcenter-modal").addEventListener("click", openVcenterModal);
  $("#open-racktables-modal").addEventListener("click", openRackTablesModal);
  $("#confirm-ok").addEventListener("click", () => closeModal("#confirm-modal"));
  $$("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => closeModal(`#${button.closest(".modal-backdrop").id}`));
  });
  $$(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal(`#${backdrop.id}`);
    });
  });
  $("#test-vcenter").addEventListener("click", testVcenter);
  $("#vcenter-form").addEventListener("submit", saveVcenter);
  $("#racktables-form").addEventListener("submit", saveRackTables);
  $("#test-racktables").addEventListener("click", testRackTables);
  $("#create-vcenter").addEventListener("change", loadInventory);
  $("#create-racktables").addEventListener("change", loadRackTablesData);
  $("#racktables-network").addEventListener("change", loadFreeIps);
  $("#tag-picker").addEventListener("change", addSelectedTag);
  $("#template-id").addEventListener("change", applySelectedTemplateDetails);
  $("#add-disk").addEventListener("click", addDisk);
  $("#deploy-mode").addEventListener("change", updateDeployMode);
  $("#reload-create").addEventListener("click", initialLoad);
  $("#reload-jobs").addEventListener("click", loadJobs);
  $("#provision-form").addEventListener("submit", provisionVm);
}

async function initialLoad() {
  await Promise.allSettled([loadVcenters(), loadRackTablesConfig()]);
  await loadRackTablesData();
  await loadInventory();
  updateDeployMode();
}

async function loadVcenters() {
  state.vcenters = await api("/api/vcenters");
  fillSelect($("#create-vcenter"), state.vcenters, "id", "name", "Selecione...");
  renderVcenters();
}

async function loadRackTablesConfig() {
  try {
    state.racktablesConfigs = await api("/api/racktables/config");
    fillSelect($("#create-racktables"), state.racktablesConfigs, "id", rackTablesLabel, "Selecione...");
    renderRackTablesConfigs();
    const count = state.racktablesConfigs.length;
    $("#racktables-select-status").textContent = count === 1 ? "1 RackTables cadastrado" : `${count} RackTables cadastrados`;
    setStatus("#integration-status", count ? `${count} RackTables cadastrado(s).` : "RackTables ainda nao configurado.", "");
  } catch {
    state.racktablesConfigs = [];
    fillSelect($("#create-racktables"), [], "id", "name", "Selecione...");
    renderRackTablesConfigs();
    setStatus("#integration-status", "RackTables ainda nao configurado.", "");
  }
}

async function loadRackTablesData() {
  selectedTagIds.clear();
  state.freeIps = [];
  renderFreeIps();
  await Promise.allSettled([loadRackTablesOptions(), loadFreeSids(), loadRackTablesNetworks()]);
}

async function loadRackTablesOptions() {
  const racktablesId = selectedRackTablesId();
  if (!racktablesId) {
    state.racktables = { equipeResponsavel: [], orgaos: [], situacoes: [], tags: [] };
    fillSelect($("#equipe-responsavel"), [], "id", "name", "Selecione...");
    fillSelect($("#orgao"), [], "id", "name", "Selecione...");
    fillSelect($("#situacao"), [], "id", "name", "Selecione...");
    fillSelect($("#tag-picker"), [], "id", "name", "Adicionar tag...");
    return;
  }
  try {
    state.racktables = await api(`/api/racktables/options?racktablesId=${encodeURIComponent(racktablesId)}`);
    fillSelect($("#equipe-responsavel"), state.racktables.equipeResponsavel, "id", "name", "Selecione...");
    fillSelect($("#orgao"), state.racktables.orgaos, "id", "name", "Selecione...");
    fillSelect($("#situacao"), state.racktables.situacoes, "id", "name", "Selecione...");
    fillSelect($("#tag-picker"), state.racktables.tags, "id", "name", "Adicionar tag...");
    renderSelectedTags();
  } catch (error) {
    setStatus("#create-status", `RackTables: ${error.message}`, "error");
  }
}

async function loadFreeSids() {
  const racktablesId = selectedRackTablesId();
  if (!racktablesId) {
    state.freeSids = [];
    renderFreeSids();
    return;
  }
  try {
    state.freeSids = await api(`/api/racktables/free-sids?racktablesId=${encodeURIComponent(racktablesId)}`);
    renderFreeSids();
  } catch (error) {
    state.freeSids = [];
    renderFreeSids();
    setStatus("#create-status", `SIDs livres: ${error.message}`, "error");
  }
}

async function loadFreeIps() {
  const racktablesId = selectedRackTablesId();
  const networkId = $("#racktables-network").value;
  if (!racktablesId || !networkId) {
    state.freeIps = [];
    renderFreeIps();
    return;
  }

  try {
    setIpStatus("Buscando IPs livres/offline da rede selecionada...");
    state.freeIps = await api(`/api/racktables/free-ips?limit=300&networkId=${encodeURIComponent(networkId)}&racktablesId=${encodeURIComponent(racktablesId)}`);
    renderFreeIps();
  } catch (error) {
    state.freeIps = [];
    renderFreeIps();
    setStatus("#create-status", `IPs livres: ${error.message}`, "error");
  }
}

async function loadRackTablesNetworks() {
  const racktablesId = selectedRackTablesId();
  if (!racktablesId) {
    state.networks = [];
    renderRackTablesNetworks();
    return;
  }
  try {
    state.networks = await api(`/api/racktables/networks?racktablesId=${encodeURIComponent(racktablesId)}`);
    renderRackTablesNetworks();
  } catch (error) {
    state.networks = [];
    renderRackTablesNetworks();
    setStatus("#create-status", `Redes RackTables: ${error.message}`, "error");
  }
}

async function loadInventory() {
  const vcenterId = $("#create-vcenter").value;
  if (!vcenterId) {
    clearInventory();
    return;
  }

  setStatus("#create-status", "Carregando inventario do vCenter...", "");
  try {
    state.inventory = await api(`/api/vcenters/${vcenterId}/inventory`);
    fillSelect($("#cluster-id"), state.inventory.clusters, "cluster", "name", "Selecione...");
    fillSelect($("#host-id"), state.inventory.hosts, "host", "name", "Selecione...");
    fillSelect($("#datastore-id"), state.inventory.datastores, "datastore", datastoreLabel, "Selecione...");
    fillSelect($("#network-id"), state.inventory.networks, "network", "name", "Selecione...");
    fillSelect($("#template-id"), state.inventory.templates, "id", templateLabel, "Selecione...");
    updateTemplateStatus(state.inventory.templates);
    applySelectedTemplateDetails();
    applySuggestions();
    setStatus("#create-status", "Inventario carregado.", "ok");
  } catch (error) {
    clearInventory();
    updateTemplateStatus([]);
    setStatus("#create-status", `Inventario: ${error.message}`, "error");
  }
}

function clearInventory() {
  ["#cluster-id", "#host-id", "#datastore-id", "#network-id", "#template-id"].forEach((selector) => {
    fillSelect($(selector), [], "id", "name", "Selecione...");
  });
}

function openVcenterModal() {
  const form = $("#vcenter-form");
  editingVcenterId = null;
  $("#vcenter-modal-title").textContent = "Adicionar vCenter";
  form.querySelector("button[type='submit']").textContent = "Cadastrar";
  form.reset();
  form.insecure.checked = true;
  setStatus("#vcenter-status", "", "");
  openModal("#vcenter-modal");
  form.name.focus();
}

function openRackTablesModal() {
  const form = $("#racktables-form");
  editingRackTablesId = null;
  $("#racktables-modal-title").textContent = "Adicionar RackTables";
  form.querySelector("button[type='submit']").textContent = "Salvar";
  form.reset();
  setStatus("#racktables-status", "", "");
  openModal("#racktables-modal");
  form.name.focus();
}

function openEditVcenterModal(id) {
  const vcenter = state.vcenters.find((item) => item.id === id);
  if (!vcenter) return;
  const form = $("#vcenter-form");
  editingVcenterId = id;
  $("#vcenter-modal-title").textContent = "Editar vCenter";
  form.querySelector("button[type='submit']").textContent = "Salvar";
  form.name.value = vcenter.name || "";
  form.host.value = vcenter.host || "";
  form.username.value = vcenter.username || "";
  form.password.value = "";
  form.insecure.checked = Boolean(vcenter.insecure);
  setStatus("#vcenter-status", "Informe a senha para salvar alteracoes.", "");
  openModal("#vcenter-modal");
  form.name.focus();
}

function openEditRackTablesModal(id) {
  const config = state.racktablesConfigs.find((item) => item.id === id);
  if (!config) return;
  const form = $("#racktables-form");
  editingRackTablesId = id;
  $("#racktables-modal-title").textContent = "Editar RackTables";
  form.querySelector("button[type='submit']").textContent = "Salvar";
  form.name.value = config.name || "";
  form.baseUrl.value = config.baseUrl || "";
  form.username.value = config.username || "";
  form.password.value = "";
  setStatus("#racktables-status", "Informe a senha para salvar alteracoes.", "");
  openModal("#racktables-modal");
  form.name.focus();
}

function openModal(selector) {
  $(selector).classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeModal(selector) {
  $(selector).classList.add("hidden");
  if (!$(".modal-backdrop:not(.hidden)")) {
    document.body.classList.remove("modal-open");
  }
}

function showConfirmation(title, fields) {
  $("#confirm-modal-title").textContent = title;
  $("#confirm-summary").innerHTML = fields
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `
      <div>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </div>
    `).join("");
  openModal("#confirm-modal");
  $("#confirm-ok").focus();
}

function applySuggestions() {
  const suggestions = state.inventory?.suggestions || {};
  if (suggestions.cluster?.cluster) $("#cluster-id").value = suggestions.cluster.cluster;
  if (suggestions.host?.host) $("#host-id").value = suggestions.host.host;
  if (suggestions.datastore?.datastore) $("#datastore-id").value = suggestions.datastore.datastore;
}

async function testVcenter() {
  const form = $("#vcenter-form");
  setStatus("#vcenter-status", "Testando vCenter...", "");
  try {
    const result = await api("/api/vcenters/test", {
      method: "POST",
      body: formJson(form)
    });
    setStatus("#vcenter-status", `Conexao OK. IP: ${result.ip}. Endpoint: ${result.sessionEndpoint}`, "ok");
  } catch (error) {
    setStatus("#vcenter-status", error.message, "error");
  }
}

async function saveVcenter(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const editing = Boolean(editingVcenterId);
  setStatus("#vcenter-status", editing ? "Testando e salvando..." : "Testando e cadastrando...", "");
  try {
    const result = await api(editing ? `/api/vcenters/${editingVcenterId}` : "/api/vcenters", {
      method: editing ? "PUT" : "POST",
      body: formJson(form)
    });
    editingVcenterId = null;
    form.reset();
    form.insecure.checked = true;
    await loadVcenters();
    closeModal("#vcenter-modal");
    showConfirmation(editing ? "vCenter atualizado" : "vCenter cadastrado", [
      ["Nome", result.name],
      ["Host", result.host],
      ["IP", result.ip || ""],
      ["Conexao", result.lastTest?.ok ? "OK" : "Pendente"]
    ]);
    setStatus("#integration-status", `vCenter ${result.name} ${editing ? "atualizado" : "cadastrado"}.`, "ok");
  } catch (error) {
    setStatus("#vcenter-status", error.message, "error");
  }
}

async function testRackTables() {
  const form = $("#racktables-form");
  setStatus("#racktables-status", "Testando RackTables...", "");
  try {
    const result = await api("/api/racktables/config/test", {
      method: "POST",
      body: formJson(form)
    });
    setStatus("#racktables-status", result.message || "Conexao OK.", "ok");
  } catch (error) {
    setStatus("#racktables-status", error.message, "error");
  }
}

async function saveRackTables(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const editing = Boolean(editingRackTablesId);
  setStatus("#racktables-status", editing ? "Testando e salvando RackTables..." : "Salvando RackTables...", "");
  try {
    const result = await api(editing ? `/api/racktables/${editingRackTablesId}` : "/api/racktables/config", {
      method: editing ? "PUT" : "POST",
      body: formJson(form)
    });
    editingRackTablesId = null;
    await loadRackTablesConfig();
    $("#create-racktables").value = result.id;
    await loadRackTablesData();
    closeModal("#racktables-modal");
    showConfirmation(editing ? "RackTables atualizado" : "RackTables cadastrado", [
      ["Nome", result.name],
      ["URL", result.baseUrl],
      ["Usuario", result.username],
      ["Conexao", "OK"]
    ]);
    setStatus("#integration-status", `RackTables ${result.name} ${editing ? "atualizado" : "configurado"}.`, "ok");
  } catch (error) {
    setStatus("#racktables-status", error.message, "error");
  }
}

async function provisionVm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formJson(form);
  const selectedVcenter = state.vcenters.find((item) => item.id === data.vcenterId);
  if (!data.networkId) {
    setStatus("#create-status", "Selecione a rede/portgroup do vCenter antes de criar.", "error");
    return;
  }

  const payload = {
    vcenterId: data.vcenterId,
    vcenterName: selectedVcenter?.name || "",
    racktablesId: data.racktablesId,
    racktablesName: selectedText("#create-racktables"),
    deployMode: data.deployMode,
    templateId: data.templateId,
    templateName: selectedText("#template-id"),
    isoPath: data.isoPath,
    vm: {
      label: data.label,
      cpu: Number(data.cpu || 0),
      memoryGb: Number(data.memoryGb || 0),
      diskGb: vmDisks.reduce((sum, disk) => sum + Number(disk.capacityGb || 0), 0),
      disks: vmDisks.map((disk) => ({ id: disk.id, label: disk.label, capacityGb: Number(disk.capacityGb || 0) })),
      originalDisks: (selectedTemplateDetails?.disks || []).map((disk) => ({ id: disk.id, label: disk.label, capacityGb: Number(disk.capacityGb || 0) }))
    },
    placement: {
      clusterId: data.clusterId,
      clusterName: selectedText("#cluster-id"),
      hostId: data.hostId,
      hostName: selectedText("#host-id"),
      datastoreId: data.datastoreId,
      datastoreName: selectedText("#datastore-id"),
      networkId: data.networkId,
      networkName: selectedText("#network-id")
    },
    racktables: {
      racktablesId: data.racktablesId,
      commonName: data.commonName,
      objectId: selectedOptionData("#free-sid", "objectId"),
      assetTag: data.assetTag,
      fqdn: data.fqdn,
      solicitante: data.solicitante,
      equipeResponsavel: data.equipeResponsavel,
      orgao: data.orgao,
      situacao: data.situacao,
      osType: selectedTemplateDetails?.osTypeId || "0",
      tags: [...selectedTagIds]
    }
  };

  setStatus("#create-status", "Enviando solicitacao...", "");
  try {
    const result = await api("/api/provision", {
      method: "POST",
      body: payload
    });
    setStatus("#create-status", `Solicitacao ${result.job.id} concluida.`, "ok");
    await loadJobs();
  } catch (error) {
    setStatus("#create-status", error.message, "error");
    await loadJobs();
  }
}

async function loadJobs() {
  const jobs = await api("/api/jobs");
  const container = $("#job-list");
  if (!jobs.length) {
    container.innerHTML = `<div class="row">Nenhuma solicitacao registrada.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="row header">
      <span>Data</span><span>VM</span><span>Status</span><span>Detalhe</span>
    </div>
    ${jobs.map((job) => `
      <details class="job-item">
        <summary class="row">
          <span>${formatDate(job.createdAt)}</span>
          <span>${escapeHtml(job.request?.vm?.label || "")}</span>
          <span class="pill ${job.status === "concluido" ? "ok" : job.status === "erro" ? "error" : ""}">${escapeHtml(job.status)}</span>
          <span>${escapeHtml(job.error || job.messages?.join(" ") || "")}</span>
        </summary>
        ${renderJobDetails(job)}
        ${job.status === "erro" ? `<div class="job-actions"><button type="button" class="primary" data-action="retry-job" data-id="${job.id}">Tentar novamente</button></div>` : ""}
      </details>
    `).join("")}
  `;

  container.querySelectorAll("[data-action='retry-job']").forEach((button) => {
    button.addEventListener("click", () => retryJob(button.dataset.id, jobs));
  });
}

function renderJobDetails(job) {
  const fields = [
    ["Job", job.id],
    ["SID", job.request?.racktables?.commonName],
    ["Label", job.request?.vm?.label],
    ["IP", job.request?.racktables?.assetTag],
    ["FQDN", job.request?.racktables?.fqdn],
    ["vCenter", job.request?.vcenterName],
    ["Template", job.request?.templateName],
    ["Cluster", job.request?.placement?.clusterName],
    ["Host", job.request?.placement?.hostName],
    ["Datastore", job.request?.placement?.datastoreName],
    ["CPU", job.request?.vm?.cpu],
    ["Memoria GB", job.request?.vm?.memoryGb],
    ["Disco total GB", job.request?.vm?.diskGb],
    ["VM ID vCenter", job.vcenterResult?.vmId],
    ["Object ID RackTables", job.racktablesResult?.objectId],
    ["Comment RackTables", job.racktablesResult?.comment],
    ["Erro", job.error]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");

  return `<div class="job-details">${fields.map(([label, value]) => `
    <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>
  `).join("")}</div>`;
}

async function retryJob(id, jobs) {
  const job = jobs.find((item) => item.id === id);
  if (!job?.request) {
    setStatus("#create-status", "Solicitacao original nao encontrada para retry.", "error");
    return;
  }

  if (!window.confirm(`Tentar novamente a criacao da VM ${job.request?.vm?.label || ""}?`)) return;

  try {
    const result = await api("/api/provision", {
      method: "POST",
      body: job.request
    });
    await loadJobs();
    alert(`Nova tentativa criada: ${result.job.id}`);
  } catch (error) {
    await loadJobs();
    alert(error.message);
  }
}

function renderVcenters() {
  const container = $("#vcenter-list");
  if (!state.vcenters.length) {
    container.innerHTML = `<div class="row">Nenhum vCenter cadastrado.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="row header">
      <span>Nome</span><span>Host</span><span>IP</span><span>Acoes</span>
    </div>
    ${state.vcenters.map((vcenter) => `
      <div class="row">
        <span>${escapeHtml(vcenter.name)}</span>
        <span>${escapeHtml(vcenter.host)}</span>
        <span>${escapeHtml(vcenter.ip || "")}</span>
        <span class="row-actions">
          <span class="pill ${vcenter.lastTest?.ok ? "ok" : "error"}">${vcenter.lastTest?.ok ? "OK" : "Erro"}</span>
          <button type="button" class="mini-button" data-action="test-vcenter" data-id="${vcenter.id}">Testar</button>
          <button type="button" class="mini-button" data-action="edit-vcenter" data-id="${vcenter.id}">Editar</button>
          <button type="button" class="mini-button danger" data-action="delete-vcenter" data-id="${vcenter.id}">Remover</button>
        </span>
      </div>
    `).join("")}
  `;

  container.querySelectorAll("[data-action='test-vcenter']").forEach((button) => {
    button.addEventListener("click", () => retestSavedVcenter(button.dataset.id));
  });
  container.querySelectorAll("[data-action='edit-vcenter']").forEach((button) => {
    button.addEventListener("click", () => openEditVcenterModal(button.dataset.id));
  });
  container.querySelectorAll("[data-action='delete-vcenter']").forEach((button) => {
    button.addEventListener("click", () => deleteSavedVcenter(button.dataset.id));
  });
}

function renderRackTablesConfigs() {
  const container = $("#racktables-list");
  if (!container) return;
  if (!state.racktablesConfigs.length) {
    container.innerHTML = `<div class="row">Nenhum RackTables cadastrado.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="row header">
      <span>Nome</span><span>URL</span><span>Usuario</span><span>Acoes</span>
    </div>
    ${state.racktablesConfigs.map((config) => `
      <div class="row">
        <span>${escapeHtml(config.name)}</span>
        <span>${escapeHtml(config.baseUrl)}</span>
        <span>${escapeHtml(config.username || "")}</span>
        <span class="row-actions">
          <span class="pill ${config.lastTest?.ok ? "ok" : config.lastTest ? "error" : ""}">${config.lastTest?.ok ? "OK" : config.lastTest ? "Erro" : "Sem teste"}</span>
          <button type="button" class="mini-button" data-action="test-racktables" data-id="${config.id}">Testar</button>
          <button type="button" class="mini-button" data-action="edit-racktables" data-id="${config.id}">Editar</button>
          <button type="button" class="mini-button danger" data-action="delete-racktables" data-id="${config.id}">Remover</button>
        </span>
      </div>
    `).join("")}
  `;

  container.querySelectorAll("[data-action='test-racktables']").forEach((button) => {
    button.addEventListener("click", () => retestSavedRackTables(button.dataset.id));
  });
  container.querySelectorAll("[data-action='edit-racktables']").forEach((button) => {
    button.addEventListener("click", () => openEditRackTablesModal(button.dataset.id));
  });
  container.querySelectorAll("[data-action='delete-racktables']").forEach((button) => {
    button.addEventListener("click", () => deleteSavedRackTables(button.dataset.id));
  });
}

async function retestSavedVcenter(id) {
  setStatus("#vcenter-status", "Testando vCenter cadastrado...", "");
  try {
    const result = await api(`/api/vcenters/${id}/test`, { method: "POST", body: {} });
    await loadVcenters();
    setStatus("#vcenter-status", `Conexao OK. IP: ${result.ip}`, "ok");
  } catch (error) {
    await loadVcenters();
    setStatus("#vcenter-status", error.message, "error");
  }
}

async function deleteSavedVcenter(id) {
  const vcenter = state.vcenters.find((item) => item.id === id);
  if (!window.confirm(`Remover vCenter ${vcenter?.name || id}?`)) return;

  setStatus("#vcenter-status", "Removendo vCenter...", "");
  try {
    await api(`/api/vcenters/${id}`, { method: "DELETE", body: {} });
    await loadVcenters();
    setStatus("#vcenter-status", "vCenter removido.", "ok");
  } catch (error) {
    setStatus("#vcenter-status", error.message, "error");
  }
}

async function retestSavedRackTables(id) {
  setStatus("#integration-status", "Testando RackTables cadastrado...", "");
  try {
    const result = await api(`/api/racktables/${id}/test`, { method: "POST", body: {} });
    await loadRackTablesConfig();
    setStatus("#integration-status", result.message || "RackTables OK.", "ok");
  } catch (error) {
    await loadRackTablesConfig();
    setStatus("#integration-status", error.message, "error");
  }
}

async function deleteSavedRackTables(id) {
  const config = state.racktablesConfigs.find((item) => item.id === id);
  if (!window.confirm(`Remover RackTables ${config?.name || id}?`)) return;

  setStatus("#integration-status", "Removendo RackTables...", "");
  try {
    await api(`/api/racktables/${id}`, { method: "DELETE", body: {} });
    await loadRackTablesConfig();
    await loadRackTablesData();
    setStatus("#integration-status", "RackTables removido.", "ok");
  } catch (error) {
    setStatus("#integration-status", error.message, "error");
  }
}

function updateDeployMode() {
  const mode = $("#deploy-mode").value;
  $$(".template-only").forEach((item) => item.classList.toggle("hidden", mode !== "template"));
  $$(".iso-only").forEach((item) => item.classList.toggle("hidden", mode !== "iso"));
}

function applySelectedTemplateDetails() {
  const templateId = $("#template-id").value;
  const template = (state.inventory?.templates || []).find((item) => item.id === templateId);
  if (!template) {
    selectedTemplateDetails = null;
    vmDisks = [];
    renderDisks();
    return;
  }

  selectedTemplateDetails = template;
  if (template.cpu) $("#provision-form").cpu.value = template.cpu;
  if (template.memoryGb) $("#provision-form").memoryGb.value = template.memoryGb;
  vmDisks = Array.isArray(template.disks) && template.disks.length
    ? template.disks.map((disk, index) => ({
        id: disk.id || cryptoId(),
        label: disk.label || `Disco ${index + 1}`,
        capacityGb: Number(disk.capacityGb || 0)
      }))
    : [{ id: cryptoId(), label: "Disco 1", capacityGb: Number($("#provision-form").diskGb.value || 80) }];
  renderDisks();
}

function addDisk() {
  vmDisks.push({
    id: cryptoId(),
    label: `Disco ${vmDisks.length + 1}`,
    capacityGb: 20
  });
  renderDisks();
}

function removeDisk(id) {
  vmDisks = vmDisks.filter((disk) => disk.id !== id);
  renderDisks();
}

function renderDisks() {
  const list = $("#disk-list");
  if (!list) return;
  list.innerHTML = "";

  vmDisks.forEach((disk) => {
    const row = document.createElement("div");
    row.className = "disk-row";

    const name = document.createElement("input");
    name.value = disk.label;
    name.setAttribute("aria-label", "Nome do disco");
    name.addEventListener("input", () => {
      disk.label = name.value;
    });

    const size = document.createElement("input");
    size.type = "number";
    size.min = "1";
    size.value = disk.capacityGb;
    size.setAttribute("aria-label", "Tamanho do disco em GB");
    size.addEventListener("input", () => {
      disk.capacityGb = Number(size.value || 0);
      updateDiskTotal();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "disk-remove";
    remove.textContent = "x";
    remove.title = "Remover disco";
    remove.addEventListener("click", () => removeDisk(disk.id));

    row.append(name, size, remove);
    list.appendChild(row);
  });

  updateDiskTotal();
}

function updateDiskTotal() {
  const total = vmDisks.reduce((sum, disk) => sum + Number(disk.capacityGb || 0), 0);
  $("#provision-form").diskGb.value = total;
}

function cryptoId() {
  return window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now() + Math.random());
}

function renderFreeSids() {
  const select = $("#free-sid");
  select.innerHTML = `<option value="">Selecione...</option>`;
  for (const item of state.freeSids) {
    const option = document.createElement("option");
    option.value = item.sid;
    option.textContent = item.sid;
    option.dataset.objectId = item.objectId;
    select.appendChild(option);
  }

  const count = state.freeSids.length;
  const status = $("#sid-status");
  if (status) {
    status.textContent = count === 1 ? "1 SID livre encontrado" : `${count} SIDs livres encontrados`;
  }
}

function renderFreeIps() {
  const select = $("#free-ip");
  select.innerHTML = `<option value="">Selecione...</option>`;
  for (const item of state.freeIps) {
    const option = document.createElement("option");
    option.value = item.ip;
    option.textContent = `${item.ip} - ${item.network}`;
    option.dataset.networkId = item.networkId;
    option.dataset.network = item.network;
    select.appendChild(option);
  }

  const count = state.freeIps.length;
  setIpStatus(count === 1 ? "1 IP livre/offline encontrado" : `${count} IPs livres/offline encontrados`);
}

function renderRackTablesNetworks() {
  const select = $("#racktables-network");
  select.innerHTML = `<option value="">Selecione...</option>`;
  for (const item of state.networks) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name ? `${item.prefix} - ${item.name}` : item.prefix;
    option.dataset.prefix = item.prefix;
    select.appendChild(option);
  }

  const count = state.networks.length;
  const status = $("#network-status");
  if (status) {
    status.textContent = count === 1 ? "1 rede encontrada" : `${count} redes encontradas`;
  }
}

function selectedRackTablesId() {
  return $("#create-racktables")?.value || "";
}

function addSelectedTag(event) {
  const value = event.currentTarget.value;
  if (!value) return;
  selectedTagIds.add(value);
  event.currentTarget.value = "";
  renderSelectedTags();
}

function renderSelectedTags() {
  const container = $("#selected-tags");
  const picker = $("#tag-picker");
  if (!container || !picker) return;

  const tagsById = new Map((state.racktables.tags || []).map((tag) => [String(tag.id), tag]));
  container.innerHTML = "";

  for (const id of selectedTagIds) {
    const tag = tagsById.get(String(id));
    if (!tag) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip";
    chip.textContent = `${tag.name} x`;
    chip.addEventListener("click", () => {
      selectedTagIds.delete(String(id));
      renderSelectedTags();
    });
    container.appendChild(chip);
  }

  const selected = new Set([...selectedTagIds].map(String));
  for (const option of picker.options) {
    option.disabled = Boolean(option.value) && selected.has(String(option.value));
  }

  const status = $("#tag-status");
  if (status) {
    const count = selectedTagIds.size;
    status.textContent = count === 1 ? "1 tag selecionada" : `${count} tags selecionadas`;
  }
}

function setIpStatus(text) {
  const status = $("#ip-status");
  if (status) status.textContent = text || "";
}

function updateTemplateStatus(templates) {
  const count = templates?.length || 0;
  const status = $("#template-status");
  if (!status) return;
  status.textContent = count === 1 ? "1 template encontrado" : `${count} templates encontrados`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || body.message || "Erro na requisicao");
  }
  return body;
}

function formJson(form) {
  const data = new FormData(form);
  const object = {};
  for (const [key, value] of data.entries()) {
    if (object[key]) {
      object[key] = Array.isArray(object[key]) ? [...object[key], value] : [object[key], value];
    } else {
      object[key] = value;
    }
  }
  for (const checkbox of form.querySelectorAll("input[type=checkbox]")) {
    object[checkbox.name] = checkbox.checked;
  }
  return object;
}

function fillSelect(select, items, valueKey, labelKey, placeholder = null) {
  const label = typeof labelKey === "function" ? labelKey : (item) => item[labelKey];
  select.innerHTML = "";
  if (placeholder !== null) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.appendChild(option);
  }
  for (const item of items || []) {
    const option = document.createElement("option");
    option.value = item[valueKey] || item.id || "";
    option.textContent = label(item) || item.name || item.id || "";
    select.appendChild(option);
  }
}

function datastoreLabel(item) {
  const free = item.free_space ? bytes(item.free_space) : "livre n/d";
  return `${item.name} (${free})`;
}

function templateLabel(item) {
  const source = item.sourceLabel || item.source || "Template";
  return `${item.name || item.template || item.id || "Template"} - ${source}`;
}

function rackTablesLabel(item) {
  return item.name ? `${item.name} - ${item.baseUrl}` : item.baseUrl;
}

function selectedText(selector) {
  const select = $(selector);
  return select.options[select.selectedIndex]?.textContent || "";
}

function selectedOptionData(selector, key) {
  const select = $(selector);
  const option = select.options[select.selectedIndex];
  return option?.dataset?.[key] || "";
}

function selectedValues(selector) {
  return [...$(selector).selectedOptions].map((option) => option.value).filter(Boolean);
}

function setStatus(selector, text, type) {
  const el = $(selector);
  el.textContent = text || "";
  el.className = `status ${type || ""}`;
}

function bytes(value) {
  const number = Number(value || 0);
  if (!number) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = number;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index < 3 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("pt-BR");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
