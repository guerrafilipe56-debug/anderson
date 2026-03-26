const LEGACY_MATERIALS_KEY = "controle-estoque-materiais-v1";
const LEGACY_MOVEMENTS_KEY = "controle-estoque-movimentos-v1";
const API_BASE_URL = "/api";
const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

const bannerTimeouts = new Map();

const state = {
  materials: [],
  movements: [],
  users: [],
  editingMaterialId: null,
  filters: {
    search: "",
    status: "all"
  },
  serverReady: false,
  authenticated: false,
  setupRequired: false,
  currentUser: null,
  storageMode: "sqlite"
};

const refs = {
  authShell: document.getElementById("auth-shell"),
  authMessage: document.getElementById("auth-message"),
  setupPanel: document.getElementById("setup-panel"),
  loginPanel: document.getElementById("login-panel"),
  setupForm: document.getElementById("setup-form"),
  setupUsername: document.getElementById("setup-username"),
  setupPassword: document.getElementById("setup-password"),
  setupPasswordConfirm: document.getElementById("setup-password-confirm"),
  setupSubmitButton: document.getElementById("setup-submit-button"),
  loginForm: document.getElementById("login-form"),
  loginUsername: document.getElementById("login-username"),
  loginPassword: document.getElementById("login-password"),
  loginSubmitButton: document.getElementById("login-submit-button"),
  appShell: document.getElementById("app-shell"),
  appMessage: document.getElementById("app-message"),
  storageModeChip: document.getElementById("storage-mode-chip"),
  storageModeText: document.getElementById("storage-mode-text"),
  currentUserChip: document.getElementById("current-user-chip"),
  logoutButton: document.getElementById("logout-button"),
  usersPanel: document.getElementById("users-panel"),
  userForm: document.getElementById("user-form"),
  userUsername: document.getElementById("user-username"),
  userRole: document.getElementById("user-role"),
  userPassword: document.getElementById("user-password"),
  userPasswordConfirm: document.getElementById("user-password-confirm"),
  userSubmitButton: document.getElementById("user-submit-button"),
  userList: document.getElementById("user-list"),
  materialForm: document.getElementById("material-form"),
  materialFormTitle: document.getElementById("material-form-title"),
  materialId: document.getElementById("material-id"),
  materialName: document.getElementById("material-name"),
  materialCategory: document.getElementById("material-category"),
  materialUnit: document.getElementById("material-unit"),
  materialStock: document.getElementById("material-stock"),
  materialMinStock: document.getElementById("material-min-stock"),
  materialCostPrice: document.getElementById("material-cost-price"),
  materialSalePrice: document.getElementById("material-sale-price"),
  materialSupplier: document.getElementById("material-supplier"),
  materialSubmitButton: document.getElementById("material-submit-button"),
  cancelEditButton: document.getElementById("cancel-edit-button"),
  movementForm: document.getElementById("movement-form"),
  movementMaterial: document.getElementById("movement-material"),
  movementType: document.getElementById("movement-type"),
  movementQuantity: document.getElementById("movement-quantity"),
  movementUnitPrice: document.getElementById("movement-unit-price"),
  movementNote: document.getElementById("movement-note"),
  movementSubmitButton: document.getElementById("movement-submit-button"),
  exportMaterialsButton: document.getElementById("export-materials-button"),
  exportMovementsButton: document.getElementById("export-movements-button"),
  exportPurchasesButton: document.getElementById("export-purchases-button"),
  purchaseItemsCount: document.getElementById("purchase-items-count"),
  purchaseTotalQuantity: document.getElementById("purchase-total-quantity"),
  purchaseTotalCost: document.getElementById("purchase-total-cost"),
  purchaseReportList: document.getElementById("purchase-report-list"),
  alertList: document.getElementById("alert-list"),
  searchInput: document.getElementById("search-input"),
  statusFilter: document.getElementById("status-filter"),
  materialsTableBody: document.getElementById("materials-table-body"),
  movementList: document.getElementById("movement-list"),
  statTotalMaterials: document.getElementById("stat-total-materials"),
  statTotalStock: document.getElementById("stat-total-stock"),
  statTotalValue: document.getElementById("stat-total-value"),
  statLowStock: document.getElementById("stat-low-stock")
};

initialize().catch((error) => {
  console.error(error);
  state.serverReady = false;
  render();
  showAuthMessage("Falha ao iniciar a aplicacao.", "warn");
});

async function initialize() {
  refs.setupForm.addEventListener("submit", (event) => {
    void handleSetupSubmit(event);
  });
  refs.loginForm.addEventListener("submit", (event) => {
    void handleLoginSubmit(event);
  });
  refs.logoutButton.addEventListener("click", () => {
    void handleLogout();
  });
  refs.userForm.addEventListener("submit", (event) => {
    void handleUserSubmit(event);
  });
  refs.userList.addEventListener("click", handleUserListActions);
  refs.materialForm.addEventListener("submit", (event) => {
    void handleMaterialSubmit(event);
  });
  refs.cancelEditButton.addEventListener("click", resetMaterialForm);
  refs.movementForm.addEventListener("submit", (event) => {
    void handleMovementSubmit(event);
  });
  refs.searchInput.addEventListener("input", handleSearchInput);
  refs.statusFilter.addEventListener("change", handleStatusFilter);
  refs.materialsTableBody.addEventListener("click", handleTableActions);
  refs.exportMaterialsButton.addEventListener("click", exportMaterialsReport);
  refs.exportMovementsButton.addEventListener("click", exportMovementsReport);
  refs.exportPurchasesButton.addEventListener("click", exportPurchasesReport);

  render();

  await bootstrapApp();
}

async function bootstrapApp() {
  try {
    const authStatus = await fetchJson("/auth/status", { authRoute: true });

    state.serverReady = true;
    applyAuthStatus(authStatus);

    if (state.authenticated) {
      await loadProtectedData({ attemptMigration: true });
      showAppMessage("Sessao carregada com sucesso.");
      return;
    }

    clearProtectedState();
    render();
  } catch (error) {
    console.error(error);
    state.serverReady = false;
    state.authenticated = false;
    state.setupRequired = false;
    state.currentUser = null;
    clearProtectedState();
    render();
    showAuthMessage("Servidor offline. Rode npm run dev localmente ou publique a API na Vercel.", "warn");
  }
}

async function handleSetupSubmit(event) {
  event.preventDefault();

  if (!state.serverReady) {
    showAuthMessage("Servidor offline. Rode npm run dev localmente ou publique a API na Vercel.", "warn");
    return;
  }

  const username = refs.setupUsername.value.trim();
  const password = refs.setupPassword.value;
  const passwordConfirm = refs.setupPasswordConfirm.value;

  if (username.length < 3) {
    showAuthMessage("Use um usuario com pelo menos 3 caracteres.", "warn");
    refs.setupUsername.focus();
    return;
  }

  if (password.length < 6) {
    showAuthMessage("Use uma senha com pelo menos 6 caracteres.", "warn");
    refs.setupPassword.focus();
    return;
  }

  if (password !== passwordConfirm) {
    showAuthMessage("A confirmacao da senha nao confere.", "warn");
    refs.setupPasswordConfirm.focus();
    return;
  }

  try {
    const authStatus = await fetchJson("/auth/setup", {
      method: "POST",
      authRoute: true,
      body: {
        username,
        password
      }
    });

    refs.setupForm.reset();
    applyAuthStatus(authStatus);
    await loadProtectedData({ attemptMigration: true });
    showAppMessage("Administrador criado com sucesso.");
  } catch (error) {
    if (error.message !== "AUTH_REQUIRED") {
      showAuthMessage(error.message || "Nao foi possivel criar o administrador.", "warn");
    }
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  if (!state.serverReady) {
    showAuthMessage("Servidor offline. Rode npm run dev localmente ou publique a API na Vercel.", "warn");
    return;
  }

  try {
    const authStatus = await fetchJson("/auth/login", {
      method: "POST",
      authRoute: true,
      body: {
        username: refs.loginUsername.value.trim(),
        password: refs.loginPassword.value
      }
    });

    refs.loginForm.reset();
    applyAuthStatus(authStatus);
    await loadProtectedData({ attemptMigration: true });
    showAppMessage("Login realizado com sucesso.");
  } catch (error) {
    if (error.message !== "AUTH_REQUIRED") {
      showAuthMessage(error.message || "Nao foi possivel entrar.", "warn");
    }
  }
}

async function handleLogout() {
  if (!state.serverReady) {
    return;
  }

  try {
    await fetchJson("/auth/logout", {
      method: "POST",
      authRoute: true
    });
  } catch (error) {
    console.error(error);
  }

  state.authenticated = false;
  state.currentUser = null;
  state.setupRequired = false;
  clearProtectedState();
  render();
  showAuthMessage("Sessao encerrada.");
}

async function handleUserSubmit(event) {
  event.preventDefault();

  if (!ensureAdminAccess()) {
    return;
  }

  const username = refs.userUsername.value.trim();
  const password = refs.userPassword.value;
  const passwordConfirm = refs.userPasswordConfirm.value;

  if (username.length < 3) {
    showAppMessage("Use um usuario com pelo menos 3 caracteres.", "warn");
    refs.userUsername.focus();
    return;
  }

  if (password.length < 6) {
    showAppMessage("Use uma senha com pelo menos 6 caracteres.", "warn");
    refs.userPassword.focus();
    return;
  }

  if (password !== passwordConfirm) {
    showAppMessage("A confirmacao da senha nao confere.", "warn");
    refs.userPasswordConfirm.focus();
    return;
  }

  try {
    await fetchJson("/users", {
      method: "POST",
      body: {
        username,
        password,
        role: refs.userRole.value
      }
    });

    refs.userForm.reset();
    refs.userRole.value = "operator";
    await refreshState();
    showAppMessage("Conta criada com sucesso.");
  } catch (error) {
    if (error.message !== "AUTH_REQUIRED") {
      showAppMessage(error.message || "Nao foi possivel criar a conta.", "warn");
    }
  }
}

function handleUserListActions(event) {
  const button = event.target.closest("button[data-user-action]");

  if (!button) {
    return;
  }

  if (button.dataset.userAction === "delete") {
    void deleteUserAccount(button.dataset.id);
  }
}

async function deleteUserAccount(userId) {
  if (!ensureAdminAccess()) {
    return;
  }

  const user = state.users.find((item) => item.id === userId);

  if (!user) {
    return;
  }

  const confirmed = window.confirm(`Excluir a conta "${user.username}"?`);

  if (!confirmed) {
    return;
  }

  try {
    await fetchJson(`/users/${encodeURIComponent(userId)}`, {
      method: "DELETE"
    });

    await refreshState();
    showAppMessage("Conta excluida com sucesso.", "warn");
  } catch (error) {
    if (error.message !== "AUTH_REQUIRED") {
      showAppMessage(error.message || "Nao foi possivel excluir a conta.", "warn");
    }
  }
}

async function handleMaterialSubmit(event) {
  event.preventDefault();

  if (!ensureAuthenticated()) {
    return;
  }

  const materialData = {
    name: refs.materialName.value.trim(),
    category: refs.materialCategory.value.trim(),
    unit: refs.materialUnit.value.trim() || "un",
    stock: Math.max(0, parseNumber(refs.materialStock.value)),
    minStock: Math.max(0, parseNumber(refs.materialMinStock.value)),
    costPrice: Math.max(0, parseNumber(refs.materialCostPrice.value)),
    salePrice: Math.max(0, parseNumber(refs.materialSalePrice.value)),
    supplier: refs.materialSupplier.value.trim()
  };

  if (!materialData.name) {
    window.alert("Informe o nome do material.");
    refs.materialName.focus();
    return;
  }

  try {
    const isEditing = Boolean(state.editingMaterialId);

    if (isEditing) {
      await fetchJson(`/materials/${encodeURIComponent(state.editingMaterialId)}`, {
        method: "PUT",
        body: materialData
      });
    } else {
      await fetchJson("/materials", {
        method: "POST",
        body: materialData
      });
    }

    resetMaterialForm();
    await refreshState();
    showAppMessage(isEditing ? "Material atualizado com sucesso." : "Material salvo com sucesso.");
  } catch (error) {
    if (error.message !== "AUTH_REQUIRED") {
      showAppMessage(error.message || "Nao foi possivel salvar o material.", "warn");
    }
  }
}

async function handleMovementSubmit(event) {
  event.preventDefault();

  if (!ensureAuthenticated()) {
    return;
  }

  if (!state.materials.length) {
    window.alert("Cadastre um material antes de registrar movimentacoes.");
    return;
  }

  const type = refs.movementType.value;
  const quantity = Math.max(0, parseNumber(refs.movementQuantity.value));

  if (quantity < 0 || (type !== "adjustment" && quantity <= 0)) {
    window.alert("Informe uma quantidade valida para a movimentacao.");
    refs.movementQuantity.focus();
    return;
  }

  try {
    await fetchJson("/movements", {
      method: "POST",
      body: {
        materialId: refs.movementMaterial.value,
        type,
        quantity,
        unitPrice: Math.max(0, parseNumber(refs.movementUnitPrice.value)),
        note: refs.movementNote.value.trim()
      }
    });

    refs.movementForm.reset();
    refs.movementType.value = "entry";
    refs.movementQuantity.value = "1";
    refs.movementUnitPrice.value = "0";
    await refreshState();
    showAppMessage("Movimentacao registrada com sucesso.");
  } catch (error) {
    if (error.message !== "AUTH_REQUIRED") {
      showAppMessage(error.message || "Nao foi possivel registrar a movimentacao.", "warn");
    }
  }
}

function handleSearchInput(event) {
  state.filters.search = event.target.value.trim();
  renderMaterialsTable();
}

function handleStatusFilter(event) {
  state.filters.status = event.target.value;
  renderMaterialsTable();
}

function handleTableActions(event) {
  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const materialId = button.dataset.id;

  if (action === "edit") {
    startMaterialEdit(materialId);
  }

  if (action === "delete") {
    void deleteMaterial(materialId);
  }
}

function startMaterialEdit(materialId) {
  const material = state.materials.find((item) => item.id === materialId);

  if (!material) {
    return;
  }

  state.editingMaterialId = materialId;
  refs.materialId.value = material.id;
  refs.materialName.value = material.name;
  refs.materialCategory.value = material.category || "";
  refs.materialUnit.value = material.unit || "un";
  refs.materialStock.value = material.stock;
  refs.materialMinStock.value = material.minStock;
  refs.materialCostPrice.value = material.costPrice;
  refs.materialSalePrice.value = material.salePrice;
  refs.materialSupplier.value = material.supplier || "";
  refs.materialStock.disabled = true;
  refs.materialFormTitle.textContent = "Editar material";
  refs.materialSubmitButton.textContent = "Atualizar material";
  refs.cancelEditButton.classList.remove("hidden");
  refs.materialName.focus();
}

function resetMaterialForm() {
  state.editingMaterialId = null;
  refs.materialForm.reset();
  refs.materialId.value = "";
  refs.materialUnit.value = "un";
  refs.materialStock.value = "0";
  refs.materialMinStock.value = "0";
  refs.materialCostPrice.value = "0";
  refs.materialSalePrice.value = "0";
  refs.materialStock.disabled = false;
  refs.materialFormTitle.textContent = "Novo material";
  refs.materialSubmitButton.textContent = "Salvar material";
  refs.cancelEditButton.classList.add("hidden");
}

async function deleteMaterial(materialId) {
  if (!ensureAuthenticated()) {
    return;
  }

  const material = state.materials.find((item) => item.id === materialId);

  if (!material) {
    return;
  }

  const confirmed = window.confirm(`Excluir o material "${material.name}" e o historico relacionado?`);

  if (!confirmed) {
    return;
  }

  try {
    await fetchJson(`/materials/${encodeURIComponent(materialId)}`, {
      method: "DELETE"
    });

    if (state.editingMaterialId === materialId) {
      resetMaterialForm();
    }

    await refreshState();
    showAppMessage("Material excluido com sucesso.", "warn");
  } catch (error) {
    if (error.message !== "AUTH_REQUIRED") {
      showAppMessage(error.message || "Nao foi possivel excluir o material.", "warn");
    }
  }
}

function render() {
  renderAuthState();

  if (!state.authenticated) {
    return;
  }

  updateStorageStatus();
  renderUsersPanel();
  renderSummary();
  renderMovementSelect();
  renderAlerts();
  renderPurchaseReport();
  renderExportButtons();
  renderMaterialsTable();
  renderMovementList();
}

function renderAuthState() {
  const showAuth = !state.authenticated;
  const showSetup = showAuth && state.serverReady && state.setupRequired;
  const showLogin = showAuth && state.serverReady && !state.setupRequired;

  refs.authShell.classList.toggle("hidden", !showAuth);
  refs.appShell.classList.toggle("hidden", showAuth);
  refs.setupPanel.classList.toggle("hidden", !showSetup);
  refs.loginPanel.classList.toggle("hidden", !showLogin);
  refs.setupSubmitButton.disabled = !state.serverReady;
  refs.loginSubmitButton.disabled = !state.serverReady;
}

function renderUsersPanel() {
  const isAdmin = isCurrentUserAdmin();

  refs.usersPanel.classList.toggle("hidden", !isAdmin);

  if (!isAdmin) {
    return;
  }

  refs.userSubmitButton.disabled = !state.serverReady;

  if (!state.users.length) {
    refs.userList.innerHTML = `
      <div class="empty-state">
        <strong>Nenhuma conta cadastrada.</strong>
        <p>Crie um usuario novo para liberar acesso a outras pessoas.</p>
      </div>
    `;
    return;
  }

  refs.userList.innerHTML = state.users
    .map((user) => {
      const isCurrentUser = state.currentUser?.id === user.id;
      const canDelete = !isCurrentUser;
      const helperText = isCurrentUser ? "Conta atual" : `Criado em ${formatDate(user.createdAt)}`;

      return `
        <article class="user-card">
          <div class="user-card-meta">
            <strong>${escapeHtml(user.username)}</strong>
            <span class="user-role-badge ${escapeHtml(user.role)}">${escapeHtml(getRoleLabel(user.role))}</span>
            <p>${escapeHtml(helperText)}</p>
          </div>

          <div class="user-card-actions">
            <button
              class="table-button table-button-danger"
              type="button"
              data-user-action="delete"
              data-id="${user.id}"
              ${canDelete ? "" : "disabled"}
            >
              Excluir
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function updateStorageStatus() {
  const storagePresentation = getStorageModePresentation(state.storageMode);

  refs.storageModeChip.textContent = storagePresentation.chipText;
  refs.storageModeText.textContent = storagePresentation.bodyText;

  if (state.currentUser) {
    refs.currentUserChip.textContent = `${state.currentUser.username} (${state.currentUser.role})`;
    refs.currentUserChip.classList.remove("hidden");
  } else {
    refs.currentUserChip.classList.add("hidden");
  }

  refs.materialSubmitButton.disabled = false;
}

function renderSummary() {
  const totalMaterials = state.materials.length;
  const totalStock = state.materials.reduce((sum, material) => sum + material.stock, 0);
  const totalValue = state.materials.reduce((sum, material) => sum + material.stock * material.costPrice, 0);
  const lowStockCount = state.materials.filter((material) => material.stock <= material.minStock).length;

  refs.statTotalMaterials.textContent = totalMaterials;
  refs.statTotalStock.textContent = formatNumber(totalStock);
  refs.statTotalValue.textContent = formatCurrency(totalValue);
  refs.statLowStock.textContent = lowStockCount;
}

function renderMovementSelect() {
  if (!state.authenticated || !state.serverReady) {
    refs.movementMaterial.innerHTML = '<option value="">Entre no sistema primeiro</option>';
    refs.movementMaterial.disabled = true;
    refs.movementType.disabled = true;
    refs.movementQuantity.disabled = true;
    refs.movementUnitPrice.disabled = true;
    refs.movementNote.disabled = true;
    refs.movementSubmitButton.disabled = true;
    return;
  }

  if (!state.materials.length) {
    refs.movementMaterial.innerHTML = '<option value="">Cadastre um material primeiro</option>';
    refs.movementMaterial.disabled = true;
    refs.movementType.disabled = true;
    refs.movementQuantity.disabled = true;
    refs.movementUnitPrice.disabled = true;
    refs.movementNote.disabled = true;
    refs.movementSubmitButton.disabled = true;
    return;
  }

  refs.movementMaterial.disabled = false;
  refs.movementType.disabled = false;
  refs.movementQuantity.disabled = false;
  refs.movementUnitPrice.disabled = false;
  refs.movementNote.disabled = false;
  refs.movementSubmitButton.disabled = false;

  const currentValue = refs.movementMaterial.value;
  const optionsMarkup = state.materials
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"))
    .map((material) => {
      const selected = material.id === currentValue ? "selected" : "";
      return `<option value="${material.id}" ${selected}>${escapeHtml(material.name)}</option>`;
    })
    .join("");

  refs.movementMaterial.innerHTML = optionsMarkup;

  if (!state.materials.some((material) => material.id === currentValue)) {
    refs.movementMaterial.value = state.materials[0].id;
  }
}

function renderAlerts() {
  const materialsInAlert = state.materials
    .filter((material) => material.stock <= material.minStock)
    .sort((left, right) => left.stock - right.stock || left.name.localeCompare(right.name, "pt-BR"));

  if (!materialsInAlert.length) {
    refs.alertList.innerHTML = `
      <div class="empty-state">
        <strong>Nenhum alerta aberto.</strong>
        <p>Quando algum item atingir o estoque minimo, ele aparece aqui.</p>
      </div>
    `;
    return;
  }

  refs.alertList.innerHTML = materialsInAlert
    .map((material) => {
      const isCritical = material.stock === 0;
      const cardClass = isCritical ? "alert-card critical" : "alert-card warning";
      const statusText = isCritical ? "Sem estoque" : "Abaixo do minimo";

      return `
        <article class="${cardClass}">
          <div>
            <strong>${escapeHtml(material.name)}</strong>
            <p>${escapeHtml(material.category || "Sem categoria")}</p>
          </div>
          <div class="alert-meta">
            <span>${statusText}</span>
            <span>${formatNumber(material.stock)} ${escapeHtml(material.unit)} / minimo ${formatNumber(material.minStock)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderMaterialsTable() {
  const filteredMaterials = getFilteredMaterials();

  if (!filteredMaterials.length) {
    refs.materialsTableBody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state empty-state-table">
            <strong>Nenhum material encontrado.</strong>
            <p>Cadastre um item novo ou ajuste os filtros.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  refs.materialsTableBody.innerHTML = filteredMaterials
    .map((material) => {
      const status = getStockStatus(material);

      return `
        <tr>
          <td>
            <div class="material-name">
              <strong>${escapeHtml(material.name)}</strong>
              <span>${escapeHtml(material.supplier || "Sem fornecedor")}</span>
            </div>
          </td>
          <td>${escapeHtml(material.category || "-")}</td>
          <td>${formatNumber(material.stock)} ${escapeHtml(material.unit)}</td>
          <td>${formatNumber(material.minStock)} ${escapeHtml(material.unit)}</td>
          <td>${formatCurrency(material.costPrice)}</td>
          <td>${formatCurrency(material.salePrice)}</td>
          <td><span class="status-badge ${status.tone}">${status.label}</span></td>
          <td>
            <div class="action-group">
              <button class="table-button" type="button" data-action="edit" data-id="${material.id}">Editar</button>
              <button class="table-button table-button-danger" type="button" data-action="delete" data-id="${material.id}">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderMovementList() {
  const recentMovements = state.movements
    .slice()
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, 8);

  if (!recentMovements.length) {
    refs.movementList.innerHTML = `
      <div class="empty-state">
        <strong>Nenhuma movimentacao registrada.</strong>
        <p>Use o formulario acima para gravar entradas, saidas ou ajustes.</p>
      </div>
    `;
    return;
  }

  refs.movementList.innerHTML = recentMovements
    .map((movement) => {
      const movementLabel = getMovementLabel(movement);
      const noteMarkup = movement.note ? `<p>${escapeHtml(movement.note)}</p>` : "";
      const priceMarkup = movement.unitPrice > 0 ? `<span>${formatCurrency(movement.unitPrice)} por ${escapeHtml(movement.unit)}</span>` : "";

      return `
        <article class="movement-card">
          <div>
            <strong>${escapeHtml(movement.materialName)}</strong>
            <p>${movementLabel}</p>
            ${noteMarkup}
          </div>
          <div class="movement-meta">
            <span>${formatDate(movement.createdAt)}</span>
            <span>Estoque: ${formatNumber(movement.previousStock)} -> ${formatNumber(movement.newStock)}</span>
            ${priceMarkup}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderPurchaseReport() {
  const purchaseSuggestions = getPurchaseSuggestions();
  const totalQuantity = purchaseSuggestions.reduce((sum, item) => sum + item.suggestedQuantity, 0);
  const totalCost = purchaseSuggestions.reduce((sum, item) => sum + item.estimatedCost, 0);

  refs.purchaseItemsCount.textContent = purchaseSuggestions.length;
  refs.purchaseTotalQuantity.textContent = formatNumber(totalQuantity);
  refs.purchaseTotalCost.textContent = formatCurrency(totalCost);

  if (!purchaseSuggestions.length) {
    refs.purchaseReportList.innerHTML = `
      <div class="empty-state">
        <strong>Nenhuma compra urgente agora.</strong>
        <p>Quando algum item ficar abaixo do minimo ou zerar, a lista aparece aqui.</p>
      </div>
    `;
    return;
  }

  refs.purchaseReportList.innerHTML = purchaseSuggestions
    .map((item) => {
      const toneClass = item.stock === 0 ? "purchase-card critical" : "purchase-card warning";
      const costText = item.costPrice > 0 ? formatCurrency(item.estimatedCost) : "Sem preco cadastrado";

      return `
        <article class="${toneClass}">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <p>${escapeHtml(item.category)}</p>
            <p>${escapeHtml(item.supplier)}</p>
          </div>
          <div class="purchase-meta">
            <span>${item.priorityLabel}</span>
            <span>Atual: ${formatNumber(item.stock)} ${escapeHtml(item.unit)} / minimo ${formatNumber(item.minStock)}</span>
            <span>Comprar: ${formatNumber(item.suggestedQuantity)} ${escapeHtml(item.unit)}</span>
            <span>Custo: ${costText}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderExportButtons() {
  refs.exportMaterialsButton.disabled = false;
  refs.exportMovementsButton.disabled = false;
  refs.exportPurchasesButton.disabled = false;
}

function getPurchaseSuggestions() {
  return state.materials
    .filter((material) => material.stock < material.minStock || material.stock === 0)
    .map((material) => {
      const missingQuantity = Math.max(material.minStock - material.stock, 0);
      const suggestedQuantity = missingQuantity > 0 ? missingQuantity : 1;

      return {
        id: material.id,
        name: material.name,
        category: material.category || "Sem categoria",
        supplier: material.supplier || "Sem fornecedor",
        unit: material.unit,
        stock: material.stock,
        minStock: material.minStock,
        costPrice: material.costPrice,
        suggestedQuantity,
        estimatedCost: suggestedQuantity * material.costPrice,
        priorityLabel: material.stock === 0 ? "Sem estoque" : "Abaixo do minimo"
      };
    })
    .sort((left, right) => {
      const leftPriority = left.stock === 0 ? 0 : 1;
      const rightPriority = right.stock === 0 ? 0 : 1;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.name.localeCompare(right.name, "pt-BR");
    });
}

function exportMaterialsReport() {
  if (!state.materials.length) {
    showAppMessage("Cadastre pelo menos um material antes de exportar o estoque.", "warn");
    return;
  }

  const rows = [
    ["Material", "Categoria", "Fornecedor", "Unidade", "Estoque Atual", "Estoque Minimo", "Preco Compra", "Preco Venda", "Status", "Valor em Estoque"]
  ];

  state.materials
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"))
    .forEach((material) => {
      rows.push([
        material.name,
        material.category || "",
        material.supplier || "",
        material.unit,
        formatNumber(material.stock),
        formatNumber(material.minStock),
        formatNumber(material.costPrice),
        formatNumber(material.salePrice),
        getStockStatus(material).label,
        formatNumber(material.stock * material.costPrice)
      ]);
    });

  downloadCsv(createExportFileName("estoque"), rows);
  showAppMessage("Arquivo de estoque exportado.");
}

function exportMovementsReport() {
  if (!state.movements.length) {
    showAppMessage("Registre movimentacoes antes de exportar esse relatorio.", "warn");
    return;
  }

  const rows = [
    ["Data", "Material", "Tipo", "Quantidade", "Unidade", "Preco Unitario", "Estoque Anterior", "Estoque Atual", "Observacao"]
  ];

  state.movements
    .slice()
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .forEach((movement) => {
      rows.push([
        formatDate(movement.createdAt),
        movement.materialName,
        getMovementTypeName(movement.type),
        formatNumber(movement.quantity),
        movement.unit,
        formatNumber(movement.unitPrice),
        formatNumber(movement.previousStock),
        formatNumber(movement.newStock),
        movement.note || ""
      ]);
    });

  downloadCsv(createExportFileName("movimentacoes"), rows);
  showAppMessage("Arquivo de movimentacoes exportado.");
}

function exportPurchasesReport() {
  const purchaseSuggestions = getPurchaseSuggestions();

  if (!purchaseSuggestions.length) {
    showAppMessage("Nao ha itens em reposicao para exportar agora.", "warn");
    return;
  }

  const rows = [
    ["Material", "Categoria", "Fornecedor", "Estoque Atual", "Estoque Minimo", "Quantidade Sugerida", "Unidade", "Preco Compra", "Custo Estimado", "Prioridade"]
  ];

  purchaseSuggestions.forEach((item) => {
    rows.push([
      item.name,
      item.category,
      item.supplier,
      formatNumber(item.stock),
      formatNumber(item.minStock),
      formatNumber(item.suggestedQuantity),
      item.unit,
      formatNumber(item.costPrice),
      formatNumber(item.estimatedCost),
      item.priorityLabel
    ]);
  });

  downloadCsv(createExportFileName("compras"), rows);
  showAppMessage("Arquivo de compras exportado.");
}

async function loadProtectedData({ attemptMigration = false } = {}) {
  let bootstrapData = await fetchJson("/bootstrap");

  if (attemptMigration) {
    const migrated = await maybeMigrateLegacyBrowserData(bootstrapData);

    if (migrated) {
      bootstrapData = await fetchJson("/bootstrap");
      showAppMessage("Dados antigos migrados para o banco atual.");
    }
  }

  applyBootstrapData(bootstrapData);
  render();
}

async function refreshState() {
  const bootstrapData = await fetchJson("/bootstrap");
  applyBootstrapData(bootstrapData);
  render();
}

function applyAuthStatus(authStatus) {
  state.setupRequired = Boolean(authStatus.setupRequired);
  state.authenticated = Boolean(authStatus.authenticated);
  state.currentUser = authStatus.user || null;

  if (!state.authenticated) {
    state.currentUser = null;
  }
}

function applyBootstrapData(bootstrapData) {
  state.materials = Array.isArray(bootstrapData.materials) ? bootstrapData.materials : [];
  state.movements = Array.isArray(bootstrapData.movements) ? bootstrapData.movements : [];
  state.users = Array.isArray(bootstrapData.users) ? bootstrapData.users : [];
  state.storageMode = bootstrapData.storageMode || "sqlite-local";
}

function clearProtectedState() {
  state.materials = [];
  state.movements = [];
  state.users = [];
  state.editingMaterialId = null;
  resetMaterialForm();
}

async function maybeMigrateLegacyBrowserData(bootstrapData) {
  if (!Array.isArray(bootstrapData.materials) || !Array.isArray(bootstrapData.movements)) {
    return false;
  }

  if (bootstrapData.materials.length || bootstrapData.movements.length) {
    return false;
  }

  const legacyMaterials = loadLegacyCollection(LEGACY_MATERIALS_KEY);
  const legacyMovements = loadLegacyCollection(LEGACY_MOVEMENTS_KEY);

  if (!legacyMaterials.length && !legacyMovements.length) {
    return false;
  }

  await fetchJson("/import", {
    method: "POST",
    body: {
      materials: legacyMaterials,
      movements: legacyMovements
    }
  });

  localStorage.removeItem(LEGACY_MATERIALS_KEY);
  localStorage.removeItem(LEGACY_MOVEMENTS_KEY);

  return true;
}

function loadLegacyCollection(key) {
  try {
    const rawValue = localStorage.getItem(key);
    const parsedValue = JSON.parse(rawValue);

    return Array.isArray(parsedValue) ? parsedValue : [];
  } catch (error) {
    return [];
  }
}

async function fetchJson(endpoint, options = {}) {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    credentials: "same-origin",
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const responseText = await response.text();
  const responseData = responseText ? safeParseJson(responseText) : null;

  if (!response.ok) {
    if (response.status === 401 && !options.authRoute) {
      handleUnauthorizedState(responseData?.error || "Sua sessao expirou. Entre novamente.");
      throw new Error("AUTH_REQUIRED");
    }

    throw new Error(responseData?.error || `Erro HTTP ${response.status}`);
  }

  return responseData;
}

function handleUnauthorizedState(message) {
  state.authenticated = false;
  state.currentUser = null;
  state.setupRequired = false;
  clearProtectedState();
  render();
  showAuthMessage(message, "warn");
}

function ensureAuthenticated() {
  if (state.serverReady && state.authenticated) {
    return true;
  }

  showAuthMessage("Entre no sistema para continuar.", "warn");
  render();
  return false;
}

function ensureAdminAccess() {
  if (!ensureAuthenticated()) {
    return false;
  }

  if (isCurrentUserAdmin()) {
    return true;
  }

  showAppMessage("Somente administrador pode criar ou excluir contas.", "warn");
  return false;
}

function isCurrentUserAdmin() {
  return state.currentUser?.role === "admin";
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function getStorageModePresentation(storageMode) {
  if (storageMode === "libsql-remote") {
    return {
      chipText: "Banco real: Turso / libSQL",
      bodyText: "Os dados ficam em banco remoto compativel com Vercel e continuam protegidos por login."
    };
  }

  if (storageMode === "sqlite-local") {
    return {
      chipText: "Banco local: SQLite",
      bodyText: "Os dados ficam salvos no arquivo SQLite do projeto e sao protegidos por login."
    };
  }

  return {
    chipText: "Banco: conectado",
    bodyText: "Os dados do sistema estao sendo carregados do banco configurado."
  };
}

function downloadCsv(fileName, rows) {
  const csvContent = "\uFEFF" + rows.map((row) => row.map(toCsvCell).join(";")).join("\r\n");
  const fileBlob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const fileUrl = URL.createObjectURL(fileBlob);
  const link = document.createElement("a");

  link.href = fileUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1500);
}

function toCsvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function createExportFileName(prefix) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${prefix}-${year}-${month}-${day}.csv`;
}

function showAuthMessage(text, tone = "info") {
  showBanner(refs.authMessage, text, tone);
}

function showAppMessage(text, tone = "info") {
  showBanner(refs.appMessage, text, tone);
}

function showBanner(element, text, tone = "info") {
  element.textContent = text;
  element.className = `app-message ${tone}`;

  const timeoutId = bannerTimeouts.get(element);

  if (timeoutId) {
    window.clearTimeout(timeoutId);
  }

  bannerTimeouts.set(element, window.setTimeout(() => {
    element.className = "app-message hidden";
    element.textContent = "";
  }, 4000));
}

function getFilteredMaterials() {
  const searchTerm = normalizeText(state.filters.search);

  return state.materials
    .filter((material) => {
      const matchesSearch =
        !searchTerm ||
        normalizeText(`${material.name} ${material.category} ${material.supplier}`).includes(searchTerm);

      if (!matchesSearch) {
        return false;
      }

      if (state.filters.status === "critical") {
        return material.stock === 0;
      }

      if (state.filters.status === "low") {
        return material.stock > 0 && material.stock <= material.minStock;
      }

      if (state.filters.status === "normal") {
        return material.stock > material.minStock;
      }

      return true;
    })
    .slice()
    .sort((left, right) => {
      const leftStatus = getStockPriority(left);
      const rightStatus = getStockPriority(right);

      if (leftStatus !== rightStatus) {
        return leftStatus - rightStatus;
      }

      return left.name.localeCompare(right.name, "pt-BR");
    });
}

function getStockPriority(material) {
  if (material.stock === 0) {
    return 0;
  }

  if (material.stock <= material.minStock) {
    return 1;
  }

  return 2;
}

function getStockStatus(material) {
  if (material.stock === 0) {
    return { label: "Sem estoque", tone: "danger" };
  }

  if (material.stock <= material.minStock) {
    return { label: "Estoque baixo", tone: "warning" };
  }

  return { label: "Normal", tone: "success" };
}

function getMovementLabel(movement) {
  if (movement.type === "entry") {
    return `Entrada de ${formatNumber(movement.quantity)} ${movement.unit}`;
  }

  if (movement.type === "exit") {
    return `Saida de ${formatNumber(movement.quantity)} ${movement.unit}`;
  }

  return `Ajuste para ${formatNumber(movement.newStock)} ${movement.unit}`;
}

function getMovementTypeName(type) {
  if (type === "entry") {
    return "Entrada";
  }

  if (type === "exit") {
    return "Saida";
  }

  return "Ajuste";
}

function getRoleLabel(role) {
  if (role === "admin") {
    return "Administrador";
  }

  return "Operador";
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value || 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(value || 0);
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(dateString));
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const stringValue = String(value).trim();
  const normalizedValue = stringValue.includes(",")
    ? stringValue.replace(/\./g, "").replace(",", ".")
    : stringValue;
  const parsedValue = Number(normalizedValue);

  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE_MAP[character]);
}
