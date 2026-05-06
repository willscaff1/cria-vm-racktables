import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const port = Number(process.env.PORT || 3000);

const RACKTABLES = {
  objectTypeVm: "1504",
  attrs: {
    equipeResponsavel: "10002",
    fqdn: "3",
    orgao: "10003",
    osType: "4",
    situacao: "10001",
    solicitante: "10015"
  },
  chapters: {
    equipeResponsavel: "10001",
    orgao: "10002",
    situacao: "10000"
  },
  tags: {
    livre: "12"
  }
};

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  await ensureJson("vcenters.json", []);
  await ensureJson("jobs.json", []);
  await ensureJson("racktables.json", []);

  const server = http.createServer(route);
  server.listen(port, () => {
    console.log(`VM RackTables Provisioner rodando em http://localhost:${port}`);
  });
}

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Erro interno" });
  }
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      vcenterWriteEnabled: process.env.ENABLE_VCENTER_WRITE === "true"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/racktables/config") {
    const configs = await getRackTablesDisplayConfigs();
    sendJson(res, 200, configs.map(maskRackTablesConfig));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/racktables/config/test") {
    const body = await readJsonBody(req);
    const config = normalizeRackTablesConfig(body);
    const result = await testRackTables(config);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/racktables/config") {
    const body = await readJsonBody(req);
    const config = normalizeRackTablesConfig(body);
    const result = await testRackTables(config);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }

    const configs = await getRackTablesStoredConfigs();
    const now = new Date().toISOString();
    const incomingName = requiredText(body.name, "Nome do RackTables");
    const duplicate = configs.find((item) => item.name.toLowerCase() === incomingName.toLowerCase() || item.baseUrl.toLowerCase() === config.baseUrl.toLowerCase());
    if (duplicate) {
      sendJson(res, 409, { error: `RackTables ja cadastrado: ${duplicate.name} (${duplicate.baseUrl})` });
      return;
    }

    const record = {
      id: crypto.randomUUID(),
      name: incomingName,
      ...config,
      createdAt: now,
      updatedAt: now,
      lastTest: { ...result, testedAt: now }
    };

    configs.push(record);
    await saveJson("racktables.json", configs);
    sendJson(res, 201, maskRackTablesConfig(record));
    return;
  }

  const rackTablesTestMatch = url.pathname.match(/^\/api\/racktables\/([^/]+)\/test$/);
  if (req.method === "POST" && rackTablesTestMatch) {
    const configs = await getRackTablesStoredConfigs();
    const config = configs.find((item) => item.id === rackTablesTestMatch[1]);
    if (!config) {
      sendJson(res, 404, { error: "RackTables nao encontrado" });
      return;
    }
    const test = await testRackTables(config);
    config.lastTest = { ...test, testedAt: new Date().toISOString() };
    config.updatedAt = new Date().toISOString();
    await saveJson("racktables.json", configs);
    sendJson(res, test.ok ? 200 : 400, { ...test, racktables: maskRackTablesConfig(config) });
    return;
  }

  const rackTablesDeleteMatch = url.pathname.match(/^\/api\/racktables\/([^/]+)$/);
  if (req.method === "PUT" && rackTablesDeleteMatch) {
    const body = await readJsonBody(req);
    const config = normalizeRackTablesConfig(body);
    const result = await testRackTables(config);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }

    const configs = await getRackTablesStoredConfigs();
    const current = configs.find((item) => item.id === rackTablesDeleteMatch[1]);
    if (!current) {
      sendJson(res, 404, { error: "RackTables nao encontrado" });
      return;
    }

    const incomingName = requiredText(body.name, "Nome do RackTables");
    const duplicate = configs.find((item) =>
      item.id !== current.id &&
      (item.name.toLowerCase() === incomingName.toLowerCase() || item.baseUrl.toLowerCase() === config.baseUrl.toLowerCase())
    );
    if (duplicate) {
      sendJson(res, 409, { error: `RackTables ja cadastrado: ${duplicate.name} (${duplicate.baseUrl})` });
      return;
    }

    Object.assign(current, {
      name: incomingName,
      ...config,
      updatedAt: new Date().toISOString(),
      lastTest: { ...result, testedAt: new Date().toISOString() }
    });
    await saveJson("racktables.json", configs);
    sendJson(res, 200, maskRackTablesConfig(current));
    return;
  }

  if (req.method === "DELETE" && rackTablesDeleteMatch) {
    const configs = await getRackTablesStoredConfigs();
    const next = configs.filter((item) => item.id !== rackTablesDeleteMatch[1]);
    if (next.length === configs.length) {
      sendJson(res, 404, { error: "RackTables nao encontrado" });
      return;
    }
    await saveJson("racktables.json", next);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/racktables/options") {
    const options = await getRackTablesOptions(url.searchParams.get("racktablesId"));
    sendJson(res, 200, options);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/racktables/free-sids") {
    const sids = await getRackTablesFreeSids(url.searchParams.get("racktablesId"));
    sendJson(res, 200, sids);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/racktables/free-ips") {
    const limit = Number(url.searchParams.get("limit") || 300);
    const networkId = url.searchParams.get("networkId");
    const ips = await getRackTablesFreeIps({ limit, networkId, racktablesId: url.searchParams.get("racktablesId") });
    sendJson(res, 200, ips);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/racktables/networks") {
    const networks = await getRackTablesIpv4Networks(url.searchParams.get("racktablesId"));
    sendJson(res, 200, networks);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/vcenters") {
    const vcenters = await loadJson("vcenters.json", []);
    sendJson(res, 200, vcenters.map(maskVcenter));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/vcenters/test") {
    const body = await readJsonBody(req);
    const result = await testVcenter(body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/vcenters") {
    const body = await readJsonBody(req);
    const test = await testVcenter(body);
    if (!test.ok) {
      sendJson(res, 400, test);
      return;
    }

    const vcenters = await loadJson("vcenters.json", []);
    const incomingHost = normalizeHost(requiredText(body.host, "Host/FQDN do vCenter")).toLowerCase();
    const incomingName = requiredText(body.name, "Nome do vCenter").toLowerCase();
    const duplicate = vcenters.find((item) => item.host.toLowerCase() === incomingHost || item.name.toLowerCase() === incomingName);
    if (duplicate) {
      sendJson(res, 409, { error: `vCenter ja cadastrado: ${duplicate.name} (${duplicate.host})` });
      return;
    }

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      name: requiredText(body.name, "Nome do vCenter"),
      host: incomingHost,
      ip: test.ip,
      username: requiredText(body.username, "Usuario do vCenter"),
      password: requiredText(body.password, "Senha do vCenter"),
      insecure: Boolean(body.insecure),
      createdAt: now,
      updatedAt: now,
      lastTest: test
    };

    vcenters.push(record);
    await saveJson("vcenters.json", vcenters);
    sendJson(res, 201, maskVcenter(record));
    return;
  }

  const vcenterTestMatch = url.pathname.match(/^\/api\/vcenters\/([^/]+)\/test$/);
  if (req.method === "POST" && vcenterTestMatch) {
    const vcenters = await loadJson("vcenters.json", []);
    const vcenter = vcenters.find((item) => item.id === vcenterTestMatch[1]);
    if (!vcenter) {
      sendJson(res, 404, { error: "vCenter nao encontrado" });
      return;
    }
    const test = await testVcenter(vcenter);
    vcenter.ip = test.ip || vcenter.ip;
    vcenter.lastTest = test;
    vcenter.updatedAt = new Date().toISOString();
    await saveJson("vcenters.json", vcenters);
    sendJson(res, test.ok ? 200 : 400, { ...test, vcenter: maskVcenter(vcenter) });
    return;
  }

  const vcenterDeleteMatch = url.pathname.match(/^\/api\/vcenters\/([^/]+)$/);
  if (req.method === "PUT" && vcenterDeleteMatch) {
    const body = await readJsonBody(req);
    const test = await testVcenter(body);
    if (!test.ok) {
      sendJson(res, 400, test);
      return;
    }

    const vcenters = await loadJson("vcenters.json", []);
    const current = vcenters.find((item) => item.id === vcenterDeleteMatch[1]);
    if (!current) {
      sendJson(res, 404, { error: "vCenter nao encontrado" });
      return;
    }

    const incomingHost = normalizeHost(requiredText(body.host, "Host/FQDN do vCenter")).toLowerCase();
    const incomingName = requiredText(body.name, "Nome do vCenter").toLowerCase();
    const duplicate = vcenters.find((item) =>
      item.id !== current.id &&
      (item.host.toLowerCase() === incomingHost || item.name.toLowerCase() === incomingName)
    );
    if (duplicate) {
      sendJson(res, 409, { error: `vCenter ja cadastrado: ${duplicate.name} (${duplicate.host})` });
      return;
    }

    Object.assign(current, {
      name: requiredText(body.name, "Nome do vCenter"),
      host: incomingHost,
      ip: test.ip,
      username: requiredText(body.username, "Usuario do vCenter"),
      password: requiredText(body.password, "Senha do vCenter"),
      insecure: Boolean(body.insecure),
      updatedAt: new Date().toISOString(),
      lastTest: test
    });
    await saveJson("vcenters.json", vcenters);
    sendJson(res, 200, maskVcenter(current));
    return;
  }

  if (req.method === "DELETE" && vcenterDeleteMatch) {
    const vcenters = await loadJson("vcenters.json", []);
    const next = vcenters.filter((item) => item.id !== vcenterDeleteMatch[1]);
    if (next.length === vcenters.length) {
      sendJson(res, 404, { error: "vCenter nao encontrado" });
      return;
    }
    await saveJson("vcenters.json", next);
    sendJson(res, 200, { ok: true });
    return;
  }

  const inventoryMatch = url.pathname.match(/^\/api\/vcenters\/([^/]+)\/inventory$/);
  if (req.method === "GET" && inventoryMatch) {
    const vcenter = await findVcenter(inventoryMatch[1]);
    const inventory = await getVcenterInventory(vcenter);
    sendJson(res, 200, inventory);
    return;
  }

  const datastoreFilesMatch = url.pathname.match(/^\/api\/vcenters\/([^/]+)\/datastore-files$/);
  if (req.method === "GET" && datastoreFilesMatch) {
    const vcenter = await findVcenter(datastoreFilesMatch[1]);
    const result = await browseVcenterDatastore(vcenter, {
      datastoreId: url.searchParams.get("datastoreId"),
      folderPath: url.searchParams.get("path")
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    const jobs = await loadJson("jobs.json", []);
    sendJson(res, 200, jobs.map(maskJob));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provision") {
    const body = await readJsonBody(req);
    const result = await provisionVm(body);
    sendJson(res, result.ok ? 201 : 400, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provision/preflight") {
    const body = await readJsonBody(req);
    const result = await preflightProvisionVm(body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  sendJson(res, 404, { error: "Endpoint nao encontrado" });
}

async function preflightProvisionVm(payload) {
  try {
    validateProvisionPayload(payload);
    await validateRackTablesProvisionPreflight(payload);
    const vcenter = await findVcenter(payload.vcenterId);
    const session = await openVcenterSession(vcenter);

    if (payload.deployMode === "template") {
      const templateRef = parseTemplateRef(payload.templateId);
      if (await vcenterVmNameExists(vcenter, session, payload.vm.label)) {
        throw new Error(`Ja existe uma VM chamada '${payload.vm.label}' no vCenter. Use outro label antes de criar.`);
      }
      await validateVcenterClonePreflight(vcenter, session, payload, templateRef);
    }

    return {
      ok: true,
      message: "Preflight OK: vCenter acessivel, nome livre, template encontrado, host conectado e datastore com espaco."
    };
  } catch (error) {
    return { ok: false, error: error.message || "Preflight falhou" };
  }
}

async function provisionVm(payload) {
  validateProvisionPayload(payload);
  await validateRackTablesProvisionPreflight(payload);

  const vcenter = await findVcenter(payload.vcenterId);
  const jobs = await loadJson("jobs.json", []);
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    status: "criando_no_vcenter",
    createdAt: now,
    updatedAt: now,
    request: payload,
    messages: []
  };
  jobs.unshift(job);
  await saveJson("jobs.json", jobs);

  try {
    const vmResult = await createVcenterVm(vcenter, payload);
    job.vcenterResult = vmResult;
    job.messages.push("VM criada com sucesso no vCenter.");

    job.status = "registrando_no_racktables";
    job.updatedAt = new Date().toISOString();
    await saveJson("jobs.json", jobs);

    const rtResult = await createRackTablesVm(payload, vmResult, job);
    job.racktablesResult = rtResult;
    job.status = "concluido";
    job.messages.push("Dados gravados no RackTables.");
    job.updatedAt = new Date().toISOString();
    await saveJson("jobs.json", jobs);

    return { ok: true, job: maskJob(job) };
  } catch (error) {
    job.status = "erro";
    job.error = error.message || "Erro ao provisionar VM";
    job.updatedAt = new Date().toISOString();
    await saveJson("jobs.json", jobs);
    return { ok: false, job: maskJob(job), error: job.error };
  }
}

async function createVcenterVm(vcenter, payload) {
  if (process.env.ENABLE_VCENTER_WRITE !== "true") {
    throw new Error("Criacao real no vCenter bloqueada. Defina ENABLE_VCENTER_WRITE=true depois de validar o vCenter de teste.");
  }

  const session = await openVcenterSession(vcenter);

  if (payload.deployMode === "template") {
    if (!payload.templateId) {
      throw new Error("Selecione um template para criacao por template.");
    }
    if (await vcenterVmNameExists(vcenter, session, payload.vm.label)) {
      throw new Error(`Ja existe uma VM chamada '${payload.vm.label}' no vCenter. Use outro label antes de criar.`);
    }
    const templateRef = parseTemplateRef(payload.templateId);
    await validateVcenterClonePreflight(vcenter, session, payload, templateRef);

    if (templateRef.source === "library") {
      const spec = {
        name: payload.vm.label,
        placement: compactObject({
          cluster: payload.placement.clusterId,
          host: payload.placement.hostId,
          datastore: payload.placement.datastoreId,
          folder: payload.placement.folderId,
          resource_pool: payload.placement.resourcePoolId
        })
      };

      const result = await vcenterJson(
        vcenter,
        session,
        "POST",
        `/api/vcenter/vm-template/library-items/${encodeURIComponent(templateRef.id)}?action=deploy`,
        spec
      );
      return {
        mode: "template",
        templateSource: "library",
        vmId: result?.vm || result?.value || result?.id || null,
        raw: result
      };
    }

    const body = {
      source: templateRef.id,
      name: payload.vm.label,
      placement: compactObject({
        cluster: payload.placement.clusterId,
        host: payload.placement.hostId,
        datastore: payload.placement.datastoreId,
        folder: payload.placement.folderId,
        resource_pool: payload.placement.resourcePoolId
      }),
      hardware: {
        cpu: payload.vm.cpu,
        memoryGb: payload.vm.memoryGb,
        disks: payload.vm.disks || [],
        originalDisks: payload.vm.originalDisks || [],
        network: payload.placement.networkId ? {
          id: payload.placement.networkId,
          name: payload.placement.networkName
        } : null
      }
    };

    const result = await cloneInventoryTemplate(vcenter, session, templateRef.id, body);
    const vmId = result?.vm || result?.value || result?.id || null;
    if (vmId) {
      const postConfig = await configureAndPowerOnVmSoap(vcenter, vmId, body.hardware);
      result.postConfig = postConfig;
    }
    return {
      mode: "template",
      templateSource: "inventory",
      vmId,
      raw: result
    };
  }

  if (payload.deployMode === "iso") {
    const isoPath = requiredText(payload.isoPath, "ISO da VM zerada");
    const body = {
      name: payload.vm.label,
      guest_OS: payload.vm.guestOs || "OTHER_64",
      placement: compactObject({
        cluster: payload.placement.clusterId,
        host: payload.placement.hostId,
        datastore: payload.placement.datastoreId,
        folder: payload.placement.folderId,
        resource_pool: payload.placement.resourcePoolId
      }),
      cpu: { count: Number(payload.vm.cpu || 2) },
      memory: { size_MiB: Number(payload.vm.memoryGb || 4) * 1024 }
    };

    const result = await createEmptyVcenterVm(vcenter, session, body);
    const vmId = result?.vm || result?.value || result?.id || null;
    const cdrom = vmId ? await attachIsoCdromToVm(vcenter, session, vmId, isoPath) : null;
    return {
      mode: "iso",
      vmId,
      isoPath,
      cdrom,
      raw: result
    };
  }

  throw new Error("Modo de criacao invalido.");
}

async function cloneInventoryTemplate(vcenter, session, templateId, spec) {
  // Este vCenter expõe templates de inventario pelo SOAP, mas os endpoints REST de clone
  // retornam 404. Ir direto pelo SOAP evita tentar APIs parcialmente suportadas.
  return await cloneInventoryTemplateSoap(vcenter, templateId, spec);
}

async function createEmptyVcenterVm(vcenter, session, spec) {
  try {
    return await vcenterJson(vcenter, session, "POST", "/api/vcenter/vm", spec);
  } catch (error) {
    if (!isVcenterNotFound(error)) throw error;
  }

  return await vcenterJson(vcenter, session, "POST", "/rest/vcenter/vm", { spec });
}

async function attachIsoCdromToVm(vcenter, session, vmId, isoPath) {
  const spec = {
    start_connected: true,
    allow_guest_control: true,
    backing: {
      type: "ISO_FILE",
      iso_file: isoPath
    }
  };

  try {
    return await vcenterJson(vcenter, session, "POST", `/api/vcenter/vm/${encodeURIComponent(vmId)}/hardware/cdrom`, spec);
  } catch (error) {
    if (!isVcenterNotFound(error)) throw error;
  }

  return await vcenterJson(vcenter, session, "POST", `/rest/vcenter/vm/${encodeURIComponent(vmId)}/hardware/cdrom`, { spec });
}

async function browseVcenterDatastore(vcenter, { datastoreId, folderPath }) {
  const datastoreRef = requiredText(datastoreId, "Datastore da ISO");
  const inventory = await getVcenterInventory(vcenter);
  const datastore = (inventory.datastores || []).find((item) => item.datastore === datastoreRef);
  if (!datastore) {
    throw new Error("Datastore da ISO nao foi encontrado no vCenter. Recarregue o inventario.");
  }

  const pathInDatastore = normalizeDatastorePath(folderPath);
  const datastorePath = pathInDatastore ? `[${datastore.name}] ${pathInDatastore}` : `[${datastore.name}]`;
  const soap = await openSoapSession(vcenter);
  const browser = await getSoapDatastoreBrowser(vcenter, soap, datastoreRef);
  if (!browser) {
    throw new Error("Nao consegui localizar o datastore browser deste datastore no vCenter.");
  }

  const search = await soapRequest(vcenter, soapSearchDatastore(browser, datastorePath), soap.cookie);
  const taskId = parseTaskRef(search.body);
  if (!taskId) throw new Error("vCenter iniciou SearchDatastore_Task, mas nao retornou task id.");

  const resultXml = await waitSoapTaskResultXml(vcenter, soap, taskId, "SearchDatastore_Task");
  const entries = parseDatastoreSearchEntries(resultXml, pathInDatastore);

  return {
    datastoreId: datastoreRef,
    datastoreName: datastore.name,
    path: pathInDatastore,
    datastorePath,
    parentPath: parentDatastorePath(pathInDatastore),
    entries
  };
}

async function vcenterVmNameExists(vcenter, session, name) {
  const encoded = encodeURIComponent(name);
  const paths = [
    `/rest/vcenter/vm?filter.names=${encoded}`,
    `/api/vcenter/vm?names=${encoded}`
  ];

  for (const apiPath of paths) {
    try {
      const result = await vcenterJson(vcenter, session, "GET", apiPath);
      if (Array.isArray(result) && result.some((vm) => vm.name === name)) return true;
    } catch {
      // Some vCenter versions do not support both REST variants.
    }
  }

  return await soapVmNameExists(vcenter, name);
}

async function validateVcenterClonePreflight(vcenter, session, payload, templateRef) {
  if (templateRef.source !== "inventory") return;

  const inventory = await getVcenterInventory(vcenter);
  const hosts = inventory.hosts || [];
  const datastores = inventory.datastores || [];
  const templates = inventory.templates || [];

  const template = templates.find((item) => item.template === templateRef.id || item.id === payload.templateId);
  if (!template) {
    throw new Error(`Template '${payload.templateName || templateRef.id}' nao foi encontrado no inventario do vCenter.`);
  }

  const datastoreId = payload.placement?.datastoreId;
  const datastore = datastores.find((item) => item.datastore === datastoreId);
  if (!datastore) {
    throw new Error("Datastore selecionado nao foi encontrado no vCenter. Recarregue o inventario antes de criar.");
  }

  const requestedDiskGb = Number(payload.vm?.diskGb || 0);
  const requiredBytes = Math.max(requestedDiskGb, 1) * 1024 * 1024 * 1024;
  if (Number(datastore.free_space || 0) < requiredBytes) {
    throw new Error(`Datastore '${datastore.name}' nao tem espaco livre suficiente para ${requestedDiskGb} GB.`);
  }

  const hostId = payload.placement?.hostId;
  if (hostId) {
    const host = hosts.find((item) => item.host === hostId);
    if (!host) {
      throw new Error("Host selecionado nao foi encontrado no vCenter. Recarregue o inventario antes de criar.");
    }
    if (host.connection_state !== "CONNECTED" || host.power_state !== "POWERED_ON") {
      throw new Error(`Host '${host.name || hostId}' nao esta pronto (${host.connection_state || "sem estado"} / ${host.power_state || "sem energia"}).`);
    }
  }
}

function isVcenterNotFound(error) {
  return /vCenter HTTP 404|httpNotFound|NOT_FOUND/i.test(error?.message || "");
}

async function validateRackTablesProvisionPreflight(payload) {
  if (!payload.racktables?.assetTag) return;

  const config = await getRackTablesConfig(payload.racktablesId || payload.racktables.racktablesId);
  let objectId = payload.racktables.objectId || null;
  if (!objectId) {
    objectId = await findRackTablesObjectId(config, payload.racktables.commonName, payload.vm.label);
  }

  const conflict = await findRackTablesObjectByAssetTag(config, payload.racktables.assetTag, objectId);
  if (conflict) {
    throw new Error(`Asset tag/IP '${payload.racktables.assetTag}' ja existe no RackTables no objeto ${conflict.name || conflict.objectId}. Escolha outro IP livre antes de criar.`);
  }
}

async function createRackTablesVm(payload, vmResult, job) {
  const config = await getRackTablesConfig(payload.racktablesId || payload.racktables.racktablesId);
  const comment = buildRackTablesComment(payload, vmResult, job);
  let objectId = payload.racktables.objectId || null;

  if (!objectId) {
    objectId = await findRackTablesObjectId(config, payload.racktables.commonName, payload.vm.label);
  }

  if (!objectId) {
    const createBody = formBody({
      num_records: "1",
      "0_object_type_id": RACKTABLES.objectTypeVm,
      "0_object_name": payload.racktables.commonName,
      "0_object_label": payload.vm.label,
      "0_object_asset_no": payload.racktables.assetTag || ""
    });

    const createResponse = await rackTablesRequest(config, "POST", "/index.php?module=redirect&page=depot&tab=addmore&op=addObjects", createBody);
    assertRackTablesNoError(createResponse, "Criacao do objeto no RackTables");
    objectId = await findRackTablesObjectId(config, payload.racktables.commonName, payload.vm.label);
  }

  if (!objectId) {
    throw new Error("Nao consegui localizar ou criar o objeto VM no RackTables para atualizar atributos.");
  }

  if (payload.racktables.assetTag) {
    const conflict = await findRackTablesObjectByAssetTag(config, payload.racktables.assetTag, objectId);
    if (conflict) {
      throw new Error(`Asset tag/IP '${payload.racktables.assetTag}' ja existe no RackTables no objeto ${conflict.name || conflict.objectId}. Escolha outro IP livre antes de criar.`);
    }
  }

  const updateBody = formBody({
    object_id: objectId,
    object_type_id: RACKTABLES.objectTypeVm,
    object_name: payload.racktables.commonName,
    object_label: payload.vm.label,
    object_asset_no: payload.racktables.assetTag || "",
    object_comment: comment,
    num_attrs: "6",
    "0_attr_id": RACKTABLES.attrs.equipeResponsavel,
    "0_value": payload.racktables.equipeResponsavel || "0",
    "1_attr_id": RACKTABLES.attrs.fqdn,
    "1_value": payload.racktables.fqdn || "",
    "2_attr_id": RACKTABLES.attrs.orgao,
    "2_value": payload.racktables.orgao || "0",
    "3_attr_id": RACKTABLES.attrs.osType,
    "3_value": payload.racktables.osType || "0",
    "4_attr_id": RACKTABLES.attrs.situacao,
    "4_value": payload.racktables.situacao || "0",
    "5_attr_id": RACKTABLES.attrs.solicitante,
    "5_value": payload.racktables.solicitante || "",
    submit_x: "1",
    submit_y: "1"
  });

  const updateResponse = await rackTablesRequest(config, "POST", "/index.php?module=redirect&page=object&tab=edit&op=update", updateBody);
  assertRackTablesNoError(updateResponse, "Atualizacao do objeto no RackTables");

  if (Array.isArray(payload.racktables.tags)) {
    const tagBody = new URLSearchParams();
    tagBody.set("object_id", objectId);
    const finalTags = payload.racktables.tags.filter((tagId) => tagId !== RACKTABLES.tags.livre);
    for (const tagId of finalTags) {
      tagBody.append("taglist[]", tagId);
    }
    tagBody.set("submit.x", "1");
    tagBody.set("submit.y", "1");
    const tagResponse = await rackTablesRequest(config, "POST", "/index.php?module=redirect&page=object&tab=tags&op=saveTags", tagBody.toString());
    assertRackTablesNoError(tagResponse, "Atualizacao de tags no RackTables");
  }

  if (payload.racktables.assetTag) {
    await allocateRackTablesIp(config, objectId, payload.racktables.assetTag);
  }

  return { objectId, ip: payload.racktables.assetTag, comment };
}

function buildRackTablesComment(payload, vmResult, job) {
  const lines = [
    "Provisionado automaticamente",
    "",
    `Job: ${job.id}`,
    `Data da solicitacao: ${new Date(job.createdAt).toLocaleString("pt-BR")}`,
    `Solicitante: ${payload.racktables.solicitante || ""}`,
    `vCenter: ${payload.vcenterName || payload.vcenterId}`,
    `Cluster: ${payload.placement.clusterName || payload.placement.clusterId || ""}`,
    `Host: ${payload.placement.hostName || payload.placement.hostId || ""}`,
    `Datastore: ${payload.placement.datastoreName || payload.placement.datastoreId || ""}`,
    `Rede: ${payload.placement.networkName || payload.placement.networkId || ""}`,
    `Modo de criacao: ${payload.deployMode === "template" ? "Template" : "VM zerada com ISO"}`,
    `Template: ${payload.templateName || payload.templateId || ""}`,
    `ISO: ${payload.isoPath || ""}`,
    `CPU: ${payload.vm.cpu || ""}`,
    `Memoria GB: ${payload.vm.memoryGb || ""}`,
    `Disco GB: ${payload.vm.diskGb || ""}`,
    `IP: ${payload.racktables.assetTag || ""}`,
    `FQDN: ${payload.racktables.fqdn || ""}`,
    `Status: Criado com sucesso`,
    `VM ID vCenter: ${vmResult.vmId || ""}`
  ];

  return lines.join("\n");
}

function parseTemplateRef(value) {
  const text = String(value || "");
  const match = text.match(/^(library|inventory):(.+)$/);
  if (!match) return { source: "inventory", id: text };
  return { source: match[1], id: match[2] };
}

async function testVcenter(input) {
  const host = normalizeHost(requiredText(input.host, "Host/FQDN do vCenter"));
  const username = requiredText(input.username, "Usuario do vCenter");
  const password = requiredText(input.password, "Senha do vCenter");
  const insecure = Boolean(input.insecure);

  try {
    const dns = await lookup(host);
    const session = await openVcenterSession({ host, username, password, insecure });
    return {
      ok: true,
      host,
      ip: dns.address,
      sessionEndpoint: session.endpoint,
      testedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      host,
      error: error.message || "Falha ao testar vCenter",
      testedAt: new Date().toISOString()
    };
  }
}

async function getVcenterInventory(vcenter) {
  const session = await openVcenterSession(vcenter);

  const [datacenters, clusters, hosts, datastores, networks, contentTemplates, inventoryTemplates] = await Promise.allSettled([
    vcenterJson(vcenter, session, "GET", "/rest/vcenter/datacenter"),
    vcenterJson(vcenter, session, "GET", "/rest/vcenter/cluster"),
    vcenterJson(vcenter, session, "GET", "/rest/vcenter/host"),
    vcenterJson(vcenter, session, "GET", "/rest/vcenter/datastore"),
    vcenterJson(vcenter, session, "GET", "/rest/vcenter/network"),
    getContentLibraryTemplates(vcenter, session),
    getInventoryTemplates(vcenter)
  ]);

  const inventory = {
    datacenters: valueOrEmpty(datacenters),
    clusters: valueOrEmpty(clusters),
    hosts: valueOrEmpty(hosts),
    datastores: valueOrEmpty(datastores),
    networks: valueOrEmpty(networks),
    templates: uniqueBy([
      ...valueOrEmpty(contentTemplates),
      ...valueOrEmpty(inventoryTemplates)
    ], "id").sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    templateDiagnostics: {
      contentLibrary: settledSummary(contentTemplates),
      inventory: settledSummary(inventoryTemplates)
    },
    suggestions: {}
  };

  inventory.suggestions.datastore = inventory.datastores
    .filter((item) => Number(item.free_space || 0) > 0)
    .sort((a, b) => Number(b.free_space || 0) - Number(a.free_space || 0))[0] || null;
  inventory.suggestions.host = inventory.hosts.find((item) => item.connection_state === "CONNECTED") || inventory.hosts[0] || null;
  inventory.suggestions.cluster = inventory.clusters[0] || null;

  return inventory;
}

async function openVcenterSession(vcenter) {
  const auth = Buffer.from(`${vcenter.username}:${vcenter.password}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };

  try {
    const oldRest = await rawVcenterRequest(vcenter, "POST", "/rest/com/vmware/cis/session", headers);
    const parsed = parseJsonSafe(oldRest.body);
    return { token: parsed?.value || parsed, header: "vmware-api-session-id", endpoint: "/rest/com/vmware/cis/session" };
  } catch (oldError) {
    const api = await rawVcenterRequest(vcenter, "POST", "/api/session", headers);
    const parsed = parseJsonSafe(api.body);
    return { token: parsed || api.body.replaceAll('"', ""), header: "vmware-api-session-id", endpoint: "/api/session" };
  }
}

async function getContentLibraryTemplates(vcenter, session) {
  const list = await vcenterJson(vcenter, session, "GET", "/api/vcenter/vm-template/library-items");
  const ids = Array.isArray(list)
    ? list.map((item) => typeof item === "string" ? item : item.template || item.id || item.library_item || item)
    : [];

  const details = await Promise.allSettled(ids.map(async (id) => {
    const item = await vcenterJson(vcenter, session, "GET", `/api/content/library/item/${encodeURIComponent(id)}`);
    return {
      id: `library:${id}`,
      template: id,
      name: item?.name || id,
      source: "library",
      sourceLabel: "Content Library"
    };
  }));

  return details.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const id = ids[index];
    return {
      id: `library:${id}`,
      template: id,
      name: id,
      source: "library",
      sourceLabel: "Content Library"
    };
  });
}

async function getInventoryTemplates(vcenter) {
  const soap = await openSoapSession(vcenter);

  const templates = [];
  let response = await soapRequest(vcenter, soapRetrieveTemplates(soap.propertyCollector, soap.rootFolder), soap.cookie);
  templates.push(...parseSoapTemplates(response.body));

  let token = parseSoapText(response.body, "token");
  while (token) {
    response = await soapRequest(vcenter, soapContinueRetrieve(soap.propertyCollector, token), soap.cookie);
    templates.push(...parseSoapTemplates(response.body));
    token = parseSoapText(response.body, "token");
  }

  return uniqueBy(templates, "id");
}

async function soapVmNameExists(vcenter, name) {
  const soap = await openSoapSession(vcenter);
  const target = String(name || "").trim();
  if (!target) return false;

  let response = await soapRequest(vcenter, soapRetrieveVmNames(soap.propertyCollector, soap.rootFolder), soap.cookie);
  if (parseSoapVmNames(response.body).some((vm) => vm.name === target)) return true;

  let token = parseSoapText(response.body, "token");
  while (token) {
    response = await soapRequest(vcenter, soapContinueRetrieve(soap.propertyCollector, token), soap.cookie);
    if (parseSoapVmNames(response.body).some((vm) => vm.name === target)) return true;
    token = parseSoapText(response.body, "token");
  }

  return false;
}

async function openSoapSession(vcenter) {
  const serviceContent = await soapRequest(vcenter, soapRetrieveServiceContent());
  const sessionManager = parseManagedObject(serviceContent.body, "sessionManager") || "SessionManager";
  const propertyCollector = parseManagedObject(serviceContent.body, "propertyCollector") || "propertyCollector";
  const rootFolder = parseManagedObject(serviceContent.body, "rootFolder") || "group-d1";

  const login = await soapRequest(vcenter, soapLogin(sessionManager, vcenter.username, vcenter.password));
  const cookie = login.headers["set-cookie"]?.map((item) => item.split(";")[0]).join("; ");
  return { sessionManager, propertyCollector, rootFolder, cookie };
}

async function cloneInventoryTemplateSoap(vcenter, templateId, spec) {
  const soap = await openSoapSession(vcenter);
  const refs = await getSoapCloneRefs(vcenter, soap, {
    templateId,
    clusterId: spec.placement.cluster,
    hostId: spec.placement.host
  });

  const folder = spec.placement.folder || refs.templateParent;
  if (!folder) throw new Error("Nao consegui identificar a pasta destino para clonar o template no vCenter.");
  if (!refs.resourcePool) throw new Error("Nao consegui identificar o resource pool do cluster/host no vCenter.");

  const clone = await soapRequest(vcenter, soapCloneVm({
    templateId,
    folder,
    name: spec.name,
    resourcePool: refs.resourcePool,
    host: spec.placement.host,
    datastore: spec.placement.datastore
  }), soap.cookie);

  const taskId = parseTaskRef(clone.body);
  if (!taskId) throw new Error("vCenter iniciou CloneVM_Task, mas nao retornou task id.");
  const taskResult = await waitSoapTask(vcenter, soap, taskId, "CloneVM_Task");
  return { vm: taskResult.result || null, task: taskId, value: taskResult.result || taskId };
}

async function getSoapCloneRefs(vcenter, soap, { templateId, clusterId, hostId }) {
  const templateResponse = await soapRequest(vcenter, soapRetrieveObjectProperties(
    soap.propertyCollector,
    "VirtualMachine",
    templateId,
    ["parent"]
  ), soap.cookie);
  const templateParent = parseSoapMorProperty(templateResponse.body, "parent");

  let resourcePool = null;
  if (clusterId) {
    const clusterResponse = await soapRequest(vcenter, soapRetrieveObjectProperties(
      soap.propertyCollector,
      "ClusterComputeResource",
      clusterId,
      ["resourcePool"]
    ), soap.cookie);
    resourcePool = parseSoapMorProperty(clusterResponse.body, "resourcePool");
  }

  if (!resourcePool && hostId) {
    const hostResponse = await soapRequest(vcenter, soapRetrieveObjectProperties(
      soap.propertyCollector,
      "HostSystem",
      hostId,
      ["parent"]
    ), soap.cookie);
    const parentCompute = parseSoapMorProperty(hostResponse.body, "parent");
    if (parentCompute) {
      const computeResponse = await soapRequest(vcenter, soapRetrieveObjectProperties(
        soap.propertyCollector,
        "ComputeResource",
        parentCompute,
        ["resourcePool"]
      ), soap.cookie);
      resourcePool = parseSoapMorProperty(computeResponse.body, "resourcePool");
    }
  }

  return { templateParent, resourcePool };
}

async function getSoapDatastoreBrowser(vcenter, soap, datastoreId) {
  const response = await soapRequest(vcenter, soapRetrieveObjectProperties(
    soap.propertyCollector,
    "Datastore",
    datastoreId,
    ["browser"]
  ), soap.cookie);
  return parseSoapMorProperty(response.body, "browser");
}

async function configureAndPowerOnVmSoap(vcenter, vmId, hardware = {}) {
  const soap = await openSoapSession(vcenter);
  const vmConfig = await getSoapVmConfig(vcenter, soap, vmId);
  const reconfigXml = soapReconfigVm(vmId, {
    cpu: hardware.cpu,
    memoryGb: hardware.memoryGb,
    network: hardware.network,
    disks: hardware.disks || [],
    originalDisks: hardware.originalDisks || [],
    current: vmConfig
  });

  let reconfigTask = null;
  if (reconfigXml) {
    const reconfig = await soapRequest(vcenter, reconfigXml, soap.cookie);
    reconfigTask = parseTaskRef(reconfig.body);
    if (!reconfigTask) throw new Error("vCenter iniciou ReconfigVM_Task, mas nao retornou task id.");
    await waitSoapTask(vcenter, soap, reconfigTask, "ReconfigVM_Task");
  }

  const power = await soapRequest(vcenter, soapPowerOnVm(vmId), soap.cookie);
  const powerTask = parseTaskRef(power.body);
  if (!powerTask) throw new Error("vCenter iniciou PowerOnVM_Task, mas nao retornou task id.");
  await waitSoapTask(vcenter, soap, powerTask, "PowerOnVM_Task");

  return { reconfigTask, powerTask };
}

async function getSoapVmConfig(vcenter, soap, vmId) {
  const response = await soapRequest(vcenter, soapRetrieveObjectProperties(
    soap.propertyCollector,
    "VirtualMachine",
    vmId,
    ["config.hardware.device", "config.hardware.numCPU", "config.hardware.memoryMB"]
  ), soap.cookie);
  return parseSoapVmConfig(response.body);
}

function soapRequest(vcenter, body, cookie = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: vcenter.host,
      port: 443,
      method: "POST",
      path: "/sdk",
      rejectUnauthorized: !vcenter.insecure,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "urn:vim25/6.7",
        "Content-Length": Buffer.byteLength(body),
        ...(cookie ? { Cookie: cookie } : {})
      },
      timeout: 20000
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => responseBody += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: responseBody, headers: res.headers });
          return;
        }
        reject(new Error(`vCenter SOAP HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
      });
    });

    req.on("timeout", () => req.destroy(new Error("Timeout no SOAP do vCenter")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function soapEnvelope(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soapenv:Body>${inner}</soapenv:Body>
</soapenv:Envelope>`;
}

function soapRetrieveServiceContent() {
  return soapEnvelope(`
    <RetrieveServiceContent xmlns="urn:vim25">
      <_this type="ServiceInstance">ServiceInstance</_this>
    </RetrieveServiceContent>`);
}

function soapLogin(sessionManager, username, password) {
  return soapEnvelope(`
    <Login xmlns="urn:vim25">
      <_this type="SessionManager">${escapeXml(sessionManager)}</_this>
      <userName>${escapeXml(username)}</userName>
      <password>${escapeXml(password)}</password>
    </Login>`);
}

function soapRetrieveTemplates(propertyCollector, rootFolder) {
  return soapEnvelope(`
    <RetrievePropertiesEx xmlns="urn:vim25">
      <_this type="PropertyCollector">${escapeXml(propertyCollector)}</_this>
      <specSet>
        <propSet>
          <type>VirtualMachine</type>
          <pathSet>name</pathSet>
          <pathSet>config.template</pathSet>
          <pathSet>config.uuid</pathSet>
          <pathSet>config.guestId</pathSet>
          <pathSet>config.guestFullName</pathSet>
          <pathSet>config.hardware.numCPU</pathSet>
          <pathSet>config.hardware.memoryMB</pathSet>
          <pathSet>config.hardware.device</pathSet>
        </propSet>
        <objectSet>
          <obj type="Folder">${escapeXml(rootFolder)}</obj>
          <skip>false</skip>
          <selectSet xsi:type="TraversalSpec">
            <name>visitFolders</name>
            <type>Folder</type>
            <path>childEntity</path>
            <skip>false</skip>
            <selectSet>
              <name>visitFolders</name>
            </selectSet>
            <selectSet>
              <name>dcToVmFolder</name>
            </selectSet>
            <selectSet>
              <name>vAppToVm</name>
            </selectSet>
          </selectSet>
          <selectSet xsi:type="TraversalSpec">
            <name>dcToVmFolder</name>
            <type>Datacenter</type>
            <path>vmFolder</path>
            <skip>false</skip>
            <selectSet>
              <name>visitFolders</name>
            </selectSet>
            <selectSet>
              <name>vAppToVm</name>
            </selectSet>
          </selectSet>
          <selectSet xsi:type="TraversalSpec">
            <name>vAppToVm</name>
            <type>VirtualApp</type>
            <path>vm</path>
            <skip>false</skip>
          </selectSet>
        </objectSet>
      </specSet>
      <options/>
    </RetrievePropertiesEx>`);
}

function soapContinueRetrieve(propertyCollector, token) {
  return soapEnvelope(`
    <ContinueRetrievePropertiesEx xmlns="urn:vim25">
      <_this type="PropertyCollector">${escapeXml(propertyCollector)}</_this>
      <token>${escapeXml(token)}</token>
    </ContinueRetrievePropertiesEx>`);
}

function soapRetrieveVmNames(propertyCollector, rootFolder) {
  return soapEnvelope(`
    <RetrievePropertiesEx xmlns="urn:vim25">
      <_this type="PropertyCollector">${escapeXml(propertyCollector)}</_this>
      <specSet>
        <propSet>
          <type>VirtualMachine</type>
          <pathSet>name</pathSet>
          <pathSet>config.template</pathSet>
        </propSet>
        <objectSet>
          <obj type="Folder">${escapeXml(rootFolder)}</obj>
          <skip>false</skip>
          <selectSet xsi:type="TraversalSpec">
            <name>visitFolders</name>
            <type>Folder</type>
            <path>childEntity</path>
            <skip>false</skip>
            <selectSet>
              <name>visitFolders</name>
            </selectSet>
            <selectSet>
              <name>dcToVmFolder</name>
            </selectSet>
            <selectSet>
              <name>vAppToVm</name>
            </selectSet>
          </selectSet>
          <selectSet xsi:type="TraversalSpec">
            <name>dcToVmFolder</name>
            <type>Datacenter</type>
            <path>vmFolder</path>
            <skip>false</skip>
            <selectSet>
              <name>visitFolders</name>
            </selectSet>
            <selectSet>
              <name>vAppToVm</name>
            </selectSet>
          </selectSet>
          <selectSet xsi:type="TraversalSpec">
            <name>vAppToVm</name>
            <type>VirtualApp</type>
            <path>vm</path>
            <skip>false</skip>
          </selectSet>
        </objectSet>
      </specSet>
      <options/>
    </RetrievePropertiesEx>`);
}

function soapRetrieveObjectProperties(propertyCollector, type, value, paths) {
  return soapEnvelope(`
    <RetrievePropertiesEx xmlns="urn:vim25">
      <_this type="PropertyCollector">${escapeXml(propertyCollector)}</_this>
      <specSet>
        <propSet>
          <type>${escapeXml(type)}</type>
          ${paths.map((item) => `<pathSet>${escapeXml(item)}</pathSet>`).join("")}
        </propSet>
        <objectSet>
          <obj type="${escapeXml(type)}">${escapeXml(value)}</obj>
          <skip>false</skip>
        </objectSet>
      </specSet>
      <options/>
    </RetrievePropertiesEx>`);
}

function soapSearchDatastore(browser, datastorePath) {
  return soapEnvelope(`
    <SearchDatastore_Task xmlns="urn:vim25">
      <_this type="HostDatastoreBrowser">${escapeXml(browser)}</_this>
      <datastorePath>${escapeXml(datastorePath)}</datastorePath>
      <searchSpec>
        <details>
          <fileType>true</fileType>
          <fileSize>true</fileSize>
          <modification>true</modification>
          <fileOwner>false</fileOwner>
        </details>
      </searchSpec>
    </SearchDatastore_Task>`);
}

function soapCloneVm({ templateId, folder, name, resourcePool, host, datastore }) {
  return soapEnvelope(`
    <CloneVM_Task xmlns="urn:vim25">
      <_this type="VirtualMachine">${escapeXml(templateId)}</_this>
      <folder type="Folder">${escapeXml(folder)}</folder>
      <name>${escapeXml(name)}</name>
      <spec>
        <location>
          <datastore type="Datastore">${escapeXml(datastore)}</datastore>
          <diskMoveType>moveAllDiskBackingsAndDisallowSharing</diskMoveType>
          <pool type="ResourcePool">${escapeXml(resourcePool)}</pool>
        </location>
        <template xsi:type="xsd:boolean">false</template>
        <powerOn xsi:type="xsd:boolean">false</powerOn>
      </spec>
    </CloneVM_Task>`);
}

function soapReconfigVm(vmId, { cpu, memoryGb, network, disks, originalDisks, current }) {
  const cpuValue = Number(cpu || 0);
  const memoryMbValue = Number(memoryGb || 0) * 1024;
  const cpuXml = cpuValue && cpuValue !== Number(current.cpu || 0) ? `<numCPUs>${cpuValue}</numCPUs>` : "";
  const memoryXml = memoryMbValue && memoryMbValue !== Number(current.memoryMb || 0) ? `<memoryMB>${memoryMbValue}</memoryMB>` : "";
  const deviceChanges = [
    networkNeedsChange(network, current.nic) ? soapNetworkDeviceChange(network, current.nic) : "",
    soapDiskDeviceChanges(disks, originalDisks, current.disks)
  ].filter(Boolean).join("");

  const hasConfig = cpuXml || memoryXml || deviceChanges;
  if (!hasConfig) return null;

  return soapEnvelope(`
    <ReconfigVM_Task xmlns="urn:vim25">
      <_this type="VirtualMachine">${escapeXml(vmId)}</_this>
      <spec>
        ${cpuXml}
        ${memoryXml}
        ${deviceChanges}
      </spec>
    </ReconfigVM_Task>`);
}

function soapPowerOnVm(vmId) {
  return soapEnvelope(`
    <PowerOnVM_Task xmlns="urn:vim25">
      <_this type="VirtualMachine">${escapeXml(vmId)}</_this>
    </PowerOnVM_Task>`);
}

function soapNetworkDeviceChange(network, nic) {
  if (!nic?.key) return "";
  return `
    <deviceChange>
      <operation>edit</operation>
      <device xsi:type="${escapeXml(nic.type || "VirtualVmxnet3")}">
        <key>${escapeXml(nic.key)}</key>
        <backing xsi:type="VirtualEthernetCardNetworkBackingInfo">
          <deviceName>${escapeXml(network.name || "")}</deviceName>
          <network type="Network">${escapeXml(network.id || "")}</network>
        </backing>
        <connectable>
          <startConnected>true</startConnected>
          <allowGuestControl>true</allowGuestControl>
          <connected>false</connected>
        </connectable>
      </device>
    </deviceChange>`;
}

function networkNeedsChange(network, nic) {
  if (!network?.id && !network?.name) return false;
  if (!nic?.key) return false;
  if (network.id && nic.networkId && network.id === nic.networkId) return false;
  if (network.name && nic.networkName && network.name === nic.networkName) return false;
  return true;
}

function soapDiskDeviceChanges(disks, originalDisks, currentDisks) {
  if (!Array.isArray(disks)) return "";
  const changes = [];
  const requestedIds = new Set(disks.map((disk) => String(disk.id || "")).filter(Boolean));
  const originalIds = new Set((originalDisks || []).map((disk) => String(disk.id || "")).filter(Boolean));

  for (const disk of currentDisks || []) {
    if (originalIds.has(String(disk.id)) && !requestedIds.has(String(disk.id))) {
      changes.push(`
        <deviceChange>
          <operation>remove</operation>
          <fileOperation>destroy</fileOperation>
          <device xsi:type="VirtualDisk">
            <key>${escapeXml(disk.id)}</key>
          </device>
        </deviceChange>`);
    }
  }

  disks.forEach((disk, index) => {
    const key = Number(disk.id);
    const capacityKb = Number(disk.capacityGb || 0) * 1024 * 1024;
    if (Number.isFinite(key) && key > 0) {
      const currentDisk = (currentDisks || []).find((item) => String(item.id) === String(key));
      if (currentDisk && Number(currentDisk.capacityGb || 0) === Number(disk.capacityGb || 0)) {
        return;
      }
      changes.push(`
        <deviceChange>
          <operation>edit</operation>
          <device xsi:type="VirtualDisk">
            <key>${key}</key>
            <capacityInKB>${capacityKb}</capacityInKB>
          </device>
        </deviceChange>`);
      return;
    }

    changes.push(`
      <deviceChange>
        <operation>add</operation>
        <fileOperation>create</fileOperation>
        <device xsi:type="VirtualDisk">
          <key>-${index + 100}</key>
          <controllerKey>1000</controllerKey>
          <unitNumber>${findFreeDiskUnit(currentDisks, index)}</unitNumber>
          <capacityInKB>${capacityKb}</capacityInKB>
          <backing xsi:type="VirtualDiskFlatVer2BackingInfo">
            <diskMode>persistent</diskMode>
            <thinProvisioned>true</thinProvisioned>
          </backing>
        </device>
      </deviceChange>`);
  });

  return changes.join("");
}

function soapRetrieveTaskInfo(propertyCollector, taskId) {
  return soapRetrieveObjectProperties(propertyCollector, "Task", taskId, ["info.state", "info.error", "info.result"]);
}

function parseManagedObject(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([^<]+)</${name}>`, "i"));
  return match?.[1] || null;
}

function parseSoapMorProperty(xml, propertyName) {
  const prop = findSoapPropSet(xml, propertyName);
  if (!prop) return null;
  const valMatch = prop.match(/<val[^>]*>([^<]+)<\/val>/i);
  return valMatch?.[1] || null;
}

function findSoapPropSet(xml, propertyName) {
  const propSets = xml.match(/<propSet\b[\s\S]*?<\/propSet>/gi) || [];
  return propSets.find((propSet) => parseSoapText(propSet, "name") === propertyName) || null;
}

function parseTaskRef(xml) {
  const match = xml.match(/<returnval[^>]*type="Task"[^>]*>([^<]+)<\/returnval>/i);
  return match?.[1] || null;
}

async function waitSoapTask(vcenter, soap, taskId, operation = "Task") {
  const started = Date.now();
  while (Date.now() - started < 20 * 60 * 1000) {
    const response = await soapRequest(vcenter, soapRetrieveTaskInfo(soap.propertyCollector, taskId), soap.cookie);
    const state = parseSoapPropertyText(response.body, "info.state");
    if (state === "success") {
      return { state, result: parseSoapMorProperty(response.body, "info.result") };
    }
    if (state === "error") {
      const message = parseSoapFaultMessage(response.body) || parseSoapPropertyText(response.body, "info.error") || `${operation} falhou no vCenter.`;
      throw new Error(`vCenter ${operation} falhou: ${message}`);
    }
    await delay(3000);
  }
  throw new Error(`Timeout aguardando ${operation} finalizar no vCenter.`);
}

async function waitSoapTaskResultXml(vcenter, soap, taskId, operation = "Task") {
  const started = Date.now();
  while (Date.now() - started < 20 * 60 * 1000) {
    const response = await soapRequest(vcenter, soapRetrieveTaskInfo(soap.propertyCollector, taskId), soap.cookie);
    const state = parseSoapPropertyText(response.body, "info.state");
    if (state === "success") {
      return findSoapPropSet(response.body, "info.result") || response.body;
    }
    if (state === "error") {
      const message = parseSoapFaultMessage(response.body) || parseSoapPropertyText(response.body, "info.error") || `${operation} falhou no vCenter.`;
      throw new Error(`vCenter ${operation} falhou: ${message}`);
    }
    await delay(1000);
  }
  throw new Error(`Timeout aguardando ${operation} finalizar no vCenter.`);
}

function parseSoapPropertyText(xml, propertyName) {
  const prop = findSoapPropSet(xml, propertyName);
  if (!prop) return null;
  return parseSoapText(prop, "val");
}

function parseSoapFaultMessage(xml) {
  const localized = xml.match(/<localizedMessage[^>]*>([^<]+)<\/localizedMessage>/i);
  if (localized?.[1]) return localized[1];
  const fault = xml.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
  if (fault?.[1]) return fault[1];
  return null;
}

function parseSoapText(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([^<]+)</${name}>`, "i"));
  return match?.[1] || null;
}

function parseSoapTemplates(xml) {
  const objects = xml.match(/<objects\b[\s\S]*?<\/objects>/gi) || [];
  return objects.map((objectXml) => {
    const objMatch = objectXml.match(/<obj[^>]*type="VirtualMachine"[^>]*>([^<]+)<\/obj>/i);
    if (!objMatch) return null;

    const props = {};
    const propSets = objectXml.match(/<propSet\b[\s\S]*?<\/propSet>/gi) || [];
    for (const propSet of propSets) {
      const name = parseSoapText(propSet, "name");
      const value = parseSoapText(propSet, "val");
      if (name) props[name] = value || "";
    }

    if (props["config.template"] !== "true") return null;

    const vmId = objMatch[1];
    return {
      id: `inventory:${vmId}`,
      template: vmId,
      name: props.name || vmId,
      uuid: props["config.uuid"] || "",
      guestId: props["config.guestId"] || "",
      guestFullName: props["config.guestFullName"] || "",
      osTypeId: mapRackTablesOsType(props["config.guestFullName"] || props["config.guestId"] || props.name || ""),
      cpu: Number(props["config.hardware.numCPU"] || 0),
      memoryGb: props["config.hardware.memoryMB"] ? Math.round(Number(props["config.hardware.memoryMB"]) / 1024) : 0,
      disks: parseSoapDisks(objectXml),
      source: "inventory",
      sourceLabel: "Inventario vCenter"
    };
  }).filter(Boolean);
}

function parseSoapVmNames(xml) {
  const objects = xml.match(/<objects\b[\s\S]*?<\/objects>/gi) || [];
  return objects.map((objectXml) => {
    const objMatch = objectXml.match(/<obj[^>]*type="VirtualMachine"[^>]*>([^<]+)<\/obj>/i);
    if (!objMatch) return null;

    const props = {};
    const propSets = objectXml.match(/<propSet\b[\s\S]*?<\/propSet>/gi) || [];
    for (const propSet of propSets) {
      const name = parseSoapText(propSet, "name");
      const value = parseSoapText(propSet, "val");
      if (name) props[name] = value || "";
    }

    return {
      id: objMatch[1],
      name: props.name || "",
      template: props["config.template"] === "true"
    };
  }).filter(Boolean);
}

function parseDatastoreSearchEntries(xml, currentPath = "") {
  const files = String(xml).match(/<file\b[\s\S]*?<\/file>/gi) || [];
  const entries = files.map((fileXml) => {
    const rawName = decodeXmlText(parseSoapText(fileXml, "path") || "");
    const name = rawName.replace(/^\/+|\/+$/g, "");
    if (!name || name === "." || name === "..") return null;

    const typeMatch = fileXml.match(/(?:xsi:type|type)=["']([^"']+)["']/i);
    const soapType = typeMatch?.[1] || "";
    const isFolder = /FolderFileInfo/i.test(soapType);
    const isIso = /IsoImageFileInfo/i.test(soapType) || /\.iso$/i.test(name);
    if (!isFolder && !isIso) return null;

    return {
      name,
      path: joinDatastorePath(currentPath, name),
      type: isFolder ? "folder" : "iso",
      size: Number(parseSoapText(fileXml, "fileSize") || 0),
      modifiedAt: parseSoapText(fileXml, "modification") || null
    };
  }).filter(Boolean);

  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, "pt-BR", { numeric: true });
  });
}

function normalizeDatastorePath(value) {
  const clean = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
  const parts = [];
  for (const part of clean.split("/")) {
    const item = part.trim();
    if (!item || item === ".") continue;
    if (item === "..") {
      parts.pop();
      continue;
    }
    parts.push(item);
  }
  return parts.join("/");
}

function joinDatastorePath(base, name) {
  return [normalizeDatastorePath(base), normalizeDatastorePath(name)].filter(Boolean).join("/");
}

function parentDatastorePath(value) {
  const parts = normalizeDatastorePath(value).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function parseSoapDisks(objectXml) {
  const devicesProp = findSoapPropSet(objectXml, "config.hardware.device");
  if (!devicesProp) return [];

  const disks = [];
  const diskMatches = devicesProp.match(/<VirtualDevice[^>]+(?:xsi:type|type)=["'][^"']*VirtualDisk["'][^>]*>[\s\S]*?<\/VirtualDevice>/gi) || [];
  for (const diskXml of diskMatches) {
    const key = parseSoapText(diskXml, "key") || crypto.randomUUID();
    const capacityKb = Number(parseSoapText(diskXml, "capacityInKB") || 0);
    const capacityGb = capacityKb ? Math.round(capacityKb / 1024 / 1024) : 0;
    disks.push({
      id: String(key),
      label: parseSoapDiskLabel(diskXml) || `Disco ${disks.length + 1}`,
      capacityGb,
      unitNumber: Number(parseSoapText(diskXml, "unitNumber") || disks.length)
    });
  }
  return disks;
}

function parseSoapVmConfig(xml) {
  const devicesProp = findSoapPropSet(xml, "config.hardware.device");
  const cpu = Number(parseSoapPropertyText(xml, "config.hardware.numCPU") || 0);
  const memoryMb = Number(parseSoapPropertyText(xml, "config.hardware.memoryMB") || 0);
  if (!devicesProp) return { cpu, memoryMb, disks: [], nic: null };

  const disks = parseSoapDisks(xml);
  const nicMatches = devicesProp.match(/<VirtualDevice[^>]+(?:xsi:type|type)=["']([^"']*Virtual(?:Vmxnet3|E1000e|E1000|EthernetCard)[^"']*)["'][^>]*>[\s\S]*?<\/VirtualDevice>/gi) || [];
  const nicXml = nicMatches[0] || "";
  const typeMatch = nicXml.match(/(?:xsi:type|type)=["']([^"']+)["']/i);
  const key = parseSoapText(nicXml, "key");
  const networkIdMatch = nicXml.match(/<network[^>]*type=["']Network["'][^>]*>([^<]+)<\/network>/i);
  const networkName = parseSoapText(nicXml, "deviceName");
  return {
    cpu,
    memoryMb,
    disks,
    nic: key ? {
      key,
      type: typeMatch?.[1] || "VirtualVmxnet3",
      networkId: networkIdMatch?.[1] || "",
      networkName: networkName || ""
    } : null
  };
}

function findFreeDiskUnit(currentDisks, fallback) {
  const used = new Set((currentDisks || []).map((disk) => Number(disk.unitNumber)).filter((unit) => Number.isFinite(unit)));
  for (let unit = 0; unit < 15; unit += 1) {
    if (unit === 7) continue;
    if (!used.has(unit)) return unit;
  }
  return fallback;
}

function parseSoapDiskLabel(diskXml) {
  const match = diskXml.match(/<deviceInfo\b[\s\S]*?<label[^>]*>([^<]+)<\/label>/i);
  return match?.[1] || null;
}

function mapRackTablesOsType(value) {
  const text = String(value || "").toLowerCase();
  const rules = [
    [/alma/i, "3780"],
    [/alma.*8|almalinux.*8|almaLinux.*8/i, "3780"],
    [/centos.*8/i, "3778"],
    [/centos.*7/i, "2404"],
    [/oracle.*10/i, "50126"],
    [/oracle.*9/i, "3779"],
    [/oracle.*8/i, "3782"],
    [/oracle.*7/i, "3781"],
    [/rhel.*8|red hat.*8/i, "3779"],
    [/rhel.*7|red hat.*7/i, "2143"],
    [/windows.*2025/i, "50126"],
    [/windows.*2022/i, "50126"],
    [/windows.*2019/i, "50100"],
    [/windows.*2016/i, "2707"],
    [/windows.*2012.*r2/i, "2064"],
    [/windows.*2012/i, "2063"],
    [/windows.*11/i, "3790"],
    [/windows.*10/i, "3790"]
  ];

  for (const [pattern, id] of rules) {
    if (pattern.test(text)) return id;
  }
  return "0";
}

async function vcenterJson(vcenter, session, method, apiPath, body = null) {
  const headers = {
    [session.header]: session.token,
    Accept: "application/json"
  };
  const raw = await rawVcenterRequest(vcenter, method, apiPath, headers, body ? JSON.stringify(body) : null);
  const parsed = parseJsonSafe(raw.body);
  if (parsed && Object.hasOwn(parsed, "value")) {
    return parsed.value;
  }
  return parsed;
}

function rawVcenterRequest(vcenter, method, apiPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: vcenter.host,
      port: 443,
      method,
      path: apiPath,
      rejectUnauthorized: !vcenter.insecure,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": body ? Buffer.byteLength(body) : 0
      },
      timeout: 15000
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => responseBody += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: responseBody, headers: res.headers });
          return;
        }
        reject(new Error(`vCenter HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
      });
    });

    req.on("timeout", () => req.destroy(new Error("Timeout conectando ao vCenter")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getRackTablesOptions(racktablesId = null) {
  const config = await getRackTablesConfig(racktablesId);
  const [equipe, orgao, situacao, tagPage] = await Promise.all([
    getRackTablesChapter(config, RACKTABLES.chapters.equipeResponsavel),
    getRackTablesChapter(config, RACKTABLES.chapters.orgao),
    getRackTablesChapter(config, RACKTABLES.chapters.situacao),
    rackTablesRequest(config, "GET", "/index.php?page=tagtree")
  ]);

  return {
    equipeResponsavel: equipe,
    orgaos: orgao,
    situacoes: situacao,
    tags: parseRackTablesTags(tagPage.body)
  };
}

async function getRackTablesFreeSids(racktablesId = null) {
  const config = await getRackTablesConfig(racktablesId);
  const page = await rackTablesRequest(
    config,
    "GET",
    `/index.php?page=depot&tab=default&cft[]=${RACKTABLES.tags.livre}&cfe=%7B%24typeid_${RACKTABLES.objectTypeVm}%7D`
  );
  return parseRackTablesFreeSids(page.body);
}

async function getRackTablesIpv4Networks(racktablesId = null) {
  const config = await getRackTablesConfig(racktablesId);
  const networksPage = await rackTablesRequest(config, "GET", "/index.php?page=ipv4space&tab=default");
  return parseRackTablesIpv4Networks(networksPage.body)
    .sort((a, b) => a.prefix.localeCompare(b.prefix, "pt-BR", { numeric: true }));
}

async function getRackTablesFreeIps({ limit = 300, networkId = null, racktablesId = null } = {}) {
  const config = await getRackTablesConfig(racktablesId);
  let networks = [];

  if (networkId) {
    const allNetworks = await getRackTablesIpv4Networks(racktablesId);
    const selected = allNetworks.find((network) => network.id === String(networkId));
    if (!selected) throw new Error("Rede IPv4 nao encontrada no RackTables.");
    networks = [selected];
  } else {
    networks = (await getRackTablesIpv4Networks(racktablesId)).filter((network) => network.prefixLength >= 23);
  }

  const candidates = [];
  for (const network of networks) {
    if (candidates.length >= limit * 2) break;
    const page = await rackTablesRequest(config, "GET", `/index.php?page=ipv4net&id=${encodeURIComponent(network.id)}`);
    const freeInNetwork = parseRackTablesFreeIpsFromNetwork(page.body, network);
    candidates.push(...freeInNetwork);
  }

  const uniqueCandidates = uniqueBy(candidates, "ip").slice(0, limit * 2);
  const usedAssetTags = await getRackTablesUsedAssetTags(config);
  const checked = await mapWithConcurrency(uniqueCandidates, 12, async (item) => {
    const ping = await systemPing(item.ip);
    return { ...item, ping };
  });

  return checked
    .filter((item) => item.ping && item.ping.online === false)
    .filter((item) => !usedAssetTags.has(item.ip))
    .slice(0, limit)
    .sort((a, b) => a.ip.localeCompare(b.ip, "pt-BR", { numeric: true }));
}

async function getRackTablesChapter(config, chapterNo) {
  const page = await rackTablesRequest(config, "GET", `/index.php?page=chapter&chapter_no=${encodeURIComponent(chapterNo)}`);
  return parseRackTablesChapter(page.body);
}

async function testRackTables(config) {
  try {
    const result = await rackTablesRequest(config, "GET", "/index.php?page=config");
    const ok = /RackTables|Configuration/i.test(result.body);
    return {
      ok,
      statusCode: result.statusCode,
      message: ok ? "Conexao RackTables OK" : "Autenticou, mas a pagina nao parece RackTables"
    };
  } catch (error) {
    return { ok: false, error: error.message || "Falha no RackTables" };
  }
}

async function rackTablesRequest(config, method, apiPath, body = null, redirectCount = 0) {
  const base = new URL(config.baseUrl);
  const target = new URL(apiPath, base);
  const client = target.protocol === "https:" ? https : http;
  const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");

  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": body ? Buffer.byteLength(body) : 0
      },
      timeout: 15000
    }, async (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => responseBody += chunk);
      res.on("end", async () => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
          try {
            const redirected = await rackTablesRequest(config, "GET", res.headers.location, null, redirectCount + 1);
            resolve(redirected);
          } catch (error) {
            reject(error);
          }
          return;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: responseBody, headers: res.headers });
          return;
        }

        reject(new Error(`RackTables HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
      });
    });

    req.on("timeout", () => req.destroy(new Error("Timeout conectando ao RackTables")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function findRackTablesObjectId(config, commonName, label) {
  const page = await rackTablesRequest(config, "GET", "/index.php?page=depot&tab=default&cfe=%7B%24typeid_1504%7D");
  const rows = page.body.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const text = cleanHtml(row);
    if (text.includes(commonName) || text.includes(label)) {
      const match = row.match(/page=object(?:&amp;|&)object_id=(\d+)|object_id=(\d+)(?:&amp;|&)page=object/i);
      if (match) return match[1] || match[2];
    }
  }
  return null;
}

async function findRackTablesObjectByAssetTag(config, assetTag, exceptObjectId = null) {
  const tag = String(assetTag || "").trim();
  if (!tag) return null;

  const page = await rackTablesRequest(config, "GET", "/index.php?page=depot&tab=default&cfe=%7B%24typeid_1504%7D");
  const rows = page.body.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const text = cleanHtml(row);
    if (!text.includes(tag)) continue;

    const match = row.match(/page=object(?:&amp;|&)object_id=(\d+)|object_id=(\d+)(?:&amp;|&)page=object/i);
    const objectId = match ? match[1] || match[2] : null;
    if (exceptObjectId && objectId && String(objectId) === String(exceptObjectId)) continue;

    const nameMatch = row.match(/<a[^>]+href=['"][^'"]*page=object[^'"]*['"][^>]*>([\s\S]*?)<\/a>/i);
    return {
      objectId,
      name: cleanHtml(nameMatch?.[1] || text)
    };
  }

  return null;
}

async function getRackTablesUsedAssetTags(config) {
  const page = await rackTablesRequest(config, "GET", "/index.php?page=depot&tab=default&cfe=%7B%24typeid_1504%7D");
  const rows = page.body.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const tags = new Set();
  for (const row of rows) {
    const text = cleanHtml(row);
    for (const match of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
      tags.add(match[0]);
    }
  }
  return tags;
}

async function allocateRackTablesIp(config, objectId, ip) {
  const body = formBody({
    ip,
    object_id: objectId,
    bond_name: "eth0",
    bond_type: "regular"
  });
  const response = await rackTablesRequest(config, "POST", "/index.php?module=redirect&page=ipaddress&tab=assignment&op=add", body);
  assertRackTablesNoError(response, "Alocacao de IP no RackTables");
}

function assertRackTablesNoError(response, context) {
  const text = cleanHtml(response?.body || "");
  const match = text.match(/(?:Database error|Invalid request|Permission denied|Access denied|Error):?\s*([^]+?)(?:Main page|Objects|IPv4 space|$)/i);
  if (match) {
    throw new Error(`${context}: ${match[0].trim()}`);
  }
}

function parseRackTablesChapter(html) {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const items = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => cleanHtml(match[1]));
    const numericCells = cells.filter((cell) => /^\d+$/.test(cell));
    const word = cells[cells.length - 1];
    if (numericCells.length > 0 && word && !/^(Origin|Key|Refcnt|Word)$/i.test(word)) {
      items.push({ id: numericCells[0], name: word });
    }
  }
  return uniqueBy(items, "id");
}

function parseRackTablesTags(html) {
  const match = html.match(/var\s+taglist\s*=\s*(\{[\s\S]*?\});/i);
  if (!match) return parseRackTablesTagsFromTree(html);

  try {
    const raw = JSON.parse(match[1]);
    return Object.values(raw)
      .filter((tag) => tag.is_assignable === "yes")
      .map((tag) => ({
        id: String(tag.id),
        name: tag.tag,
        parentId: tag.parent_id ? String(tag.parent_id) : null,
        color: tag.color || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  } catch {
    return parseRackTablesTagsFromTree(html);
  }
}

function parseRackTablesTagsFromTree(html) {
  const matches = [...html.matchAll(/<span[^>]+title="tag ID = (\d+)[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)];
  return uniqueBy(matches.map((match) => ({
    id: match[1],
    name: cleanHtml(match[2]),
    parentId: null,
    color: null
  })).filter((tag) => tag.name), "id").sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function parseRackTablesFreeSids(html) {
  const matches = [...html.matchAll(/<a[^>]+href=['"][^'"]*page=object(?:&amp;|&)?[^'"]*object_id=(\d+)[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi)];
  const items = [];
  for (const match of matches) {
    const sid = cleanHtml(match[2]);
    if (!/^S\d+/i.test(sid)) continue;
    items.push({
      objectId: match[1],
      sid,
      name: sid
    });
  }
  return uniqueBy(items, "objectId").sort((a, b) => a.sid.localeCompare(b.sid, "pt-BR", { numeric: true }));
}

function parseRackTablesIpv4Networks(html) {
  const matches = [...html.matchAll(/<tr\b[\s\S]*?<a[^>]+href=['"][^'"]*page=ipv4net(?:&amp;|&)id=(\d+)[^'"]*['"][^>]*>(\d{1,3}(?:\.\d{1,3}){3}\/(\d+))<\/a>([\s\S]*?)<\/tr>/gi)];
  return matches.map((match) => ({
    id: match[1],
    prefix: match[2],
    prefixLength: Number(match[3]),
    name: parseNetworkName(match[4])
  }));
}

function parseNetworkName(rowTail) {
  const cells = [...String(rowTail).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cleanHtml(match[1]));
  return cells.find((cell) => cell && !/^\d+\s*\/\s*\d+$/.test(cell)) || "";
}

function parseRackTablesFreeIpsFromNetwork(html, network) {
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const items = [];
  for (const row of rows) {
    const ipMatch = row.match(/page=ipaddress(?:&amp;|&)ip=(\d{1,3}(?:\.\d{1,3}){3})/i);
    if (!ipMatch) continue;
    if (!isUsableHostIp(ipMatch[1], network.prefix)) continue;
    if (/trbusy|RESERVED|page=object|hl_ip=/i.test(row)) continue;

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cleanHtml(match[1]));
    const name = cells[1] || "";
    const comment = cells[2] || "";
    const allocation = cells[3] || "";
    if (name || comment || allocation) continue;

    items.push({
      ip: ipMatch[1],
      name: ipMatch[1],
      networkId: network.id,
      network: network.prefix
    });
  }
  return items;
}

function isUsableHostIp(ip, cidr) {
  const [networkIp, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return true;
  if (prefix >= 31) return true;

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = ipToInt(networkIp) & mask;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const value = ipToInt(ip);
  return value !== network && value !== broadcast;
}

function ipToInt(ip) {
  return ip.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

async function rackTablesPing(config, ip) {
  try {
    const result = await rackTablesRequest(config, "GET", `/index.php?viareal_ping=1&ip=${encodeURIComponent(ip)}`);
    const parsed = parseJsonSafe(result.body);
    return {
      online: Boolean(parsed?.success),
      timeMs: parsed?.time || null,
      error: parsed?.error || null
    };
  } catch (error) {
    return { online: false, error: error.message || "Falha no ping" };
  }
}

function systemPing(ip) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const args = isWindows
      ? ["-n", "1", "-w", "1000", ip]
      : ["-c", "1", "-W", "1", ip];

    execFile("ping", args, { timeout: 2500 }, (error, stdout, stderr) => {
      const output = `${stdout || ""}\n${stderr || ""}`;
      resolve({
        online: !error,
        source: "system",
        output: output.slice(0, 500)
      });
    });
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function serveStatic(req, res, url) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(publicDir, `.${requestPath}`);
  if (!resolved.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(resolved);
    res.writeHead(200, {
      "Content-Type": contentType(resolved),
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function validateProvisionPayload(payload) {
  requiredText(payload.vcenterId, "vCenter");
  requiredText(payload.deployMode, "Modo de criacao");
  requiredText(payload.vm?.label, "Label da VM");
  if (payload.deployMode === "iso") {
    requiredText(payload.isoPath, "ISO da VM zerada");
  }
  requiredText(payload.racktables?.commonName, "Common Name/SID");
  requiredText(payload.racktables?.assetTag, "Asset Tag/IP");
}

async function findVcenter(id) {
  const vcenters = await loadJson("vcenters.json", []);
  const vcenter = vcenters.find((item) => item.id === id);
  if (!vcenter) throw new Error("vCenter nao encontrado");
  return vcenter;
}

function maskVcenter(vcenter) {
  return {
    ...vcenter,
    password: vcenter.password ? "********" : ""
  };
}

function maskRackTablesConfig(config) {
  return {
    ...config,
    password: config.password ? "********" : ""
  };
}

function maskJob(job) {
  return {
    ...job,
    request: job.request ? {
      ...job.request,
      racktables: job.request.racktables
    } : undefined
  };
}

async function getRackTablesConfig(id = null) {
  const configs = await getRackTablesStoredConfigs();
  const selected = id
    ? configs.find((item) => item.id === id)
    : configs[0];
  if (!selected) throw new Error("RackTables nao configurado.");
  return normalizeRackTablesConfig(selected);
}

async function getRackTablesDisplayConfigs() {
  return await getRackTablesStoredConfigs();
}

async function getRackTablesStoredConfigs() {
  const stored = await loadJson("racktables.json", []);
  const configs = Array.isArray(stored)
    ? stored
    : stored?.baseUrl || stored?.username || stored?.password
      ? [{ id: stored.id || "default", name: stored.name || "RackTables", ...stored }]
      : [];

  if (!configs.length && (process.env.RACKTABLES_URL || process.env.RACKTABLES_USERNAME || process.env.RACKTABLES_PASSWORD)) {
    configs.push({
      id: "env",
      name: process.env.RACKTABLES_NAME || "RackTables",
      baseUrl: process.env.RACKTABLES_URL || "http://racktables.local",
      username: process.env.RACKTABLES_USERNAME || "",
      password: process.env.RACKTABLES_PASSWORD || ""
    });
  }

  return configs.map((config, index) => ({
    id: config.id || crypto.createHash("sha1").update(`${config.baseUrl || ""}:${config.username || ""}:${index}`).digest("hex").slice(0, 12),
    name: config.name || `RackTables ${index + 1}`,
    baseUrl: config.baseUrl || "",
    username: config.username || "",
    password: config.password || "",
    createdAt: config.createdAt || null,
    updatedAt: config.updatedAt || null,
    lastTest: config.lastTest || null
  }));
}

function normalizeRackTablesConfig(input) {
  return {
    baseUrl: normalizeBaseUrl(requiredText(input.baseUrl, "URL do RackTables")),
    username: requiredText(input.username, "Usuario do RackTables"),
    password: requiredText(input.password, "Senha do RackTables")
  };
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} e obrigatorio.`);
  return text;
}

function normalizeHost(host) {
  return host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
}

function normalizeBaseUrl(baseUrl) {
  const text = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(text)) return `http://${text}`;
  return text;
}

function formBody(object) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(object)) {
    params.set(key, value == null ? "" : String(value));
  }
  return params.toString();
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function valueOrEmpty(result) {
  if (result.status !== "fulfilled") return [];
  return Array.isArray(result.value) ? result.value : [];
}

function settledSummary(result) {
  if (result.status === "fulfilled") {
    return { ok: true, count: Array.isArray(result.value) ? result.value.length : 0 };
  }
  return { ok: false, error: result.reason?.message || String(result.reason) };
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cleanHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlText(value) {
  return String(value ?? "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = item[key];
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON invalido.");
  }
}

async function ensureJson(file, defaultValue) {
  try {
    await fs.access(path.join(dataDir, file));
  } catch {
    await saveJson(file, defaultValue);
  }
}

async function loadJson(file, defaultValue) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
  } catch {
    return defaultValue;
  }
}

async function saveJson(file, value) {
  await fs.writeFile(path.join(dataDir, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
