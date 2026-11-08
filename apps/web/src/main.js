const configuredBase = globalThis.__IMPERIUM_API_BASE__;
const API_BASE = configuredBase || "https://imperium-v2-api.imperiumlj.workers.dev";

const status = document.querySelector("#api-status");
const input = document.querySelector("#make-search");
const button = document.querySelector("#search-makes");
const results = document.querySelector("#make-results");

async function request(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Catálogo temporariamente indisponível.");
  return body;
}

function renderMakes(items) {
  if (!items.length) {
    results.innerHTML = "<li>Nenhuma marca cadastrada ainda.</li>";
    return;
  }
  results.innerHTML = items.map((item) => `<li><button type="button" data-make-id="${item.id}">${item.name}<span>Selecionar</span></button></li>`).join("");
}

async function searchMakes() {
  button.disabled = true;
  status.textContent = "Buscando marcas…";
  try {
    const query = encodeURIComponent(input.value.trim());
    const data = await request(`/v1/public/vehicle-makes?q=${query}`);
    renderMakes(data.items || []);
    status.textContent = "Escolha uma marca para seguir para os modelos.";
  } catch (error) {
    results.innerHTML = "";
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", searchMakes);
input.addEventListener("keydown", (event) => { if (event.key === "Enter") searchMakes(); });

request("/health")
  .then(() => { status.textContent = "Catálogo V2 online. Pesquise uma marca para começar."; })
  .catch(() => { status.textContent = "O catálogo V2 ainda está sendo publicado. Tente novamente em instantes."; });
