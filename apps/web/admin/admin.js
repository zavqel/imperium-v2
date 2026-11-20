const configuredBase = globalThis.__IMPERIUM_API_BASE__;
const API_BASE = configuredBase || "https://imperium-v2-api.imperiumlj.workers.dev";
const TOKEN_KEY = "imperium-v2-admin-session";

const authShell = document.querySelector("#auth-shell");
const appShell = document.querySelector("#app-shell");
const authTitle = document.querySelector("#auth-title");
const authCopy = document.querySelector("#auth-copy");
const authMessage = document.querySelector("#auth-message");
const loginForm = document.querySelector("#login-form");
const bootstrapForm = document.querySelector("#bootstrap-form");
const appMessage = document.querySelector("#app-message");
const viewRoot = document.querySelector("#view-root");
const viewTitle = document.querySelector("#view-title");
const viewKicker = document.querySelector("#view-kicker");
const currentUser = document.querySelector("#current-user");

const state = {
  token: sessionStorage.getItem(TOKEN_KEY),
  user: null,
  view: "dashboard",
  editId: null,
  compatibilityServiceId: null,
};

const endpoint = (path) => `${API_BASE}${path}`;
const numberFormat = new Intl.NumberFormat("pt-BR");
const moneyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function element(tag, properties = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "htmlFor") node.htmlFor = value;
    else if (key === "checked") node.checked = Boolean(value);
    else if (key === "value") node.value = value;
    else if (key === "disabled") node.disabled = Boolean(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function say(target, message = "", tone = "") {
  target.textContent = message;
  target.className = `message ${tone}`.trim();
}

function setBusy(form, busy) {
  for (const control of form.querySelectorAll("button, input, select, textarea")) control.disabled = busy;
}

async function request(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(endpoint(path), { method: options.method || "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.token) clearSession();
    throw new Error(body.error || "Não foi possível concluir a operação.");
  }
  return body;
}

function clearSession() {
  state.token = null;
  state.user = null;
  sessionStorage.removeItem(TOKEN_KEY);
}

function showAuth({ bootstrap = false, configured = true } = {}) {
  appShell.classList.add("hidden");
  authShell.classList.remove("hidden");
  loginForm.classList.toggle("hidden", bootstrap || !configured);
  bootstrapForm.classList.toggle("hidden", !bootstrap || !configured);
  if (!configured) {
    authTitle.textContent = "Segurança pendente";
    authCopy.textContent = "O painel foi publicado, mas os dois segredos do Worker ainda precisam ser definidos antes do primeiro acesso.";
  } else if (bootstrap) {
    authTitle.textContent = "Crie o administrador inicial";
    authCopy.textContent = "Este cadastro só pode acontecer uma vez. Use uma senha forte e o código de configuração do Worker.";
  } else {
    authTitle.textContent = "Acesse o painel V2";
    authCopy.textContent = "Use a conta administrativa criada para a operação do IMPÉRIUM.";
  }
}

async function initialize() {
  say(authMessage);
  if (state.token) {
    try {
      const session = await request("/v1/admin/session");
      state.user = session.user;
      await showApp();
      return;
    } catch {
      clearSession();
    }
  }
  try {
    const status = await request("/v1/admin/bootstrap-status");
    const configured = status.sessionConfigured && (status.hasOwner || status.bootstrapConfigured);
    showAuth({ bootstrap: !status.hasOwner, configured });
    if (!status.sessionConfigured) {
      say(authMessage, "Defina ADMIN_SESSION_SECRET no Worker com pelo menos 32 caracteres.", "error");
    } else if (!status.hasOwner && !status.bootstrapConfigured) {
      say(authMessage, "Defina ADMIN_BOOTSTRAP_TOKEN no Worker com pelo menos 32 caracteres para criar o primeiro administrador.", "error");
    }
  } catch (error) {
    showAuth({ configured: false });
    say(authMessage, error.message, "error");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(loginForm));
  setBusy(loginForm, true);
  say(authMessage);
  try {
    const session = await request("/v1/admin/login", { method: "POST", body: values });
    state.token = session.token;
    state.user = session.user;
    sessionStorage.setItem(TOKEN_KEY, session.token);
    await showApp();
  } catch (error) {
    say(authMessage, error.message, "error");
  } finally {
    setBusy(loginForm, false);
  }
});

bootstrapForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(bootstrapForm));
  setBusy(bootstrapForm, true);
  say(authMessage);
  try {
    await request("/v1/admin/bootstrap", { method: "POST", body: values });
    const session = await request("/v1/admin/login", { method: "POST", body: { email: values.email, password: values.password } });
    state.token = session.token;
    state.user = session.user;
    sessionStorage.setItem(TOKEN_KEY, session.token);
    bootstrapForm.reset();
    await showApp();
  } catch (error) {
    say(authMessage, error.message, "error");
  } finally {
    setBusy(bootstrapForm, false);
  }
});

document.querySelector("#logout").addEventListener("click", () => {
  clearSession();
  state.editId = null;
  say(authMessage);
  initialize();
});

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", async () => {
    state.view = button.dataset.view;
    state.editId = null;
    state.compatibilityServiceId = null;
    for (const item of document.querySelectorAll("[data-view]")) item.classList.toggle("active", item === button);
    await renderView();
  });
}

async function showApp() {
  authShell.classList.add("hidden");
  appShell.classList.remove("hidden");
  currentUser.textContent = `${state.user.displayName} · ${state.user.role}`;
  await renderView();
}

function replaceView(nodes) {
  viewRoot.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]));
}

function panel(title, copy, children = []) {
  const container = element("section", { className: "panel" });
  container.append(element("h2", { text: title }), element("p", { text: copy }));
  for (const child of children) container.append(child);
  return container;
}

function statusBadge(active) {
  return element("span", { className: `status ${active ? "on" : "off"}`, text: active ? "Ativo" : "Inativo" });
}

function moneyToCents(value) {
  const normalized = String(value).trim().replace(".", "").replace(",", ".");
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) throw new Error("Informe um valor válido em reais.");
  return Math.round(number * 100);
}

function minuteToTime(minute) {
  const value = Number(minute);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function timeToMinute(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Horário inválido.");
  return Number(match[1]) * 60 + Number(match[2]);
}

function makeSelect(name, options, { value = "", required = false, label = "", allowBlank = true } = {}) {
  const select = element("select", { name, required: required || undefined, "aria-label": label || name });
  if (allowBlank) select.append(element("option", { value: "", text: "Selecione…" }));
  for (const option of options) select.append(element("option", { value: String(option.value), text: option.label }));
  select.value = value === null || value === undefined ? "" : String(value);
  return select;
}

function field(descriptor, current = {}) {
  const value = current[descriptor.name] ?? descriptor.default ?? "";
  let control;
  if (descriptor.type === "select") {
    control = makeSelect(descriptor.name, descriptor.options || [], { value, required: descriptor.required, label: descriptor.label, allowBlank: descriptor.allowBlank !== false });
  } else if (descriptor.type === "textarea") {
    control = element("textarea", { name: descriptor.name, maxlength: descriptor.maxlength, placeholder: descriptor.placeholder, text: value });
    control.value = value;
  } else if (descriptor.type === "checkbox") {
    control = element("input", { name: descriptor.name, type: "checkbox", checked: value === "" ? descriptor.default !== false : Boolean(value) });
  } else {
    control = element("input", { name: descriptor.name, type: descriptor.type || "text", value, required: descriptor.required || undefined, min: descriptor.min, step: descriptor.step, maxlength: descriptor.maxlength, placeholder: descriptor.placeholder });
  }
  const wrapper = element("label", { className: descriptor.wide ? "wide" : "" }, [document.createTextNode(descriptor.label), control]);
  return wrapper;
}

function objectFromForm(form, descriptors) {
  const result = {};
  for (const descriptor of descriptors) {
    const control = form.elements.namedItem(descriptor.name);
    if (!control) continue;
    if (descriptor.type === "checkbox") {
      result[descriptor.name] = control.checked;
      continue;
    }
    const raw = control.value.trim();
    if (!raw && descriptor.omitIfBlank) continue;
    if (!raw && descriptor.nullable) { result[descriptor.name] = null; continue; }
    if (descriptor.type === "number") result[descriptor.name] = raw === "" ? raw : Number(raw);
    else result[descriptor.name] = raw;
  }
  return result;
}

function table(items, columns, { onToggle, onEdit, onDelete } = {}) {
  if (!items.length) return element("p", { className: "empty", text: "Nenhum registro cadastrado ainda." });
  const tableNode = element("table");
  const header = element("thead");
  header.append(element("tr", {}, [...columns.map((column) => element("th", { text: column.label })), element("th", { text: "Ações" })]));
  const body = element("tbody");
  for (const item of items) {
    const row = element("tr");
    for (const column of columns) {
      const value = typeof column.value === "function" ? column.value(item) : item[column.value];
      const cell = element("td");
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? "—";
      row.append(cell);
    }
    const actions = element("td");
if (onEdit) {
  actions.append(element("button", {
    className: "subtle-button",
    type: "button",
    text: "Editar",
    onClick: () => onEdit(item)
  }));
}

if (onToggle) {
  actions.append(element("button", {
    className: "subtle-button",
    type: "button",
    text: item.active ? "Desativar" : "Ativar",
    onClick: () => onToggle(item)
  }));
}

if (onDelete) {
  actions.append(element("button", {
    className: "subtle-button",
    type: "button",
    text: "Excluir",
    onClick: () => onDelete(item)
  }));
}
    row.append(actions);
    body.append(row);
  }
  tableNode.append(header, body);
  return element("div", { className: "table-wrap" }, tableNode);
}

const catalogMeta = {
  "vehicle-categories": {
    title: "Categorias de veículo",
    copy: "Defina as categorias que orientam preço e duração do atendimento.",
    endpoint: "/v1/admin/vehicle-categories",
    fields: () => [
      { name: "name", label: "Nome", required: true, maxlength: 160 },
      { name: "sortOrder", label: "Ordem", type: "number", min: "0", default: 0 },
      { name: "active", label: "Disponível", type: "checkbox", default: true },
    ],
    columns: [{ label: "Nome", value: "name" }, { label: "Ordem", value: "sortOrder" }, { label: "Status", value: (item) => statusBadge(item.active) }],
  },
  "vehicle-makes": {
    title: "Marcas",
    copy: "Cadastre apenas as marcas reais que o negócio atende.",
    endpoint: "/v1/admin/vehicle-makes",
    fields: () => [
      { name: "name", label: "Nome da marca", required: true, maxlength: 160 },
      { name: "active", label: "Disponível", type: "checkbox", default: true },
    ],
    columns: [{ label: "Marca", value: "name" }, { label: "Status", value: (item) => statusBadge(item.active) }],
  },
  "vehicle-models": {
    title: "Modelos",
    copy: "Vincule cada modelo a uma marca e a uma categoria de veículo.",
    endpoint: "/v1/admin/vehicle-models",
    references: ["vehicle-makes", "vehicle-categories"],
    fields: (refs) => [
      { name: "name", label: "Nome do modelo", required: true, maxlength: 160 },
      { name: "makeId", label: "Marca", type: "select", required: true, allowBlank: false, options: refs.makes.map((item) => ({ value: item.id, label: item.name })) },
      { name: "vehicleCategoryId", label: "Categoria", type: "select", required: true, allowBlank: false, options: refs.categories.map((item) => ({ value: item.id, label: item.name })) },
      { name: "active", label: "Disponível", type: "checkbox", default: true },
    ],
    columns: [{ label: "Modelo", value: "name" }, { label: "Marca", value: "makeName" }, { label: "Categoria", value: "vehicleCategoryName" }, { label: "Status", value: (item) => statusBadge(item.active) }],
  },
  "service-categories": {
    title: "Categorias de serviço",
    copy: "Agrupe o catálogo de serviços da forma que fizer sentido para a operação.",
    endpoint: "/v1/admin/service-categories",
    fields: () => [
      { name: "name", label: "Nome", required: true, maxlength: 160 },
      { name: "sortOrder", label: "Ordem", type: "number", min: "0", default: 0 },
      { name: "active", label: "Disponível", type: "checkbox", default: true },
    ],
    columns: [{ label: "Nome", value: "name" }, { label: "Ordem", value: "sortOrder" }, { label: "Status", value: (item) => statusBadge(item.active) }],
  },
  services: {
    title: "Serviços",
    copy: "Configure duração, modo de preço e o último horário de início permitido.",
    endpoint: "/v1/admin/services",
    references: ["service-categories"],
    fields: (refs) => [
      { name: "name", label: "Nome do serviço", required: true, maxlength: 160 },
      { name: "serviceCategoryId", label: "Categoria", type: "select", options: refs.serviceCategories.map((item) => ({ value: item.id, label: item.name })), nullable: true },
      { name: "pricingMode", label: "Modo de preço", type: "select", allowBlank: false, default: "vehicle_category", options: [{ value: "vehicle_category", label: "Por categoria de veículo" }, { value: "fixed", label: "Preço fixo" }] },
      { name: "fixedPriceCents", label: "Preço fixo (centavos)", type: "number", min: "0", nullable: true, omitIfBlank: true },
      { name: "durationMinutes", label: "Duração (minutos)", type: "number", min: "1", default: 60, required: true },
      { name: "lastStartMinute", label: "Último início (minutos após 00h)", type: "number", min: "0", max: "1439", nullable: true },
      { name: "sortOrder", label: "Ordem", type: "number", min: "0", default: 0 },
      { name: "shortDescription", label: "Descrição curta", wide: true, maxlength: 320, omitIfBlank: true },
      { name: "active", label: "Disponível", type: "checkbox", default: true },
    ],
    columns: [{ label: "Serviço", value: "name" }, { label: "Categoria", value: "serviceCategoryName" }, { label: "Preço", value: (item) => item.pricingMode === "fixed" ? moneyFormat.format(item.fixedPriceCents / 100) : "Por categoria" }, { label: "Duração", value: (item) => `${item.durationMinutes} min` }, { label: "Status", value: (item) => statusBadge(item.active) }],
  },
  addons: {
    title: "Adicionais",
    copy: "Crie complementos compatíveis com os serviços principais.",
    endpoint: "/v1/admin/addons",
    fields: () => [
      { name: "name", label: "Nome do adicional", required: true, maxlength: 160 },
      { name: "pricingMode", label: "Modo de preço", type: "select", allowBlank: false, default: "fixed", options: [{ value: "fixed", label: "Preço fixo" }, { value: "vehicle_category", label: "Por categoria de veículo" }] },
      { name: "fixedPriceCents", label: "Preço fixo (centavos)", type: "number", min: "0", nullable: true, omitIfBlank: true },
      { name: "durationMinutes", label: "Duração extra (minutos)", type: "number", min: "0", default: 0, required: true },
      { name: "sortOrder", label: "Ordem", type: "number", min: "0", default: 0 },
      { name: "description", label: "Descrição", type: "textarea", wide: true, maxlength: 3000, omitIfBlank: true },
      { name: "active", label: "Disponível", type: "checkbox", default: true },
    ],
    columns: [{ label: "Adicional", value: "name" }, { label: "Preço", value: (item) => item.pricingMode === "fixed" ? moneyFormat.format(item.fixedPriceCents / 100) : "Por categoria" }, { label: "Duração", value: (item) => `${item.durationMinutes} min` }, { label: "Status", value: (item) => statusBadge(item.active) }],
  },
};

async function getCatalogReferences(meta) {
  if (!meta.references) return {};
  const requests = meta.references.map((name) => request(catalogMeta[name].endpoint));
  const responses = await Promise.all(requests);
  return Object.fromEntries(meta.references.map((name, index) => {
    const key = name === "vehicle-makes" ? "makes" : name === "vehicle-categories" ? "categories" : "serviceCategories";
    return [key, responses[index].items];
  }));
}

async function renderCatalog(kind) {
  const meta = catalogMeta[kind];
  viewKicker.textContent = "CATÁLOGO";
  viewTitle.textContent = meta.title;
  const [response, refs] = await Promise.all([request(meta.endpoint), getCatalogReferences(meta)]);
  const current = state.editId ? response.items.find((item) => item.id === state.editId) : null;
  if (state.editId && !current) state.editId = null;
  const descriptors = meta.fields(refs);
  const form = element("form", { className: "form-grid", novalidate: "" });
  for (const descriptor of descriptors) form.append(field(descriptor, current || {}));
  const actions = element("div", { className: "form-actions wide" });
  actions.append(element("button", { className: "button", type: "submit", text: current ? "Salvar alterações" : "Cadastrar" }));
  
if (kind === "vehicle-makes") {
  actions.append(element("button", {
    className: "subtle-button",
    type: "button",
    text: "Importar marcas da FIPE",
    onClick: async () => {
      try {
        say(appMessage, "Importando marcas da FIPE...");
        const result = await request("/v1/admin/fipe/import-car-brands", {
          method: "POST"
        });
        await renderView();
        say(
          appMessage,
          `${result.processed} marcas importadas com sucesso!`,
          "success"
        );
      } catch (error) {
        say(appMessage, error.message, "error");
      }
    }
  }));
}

  if (kind === "vehicle-models") {
  actions.append(element("button", {
    className: "button",
    type: "button",
    text: "Importar modelos de todas as marcas",
    onClick: async (event) => {
      const button = event.currentTarget;
      const makesResponse = await request("/v1/admin/vehicle-makes");
const makes = makesResponse.items.filter((item) => item.active);

      if (!makes.length) {
        say(appMessage, "Nenhuma marca ativa encontrada.", "error");
        return;
      }

      button.disabled = true;
      let inserted = 0;
      let updated = 0;
      let processed = 0;
      const errors = [];

      try {
        for (let i = 0; i < makes.length; i++) {
          const make = makes[i];

          say(
            appMessage,
            `Importando modelos: ${make.name} (${i + 1}/${makes.length})...`
          );

          try {
            const result = await request("/v1/admin/fipe/import-car-models", {
              method: "POST",
              body: { makeId: make.id },
            });

            inserted += result.inserted || 0;
            updated += result.updated || 0;
            processed += result.processed || 0;
          } catch (error) {
            errors.push(`${make.name}: ${error.message}`);
          }
        }

        await renderView();

        const summary =
          `Importação concluída! ${processed} modelos processados, ` +
          `${inserted} novos e ${updated} atualizados.`;

        say(
          appMessage,
          errors.length
            ? `${summary} ${errors.length} marcas tiveram problemas: ${errors.slice(0, 5).join(" | ")}`
            : summary,
          errors.length ? "error" : "success"
        );
      } finally {
        button.disabled = false;
      }
    },
  }));
}


  if (current) actions.append(element("button", { className: "subtle-button", type: "button", text: "Cancelar edição", onClick: async () => { state.editId = null; await renderView(); } }));
  form.append(actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(form, true);
    say(appMessage);
    try {
      const payload = objectFromForm(form, descriptors);
      await request(current ? `${meta.endpoint}/${current.id}` : meta.endpoint, { method: current ? "PATCH" : "POST", body: payload });
      state.editId = null;
      say(appMessage, current ? "Alteração salva." : "Cadastro criado.", "success");
      await renderView();
    } catch (error) {
      say(appMessage, error.message, "error");
    } finally {
      setBusy(form, false);
    }
  });

  const list = table(response.items, meta.columns, {
    onEdit: async (item) => { state.editId = item.id; await renderView(); },
    onToggle: async (item) => {
      try {
        await request(`${meta.endpoint}/${item.id}`, { method: "PATCH", body: { active: !item.active } });
        say(appMessage, item.active ? "Registro desativado." : "Registro ativado.", "success");
        await renderView();
      } catch (error) { say(appMessage, error.message, "error"); }
    },
  });
  replaceView(element("div", { className: "split" }, [
    panel(current ? "Editar cadastro" : "Novo cadastro", current ? "Altere apenas o que precisa mudar." : "Os dados entram no catálogo somente após salvar.", [form]),
    panel("Registros", "Desative itens que não devem aparecer sem apagar seu histórico.", [list]),
  ]));
}

async function renderDashboard() {
  viewKicker.textContent = "PAINEL";
  viewTitle.textContent = "Visão geral";
  const data = await request("/v1/admin/dashboard");
  const labels = [
    ["Categorias de veículo", data.counts.vehicleCategories],
    ["Marcas ativas", data.counts.makes],
    ["Modelos ativos", data.counts.models],
    ["Serviços ativos", data.counts.services],
    ["Adicionais ativos", data.counts.addons],
    ["Agendamentos futuros", data.counts.upcomingBookings],
  ];
  const cards = element("div", { className: "card-grid" }, labels.map(([label, total]) => element("article", { className: "metric-card" }, [element("span", { text: label }), element("strong", { text: numberFormat.format(total || 0) })])));
  replaceView([
    cards,
    panel("Próxima sequência recomendada", "O catálogo nasce vazio de propósito. Cadastre primeiro categorias de veículo, marcas e modelos; depois categorias de serviço, serviços, adicionais e os respectivos preços.", [
      element("p", { className: "muted", text: "Nenhum dado comercial de exemplo foi incluído. Tudo que aparece no site público vem dos registros aprovados por você." }),
    ]),
  ]);
}

function optionLabel(list, id, build = (item) => item.name) {
  const item = list.find((candidate) => Number(candidate.id) === Number(id));
  return item ? build(item) : `#${id}`;
}

async function renderPricing() {
  viewKicker.textContent = "OPERAÇÃO";
  viewTitle.textContent = "Preços e compatibilidade";

  const data = await request("/v1/admin/pricing");

  const serviceOptions = data.services.map((item) => ({
    value: item.id,
    label: item.name
  }));

  const addonOptions = data.addons.map((item) => ({
    value: item.id,
    label: item.name
  }));

  const categoryOptions = data.categories.map((item) => ({
    value: item.id,
    label: item.name
  }));

  const modelOptions = data.models.map((item) => ({
    value: item.id,
    label: `${item.makeName} ${item.name}`
  }));

  const forms = [];
  let editingRule = null;

  function clearEditing() {
    editingRule = null;
    categoryService.reset();
    categoryAddon.reset();
    modelService.reset();
    say(appMessage);
    renderView();
  }

  function addCancelButton(form) {
    const actions = form.querySelector(".form-actions");
    if (!actions) return;

    actions.append(
      element("button", {
        className: "subtle-button",
        type: "button",
        text: "Cancelar edição",
        onClick: clearEditing
      })
    );
  }

  function prepareEdit(form, values, rule) {
    editingRule = rule;

    for (const [name, value] of Object.entries(values)) {
      const control = form.elements.namedItem(name);
      if (!control) continue;

      control.value = String(value);
    }

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.textContent = "Salvar alterações";

    addCancelButton(form);

    form.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }

  // SERVIÇO POR CATEGORIA
  const categoryService = element("form", {
    className: "form-grid",
    novalidate: ""
  });

  categoryService.append(
    field({
      name: "vehicleCategoryId",
      label: "Categoria de veículo",
      type: "select",
      required: true,
      allowBlank: false,
      options: categoryOptions
    }),
    field({
      name: "serviceId",
      label: "Serviço",
      type: "select",
      required: true,
      allowBlank: false,
      options: serviceOptions
    }),
    field({
      name: "price",
      label: "Preço (R$)",
      type: "number",
      min: "0",
      step: ".01",
      required: true,
      wide: true
    })
  );

  categoryService.append(
    element("div", {
      className: "form-actions wide"
    }, element("button", {
      className: "button",
      type: "submit",
      text: "Salvar preço por categoria"
    }))
  );

  categoryService.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const payload = Object.fromEntries(
        new FormData(categoryService)
      );

      await request("/v1/admin/pricing/category-service", {
        method: "PUT",
        body: {
          vehicleCategoryId: Number(payload.vehicleCategoryId),
          serviceId: Number(payload.serviceId),
          priceCents: moneyToCents(payload.price)
        }
      });

      say(
        appMessage,
        editingRule ? "Preço atualizado." : "Preço por categoria salvo.",
        "success"
      );

      editingRule = null;
      await renderView();
    } catch (error) {
      say(appMessage, error.message, "error");
    }
  });

  forms.push(
    panel(
      "Serviço por categoria",
      "Use para serviços cujo valor varia pelo porte do veículo.",
      [categoryService]
    )
  );

  // ADICIONAL POR CATEGORIA
  const categoryAddon = element("form", {
    className: "form-grid",
    novalidate: ""
  });

  categoryAddon.append(
    field({
      name: "vehicleCategoryId",
      label: "Categoria de veículo",
      type: "select",
      required: true,
      allowBlank: false,
      options: categoryOptions
    }),
    field({
      name: "addonId",
      label: "Adicional",
      type: "select",
      required: true,
      allowBlank: false,
      options: addonOptions
    }),
    field({
      name: "price",
      label: "Preço (R$)",
      type: "number",
      min: "0",
      step: ".01",
      required: true,
      wide: true
    })
  );

  categoryAddon.append(
    element("div", {
      className: "form-actions wide"
    }, element("button", {
      className: "button",
      type: "submit",
      text: "Salvar adicional por categoria"
    }))
  );

  categoryAddon.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const payload = Object.fromEntries(
        new FormData(categoryAddon)
      );

      await request("/v1/admin/pricing/category-addon", {
        method: "PUT",
        body: {
          vehicleCategoryId: Number(payload.vehicleCategoryId),
          addonId: Number(payload.addonId),
          priceCents: moneyToCents(payload.price)
        }
      });

      say(
        appMessage,
        editingRule ? "Preço do adicional atualizado." : "Preço do adicional salvo.",
        "success"
      );

      editingRule = null;
      await renderView();
    } catch (error) {
      say(appMessage, error.message, "error");
    }
  });

  forms.push(
    panel(
      "Adicional por categoria",
      "Use quando o complemento também varia conforme o veículo.",
      [categoryAddon]
    )
  );

  // EXCEÇÃO POR MODELO
  const modelService = element("form", {
    className: "form-grid",
    novalidate: ""
  });

  modelService.append(
    field({
      name: "vehicleModelId",
      label: "Modelo",
      type: "select",
      required: true,
      allowBlank: false,
      options: modelOptions
    }),
    field({
      name: "serviceId",
      label: "Serviço",
      type: "select",
      required: true,
      allowBlank: false,
      options: serviceOptions
    }),
    field({
      name: "price",
      label: "Preço (R$)",
      type: "number",
      min: "0",
      step: ".01",
      required: true
    }),
    field({
      name: "active",
      label: "Exceção ativa",
      type: "checkbox",
      default: true
    })
  );

  modelService.append(
    element("div", {
      className: "form-actions wide"
    }, element("button", {
      className: "button",
      type: "submit",
      text: "Salvar exceção de modelo"
    }))
  );

  modelService.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const payload = Object.fromEntries(
        new FormData(modelService)
      );

      await request("/v1/admin/pricing/model-service", {
        method: "PUT",
        body: {
          vehicleModelId: Number(payload.vehicleModelId),
          serviceId: Number(payload.serviceId),
          priceCents: moneyToCents(payload.price),
          active: modelService.elements.active.checked
        }
      });

      say(
        appMessage,
        editingRule ? "Exceção atualizada." : "Exceção de modelo salva.",
        "success"
      );

      editingRule = null;
      await renderView();
    } catch (error) {
      say(appMessage, error.message, "error");
    }
  });

  forms.push(
    panel(
      "Exceção por modelo",
      "A exceção tem prioridade sobre o preço por categoria.",
      [modelService]
    )
  );

  // COMPATIBILIDADE
  const selectedServiceId =
    state.compatibilityServiceId || data.services[0]?.id;

  const compatibility = element("form", {
    className: "form-grid",
    novalidate: ""
  });

  const serviceSelect = makeSelect(
    "serviceId",
    serviceOptions,
    {
      value: selectedServiceId,
      required: true,
      allowBlank: false,
      label: "Serviço"
    }
  );

  serviceSelect.addEventListener("change", async () => {
    state.compatibilityServiceId = Number(serviceSelect.value);
    await renderView();
  });

  compatibility.append(
    element("label", {
      className: "wide"
    }, [
      document.createTextNode("Serviço principal"),
      serviceSelect
    ])
  );

  const compatibleIds = new Set(
    data.compatibilities
      .filter(
        (item) =>
          Number(item.serviceId) === Number(selectedServiceId)
      )
      .map((item) => Number(item.addonId))
  );

  const checkList = element("div", {
    className: "check-list wide"
  });

  for (const addon of data.addons) {
    checkList.append(
      element("label", {}, [
        element("input", {
          type: "checkbox",
          name: "addonIds",
          value: addon.id,
          checked: compatibleIds.has(Number(addon.id))
        }),
        document.createTextNode(addon.name)
      ])
    );
  }

  compatibility.append(
    element("div", {
      className: "wide"
    }, [
      element("label", {
        text: "Adicionais compatíveis"
      }),
      checkList
    ])
  );

  compatibility.append(
    element("div", {
      className: "form-actions wide"
    }, element("button", {
      className: "button",
      type: "submit",
      text: "Salvar compatibilidade"
    }))
  );

  compatibility.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const addonIds = [
        ...compatibility.querySelectorAll(
          'input[name="addonIds"]:checked'
        )
      ].map((input) => Number(input.value));

      await request("/v1/admin/pricing/service-addons", {
        method: "PUT",
        body: {
          serviceId: Number(serviceSelect.value),
          addonIds
        }
      });

      say(
        appMessage,
        "Compatibilidade atualizada.",
        "success"
      );

      await renderView();
    } catch (error) {
      say(appMessage, error.message, "error");
    }
  });

  forms.push(
    panel(
      "Compatibilidade",
      "Apenas adicionais compatíveis são mostrados junto ao serviço no agendamento.",
      [compatibility]
    )
  );

  // TABELA DE REGRAS
  const rows = [
    ...data.categoryServicePrices.map((item) => ({
      id: item.id,
      type: "Serviço por categoria",
      target: `${optionLabel(data.categories, item.vehicleCategoryId)} · ${optionLabel(data.services, item.serviceId)}`,
      price: item.priceCents,
      rule: "category-service",
      vehicleCategoryId: item.vehicleCategoryId,
      serviceId: item.serviceId
    })),

    ...data.categoryAddonPrices.map((item) => ({
      id: item.id,
      type: "Adicional por categoria",
      target: `${optionLabel(data.categories, item.vehicleCategoryId)} · ${optionLabel(data.addons, item.addonId)}`,
      price: item.priceCents,
      rule: "category-addon",
      vehicleCategoryId: item.vehicleCategoryId,
      addonId: item.addonId
    })),

    ...data.modelServiceOverrides.map((item) => ({
      id: item.id,
      type: item.active ? "Exceção de modelo" : "Exceção inativa",
      target: `${optionLabel(data.models, item.vehicleModelId, (model) => `${model.makeName} ${model.name}`)} · ${optionLabel(data.services, item.serviceId)}`,
      price: item.priceCents,
      rule: "model-service",
      vehicleModelId: item.vehicleModelId,
      serviceId: item.serviceId,
      active: item.active
    }))
  ];

  function editRule(item) {
    if (item.rule === "category-service") {
      prepareEdit(
        categoryService,
        {
          vehicleCategoryId: item.vehicleCategoryId,
          serviceId: item.serviceId,
          price: (item.price / 100).toFixed(2)
        },
        item
      );
    }

    if (item.rule === "category-addon") {
      prepareEdit(
        categoryAddon,
        {
          vehicleCategoryId: item.vehicleCategoryId,
          addonId: item.addonId,
          price: (item.price / 100).toFixed(2)
        },
        item
      );
    }

    if (item.rule === "model-service") {
      prepareEdit(
        modelService,
        {
          vehicleModelId: item.vehicleModelId,
          serviceId: item.serviceId,
          price: (item.price / 100).toFixed(2),
          active: item.active
        },
        item
      );

      modelService.elements.active.checked = Boolean(item.active);
    }
  }

  const rulesTable = table(
    rows,
    [
      {
        label: "Regra",
        value: "type"
      },
      {
        label: "Aplicação",
        value: "target"
      },
      {
        label: "Valor",
        value: (item) =>
          moneyFormat.format(item.price / 100)
      }
    ],
    {
      onEdit: editRule,
      onDelete: deleteRule
    }
  );

  replaceView([
    element("div", {
      className: "card-grid"
    }, forms),

    panel(
      "Tabela atual",
      "Os valores são guardados em centavos para evitar erros de arredondamento.",
      [rulesTable]
    )
  ]);
}

async function deleteRule(item) {
  const description = `${item.type}: ${item.target}`;

  if (!confirm(`Tem certeza que deseja excluir esta regra?\n\n${description}`)) {
    return;
  }

  try {
    const path = `/v1/admin/pricing/${item.rule}`;

    let body;

    if (item.rule === "category-service") {
      body = {
        vehicleCategoryId: Number(item.vehicleCategoryId),
        serviceId: Number(item.serviceId)
      };
    } else if (item.rule === "category-addon") {
      body = {
        vehicleCategoryId: Number(item.vehicleCategoryId),
        addonId: Number(item.addonId)
      };
    } else if (item.rule === "model-service") {
      body = {
        vehicleModelId: Number(item.vehicleModelId),
        serviceId: Number(item.serviceId)
      };
    }

    await request(path, {
      method: "DELETE",
      body
    });

    say(appMessage, "Regra excluída com sucesso.", "success");
    await renderView();

  } catch (error) {
    say(appMessage, error.message, "error");
  }
}

async function renderOperations() {
  viewKicker.textContent = "OPERAÇÃO";
  viewTitle.textContent = "Agenda e capacidade";
  const data = await request("/v1/admin/operations");
  const form = element("form", { className: "form-grid", novalidate: "" });
  const fields = [
    { name: "opensAtMinute", label: "Abertura (minutos após 00h)", type: "number", min: "0", max: "1438", required: true },
    { name: "closesAtMinute", label: "Fechamento (minutos após 00h)", type: "number", min: "1", max: "1440", required: true },
    { name: "slotIntervalMinutes", label: "Intervalo de horários (minutos)", type: "number", min: "5", required: true },
    { name: "minimumLeadMinutes", label: "Antecedência mínima (minutos)", type: "number", min: "0", required: true },
    { name: "capacity", label: "Capacidade simultânea", type: "number", min: "1", required: true, wide: true },
  ];
  for (const descriptor of fields) form.append(field(descriptor, data.availability));
  const weekdays = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
  const hours = new Map(data.operatingHours.map((item) => [Number(item.weekday), item]));
  const hoursRoot = element("div", { className: "hours wide" });
  hoursRoot.append(element("label", { text: "Horários por dia" }));
  weekdays.forEach((name, weekday) => {
    const current = hours.get(weekday) || { opensAtMinute: data.availability.opensAtMinute, closesAtMinute: data.availability.closesAtMinute, active: false };
    const row = element("div", { className: "hour-row" });
    row.append(element("span", { text: name }));
    row.append(element("input", { type: "time", name: `open-${weekday}`, value: minuteToTime(current.opensAtMinute) }));
    row.append(element("input", { type: "time", name: `close-${weekday}`, value: minuteToTime(current.closesAtMinute) }));
    row.append(element("label", {}, [element("input", { type: "checkbox", name: `active-${weekday}`, checked: current.active }), document.createTextNode("Atende")]));
    hoursRoot.append(row);
  });
  form.append(hoursRoot, element("div", { className: "form-actions wide" }, element("button", { className: "button", type: "submit", text: "Salvar configuração da agenda" })));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const settings = {};
      for (const descriptor of fields) settings[descriptor.name] = Number(form.elements[descriptor.name].value);
      const operatingHours = weekdays.map((_, weekday) => ({
        weekday,
        opensAtMinute: timeToMinute(form.elements[`open-${weekday}`].value),
        closesAtMinute: timeToMinute(form.elements[`close-${weekday}`].value),
        active: form.elements[`active-${weekday}`].checked,
      }));
      await request("/v1/admin/operations", { method: "PUT", body: { settings, operatingHours } });
      say(appMessage, "Agenda e capacidade atualizadas.", "success");
      await renderView();
    } catch (error) { say(appMessage, error.message, "error"); }
  });
  replaceView(panel("Parâmetros da disponibilidade", "A capacidade é aplicada junto ao coordenador de reservas; os horários por dia ficam prontos para a próxima etapa do agendamento.", [form]));
}

async function renderView() {
  say(appMessage);
  viewRoot.replaceChildren(element("p", { className: "muted", text: "Carregando…" }));
  try {
    if (state.view === "dashboard") await renderDashboard();
    else if (state.view === "pricing") await renderPricing();
    else if (state.view === "operations") await renderOperations();
    else await renderCatalog(state.view);
  } catch (error) {
    replaceView(panel("Não foi possível carregar este módulo", "Verifique a conexão com a API e tente novamente.", []));
    say(appMessage, error.message, "error");
  }
}

initialize();
