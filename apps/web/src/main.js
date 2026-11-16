
const configuredBase = globalThis.__IMPERIUM_API_BASE__;
const API_BASE = configuredBase || "https://imperium-v2-api.imperiumlj.workers.dev";

const status = document.querySelector("#api-status");
const input = document.querySelector("#make-search");
const button = document.querySelector("#search-makes");
const results = document.querySelector("#make-results");

let selectedMake = null;
let selectedModel = null;

async function request(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || "Catálogo temporariamente indisponível.");
  }

  return body;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function renderMakes(items) {
  if (!items.length) {
    results.innerHTML = "<li>Nenhuma marca cadastrada ainda.</li>";
    return;
  }

  results.innerHTML = items.map((item) => `
    <li>
      <button type="button" data-make-id="${item.id}">
        ${escapeHtml(item.name)}
        <span>Selecionar</span>
      </button>
    </li>
  `).join("");
}

async function searchMakes() {
  button.disabled = true;
  status.textContent = "Buscando marcas…";
  selectedMake = null;
  selectedModel = null;

  try {
    const query = encodeURIComponent(input.value.trim());
    const data = await request(`/v1/public/vehicle-makes?q=${query}`);

    renderMakes(data.items || []);
    status.textContent = "Escolha uma marca para ver os modelos.";
  } catch (error) {
    results.innerHTML = "";
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function selectMake(makeId) {
  const makeButton = results.querySelector(`[data-make-id="${makeId}"]`);
  if (!makeButton) return;

  selectedMake = {
    id: Number(makeId),
    name: makeButton.childNodes[0].textContent.trim()
  };

  selectedModel = null;
  status.textContent = `Buscando modelos de ${selectedMake.name}…`;

  results.innerHTML = "<li>Carregando modelos...</li>";

  try {
    const data = await request(
      `/v1/public/vehicle-models?makeId=${encodeURIComponent(makeId)}`
    );

    renderModels(data.items || []);
    status.textContent = `Escolha o modelo do veículo ${selectedMake.name}.`;
  } catch (error) {
    results.innerHTML = "";
    status.textContent = error.message;
  }
}



function renderModels(items) {
  results.innerHTML = `
    <li class="selection-heading">
      Modelos de ${escapeHtml(selectedMake.name)}
    </li>

    <li class="model-search">
      <input
        id="model-search"
        type="search"
        autocomplete="off"
        placeholder="Pesquisar: Gol, Polo, Onix..."
      />
      <button type="button" id="search-models">
        Buscar
      </button>
    </li>

    <li>
      <div id="model-results">
        ${items.length
          ? items.map((item) => `
            <div>
              <button type="button" data-model-id="${item.id}">
                ${escapeHtml(item.name)}
                <span>Selecionar</span>
              </button>
            </div>
          `).join("")
          : "Nenhum modelo encontrado."
        }
      </div>
    </li>

    <li>
      <button type="button" data-back-makes>
        ← Voltar às marcas
      </button>
    </li>
  `;
}


async function searchModels() {
  if (!selectedMake) return;

  const searchInput = document.querySelector("#model-search");
  const modelResults = document.querySelector("#model-results");

  const query = encodeURIComponent(searchInput.value.trim());

  modelResults.textContent = "Pesquisando modelos...";

  try {
    const data = await request(
      `/v1/public/vehicle-models?makeId=${selectedMake.id}&q=${query}`
    );

    modelResults.innerHTML = (data.items || []).length
      ? data.items.map((item) => `
          <div>
            <button type="button" data-model-id="${item.id}">
              ${escapeHtml(item.name)}
              <span>Selecionar</span>
            </button>
          </div>
        `).join("")
      : "Nenhum modelo encontrado.";
  } catch (error) {
    modelResults.textContent = error.message;
  }
}


function selectModel(modelId) {
  const modelButton = results.querySelector(`[data-model-id="${modelId}"]`);
  if (!modelButton || !selectedMake) return;

  selectedModel = {
    id: Number(modelId),
    name: modelButton.childNodes[0].textContent.trim(),
    makeId: selectedMake.id,
    makeName: selectedMake.name
  };

  results.querySelectorAll("[data-model-id]").forEach((item) => {
    item.classList.toggle("selected", item === modelButton);
  });

  status.textContent =
    `Veículo selecionado: ${selectedModel.makeName} ${selectedModel.name}.`;
}

results.addEventListener("click", async (event) => {
  const makeButton = event.target.closest("[data-make-id]");
  const modelButton = event.target.closest("[data-model-id]");
  const backButton = event.target.closest("[data-back-makes]");
  const searchModelsButton = event.target.closest("#search-models");

if (searchModelsButton) {
  await searchModels();
  return;
}

  if (makeButton) {
    await selectMake(makeButton.dataset.makeId);
    return;
  }

  if (modelButton) {
    selectModel(modelButton.dataset.modelId);
    return;
  }

  if (backButton) {
    selectedMake = null;
    selectedModel = null;
    await searchMakes();
  }
});

button.addEventListener("click", searchMakes);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchMakes();
});

results.addEventListener("keydown", async (event) => {
  if (
    event.target.id === "model-search" &&
    event.key === "Enter"
  ) {
    event.preventDefault();
    await searchModels();
  }
});

request("/health")
  .then(() => {
    status.textContent = "Catálogo V2 online. Pesquise uma marca para começar.";
  })
  .catch(() => {
    status.textContent =
      "O catálogo V2 ainda está sendo publicado. Tente novamente em instantes.";
  });
