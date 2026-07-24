// Accès défensif à l'API Tauri : permet aussi un aperçu visuel dans un
// navigateur classique (sans backend Rust) pendant le travail de design.
const TAURI = window.__TAURI__ ?? null;
const invoke = TAURI ? TAURI.core.invoke : async () => {
  throw new Error("Tauri indisponible (aperçu navigateur)");
};
const openDialog = TAURI ? TAURI.dialog.open : async () => null;
const saveDialog = TAURI ? TAURI.dialog.save : async () => null;
const writeTextFile = TAURI ? TAURI.fs.writeTextFile : async () => {};

const KNOWN_IDENTITIES_KEY = "kleido:known-identities";
const ONBOARDING_SEEN_KEY = "kleido:onboarding-seen";

let currentUsername = null;
let currentPublicKey = null;
let signFilePath = null;
let verifyFilePath = null;
let activeMainPanel = "sign";
let activeSignMode = "text";
let activeVerifyMode = "text";

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

function setStatus(el, message, kind) {
  el.textContent = message;
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function basename(path) {
  return path.split(/[\\/]/).pop();
}

function hashHue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Fait clignoter une icon-btn en check (succès) ou x (échec) puis restaure l'icône d'origine. */
function flashButton(button, ok) {
  const use = button.querySelector("use");
  const original = use ? use.getAttribute("href") : null;
  button.classList.add(ok ? "flash-ok" : "flash-err");
  if (use) use.setAttribute("href", ok ? "#i-check" : "#i-x");
  setTimeout(() => {
    button.classList.remove("flash-ok", "flash-err");
    if (use && original) use.setAttribute("href", original);
  }, 1100);
}

async function copyWithFeedback(button, text) {
  const ok = await copyToClipboard(text);
  flashButton(button, ok);
  return ok;
}

async function exportText(defaultName, content) {
  const path = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: "Texte", extensions: ["txt"] }],
  });
  if (!path) return false;
  await writeTextFile(path, content);
  return true;
}

/** Désactive un bouton et affiche un spineur pendant l'exécution de `fn`. */
async function withBusy(button, fn) {
  button.disabled = true;
  button.classList.add("is-busy");
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

function getKnownIdentities() {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_IDENTITIES_KEY) || "[]");
  } catch {
    return [];
  }
}

function rememberIdentity(name) {
  const list = getKnownIdentities().filter((n) => n !== name);
  list.unshift(name);
  localStorage.setItem(KNOWN_IDENTITIES_KEY, JSON.stringify(list.slice(0, 8)));
}

function forgetIdentity(name) {
  const list = getKnownIdentities().filter((n) => n !== name);
  localStorage.setItem(KNOWN_IDENTITIES_KEY, JSON.stringify(list));
}

/** Construit une commande de segmented control : bascule active + fait glisser le curseur. */
function setupSegmented(navEl, thumbEl, onSelect) {
  const buttons = [...navEl.querySelectorAll(".segmented-btn")];
  function activate(index) {
    buttons.forEach((b, i) => b.classList.toggle("active", i === index));
    thumbEl.style.transform = `translateX(${index * 100}%)`;
  }
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => {
      activate(i);
      onSelect(b.dataset, i);
    });
  });
  activate(0);
  return { activate };
}

window.addEventListener("DOMContentLoaded", () => {
  // ---------------------------------------------------------------------
  // Identité
  // ---------------------------------------------------------------------
  const usernameEl = document.querySelector("#username");
  const btnGenerate = document.querySelector("#btn-generate");
  const btnLoad = document.querySelector("#btn-load");
  const btnDelete = document.querySelector("#btn-delete");
  const btnSwitchIdentity = document.querySelector("#btn-switch-identity");
  const identityStatus = document.querySelector("#identity-status");
  const identityEmpty = document.querySelector("#identity-empty");
  const identityActive = document.querySelector("#identity-active");
  const identityAvatar = document.querySelector("#identity-avatar");
  const identityNameLabel = document.querySelector("#identity-name-label");
  const identityFingerprint = document.querySelector("#identity-fingerprint");
  const btnCopyPubkey = document.querySelector("#btn-copy-pubkey");
  const btnExportPubkey = document.querySelector("#btn-export-pubkey");
  const knownChipsEl = document.querySelector("#known-chips");
  const signNotice = document.querySelector("#sign-notice");
  const btnSignText = document.querySelector("#btn-sign-text");
  const btnSignFile = document.querySelector("#btn-sign-file");

  function refreshIdentityGates() {
    const ready = Boolean(currentUsername && currentPublicKey);
    btnSignText.disabled = !ready;
    btnSignFile.disabled = !ready || !signFilePath;
    if (ready) hide(signNotice);
    else show(signNotice);
  }

  function renderKnownChips() {
    const list = getKnownIdentities();
    knownChipsEl.innerHTML = "";
    for (const name of list) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = name;
      chip.addEventListener("click", () => {
        usernameEl.value = name;
        loadIdentity(name);
      });
      knownChipsEl.appendChild(chip);
    }
  }

  function applyIdentity(username, publicHex) {
    currentUsername = username;
    currentPublicKey = publicHex;
    identityAvatar.textContent = username.charAt(0).toUpperCase();
    identityAvatar.style.background = `hsl(${hashHue(publicHex)} 62% 42%)`;
    identityNameLabel.textContent = username;
    identityFingerprint.textContent = `${publicHex.slice(0, 8)}…${publicHex.slice(-8)}`;
    identityFingerprint.title = publicHex;
    hide(identityEmpty);
    show(identityActive);
    rememberIdentity(username);
    renderKnownChips();
    refreshIdentityGates();
  }

  function resetIdentity() {
    currentUsername = null;
    currentPublicKey = null;
    hide(identityActive);
    show(identityEmpty);
    refreshIdentityGates();
  }

  async function generateIdentity(username) {
    setStatus(identityStatus, "Génération en cours…");
    try {
      const publicHex = await invoke("generate_identity", { username });
      applyIdentity(username, publicHex);
      setStatus(identityStatus, `Identité « ${username} » créée et stockée dans le trousseau système.`, "ok");
    } catch (err) {
      setStatus(identityStatus, String(err), "error");
    }
  }

  async function loadIdentity(username) {
    setStatus(identityStatus, "Chargement…");
    try {
      const publicHex = await invoke("get_public_key", { username });
      applyIdentity(username, publicHex);
      setStatus(identityStatus, `Identité « ${username} » chargée.`, "ok");
    } catch (err) {
      setStatus(identityStatus, String(err), "error");
    }
  }

  btnGenerate.addEventListener("click", () =>
    withBusy(btnGenerate, async () => {
      const username = usernameEl.value.trim();
      if (!username) {
        setStatus(identityStatus, "Entrez un nom d'identité.", "error");
        return;
      }
      await generateIdentity(username);
    })
  );

  btnLoad.addEventListener("click", () =>
    withBusy(btnLoad, async () => {
      const username = usernameEl.value.trim();
      if (!username) {
        setStatus(identityStatus, "Entrez un nom d'identité.", "error");
        return;
      }
      await loadIdentity(username);
    })
  );

  btnSwitchIdentity.addEventListener("click", () => {
    resetIdentity();
    usernameEl.value = currentUsername ?? "";
    usernameEl.focus();
  });

  btnDelete.addEventListener("click", () =>
    withBusy(btnDelete, async () => {
      if (!currentUsername) return;
      if (!confirm(`Supprimer définitivement l'identité « ${currentUsername} » du trousseau système ?`)) {
        return;
      }
      try {
        await invoke("delete_identity", { username: currentUsername });
        forgetIdentity(currentUsername);
        renderKnownChips();
        resetIdentity();
        setStatus(identityStatus, "Identité supprimée du trousseau système.", "ok");
      } catch (err) {
        setStatus(identityStatus, String(err), "error");
      }
    })
  );

  btnCopyPubkey.addEventListener("click", () => copyWithFeedback(btnCopyPubkey, currentPublicKey || ""));
  btnExportPubkey.addEventListener("click", async () => {
    try {
      const ok = await exportText(`${currentUsername}-cle-publique.txt`, currentPublicKey || "");
      if (ok) setStatus(identityStatus, "Clé publique exportée.", "ok");
    } catch (err) {
      setStatus(identityStatus, String(err), "error");
    }
  });

  // ---------------------------------------------------------------------
  // Sauvegarde de la clé privée (phrase de récupération, façon Ledger)
  // ---------------------------------------------------------------------
  const btnOpenBackup = document.querySelector("#btn-open-backup");
  const backupOverlay = document.querySelector("#backup-modal-overlay");
  const btnCloseBackup = document.querySelector("#btn-close-backup");
  const backupStepWarning = document.querySelector("#backup-step-warning");
  const backupStepReveal = document.querySelector("#backup-step-reveal");
  const backupStepVerify = document.querySelector("#backup-step-verify");
  const backupStepDone = document.querySelector("#backup-step-done");
  const btnBackupReveal = document.querySelector("#btn-backup-reveal");
  const mnemonicRevealGrid = document.querySelector("#mnemonic-reveal-grid");
  const btnBackupNoted = document.querySelector("#btn-backup-noted");
  const mnemonicVerifyFields = document.querySelector("#mnemonic-verify-fields");
  const backupVerifyStatus = document.querySelector("#backup-verify-status");
  const btnBackupVerify = document.querySelector("#btn-backup-verify");
  const backupDoneUsername = document.querySelector("#backup-done-username");
  const btnBackupDone = document.querySelector("#btn-backup-done");

  // Les 24 mots ne vivent qu'en mémoire JS le temps de la vérification —
  // jamais écrits sur disque, jamais dans localStorage, pas de bouton copier.
  let backupWords = null;

  function showBackupStep(step) {
    [backupStepWarning, backupStepReveal, backupStepVerify, backupStepDone].forEach(hide);
    show(step);
  }

  function openBackupModal() {
    if (!currentUsername) return;
    backupWords = null;
    showBackupStep(backupStepWarning);
    show(backupOverlay);
  }

  function closeBackupModal() {
    hide(backupOverlay);
    backupWords = null;
    mnemonicRevealGrid.innerHTML = "";
    mnemonicVerifyFields.innerHTML = "";
  }

  btnOpenBackup.addEventListener("click", openBackupModal);
  btnCloseBackup.addEventListener("click", closeBackupModal);

  btnBackupReveal.addEventListener("click", () =>
    withBusy(btnBackupReveal, async () => {
      try {
        const phrase = await invoke("export_mnemonic", { username: currentUsername });
        backupWords = phrase.trim().split(/\s+/);
        mnemonicRevealGrid.innerHTML = "";
        backupWords.forEach((word, i) => {
          const el = document.createElement("div");
          el.className = "mnemonic-word";
          const index = document.createElement("span");
          index.className = "index";
          index.textContent = `${i + 1}.`;
          const value = document.createElement("span");
          value.textContent = word;
          el.append(index, value);
          mnemonicRevealGrid.appendChild(el);
        });
        showBackupStep(backupStepReveal);
      } catch (err) {
        alert(err);
      }
    })
  );

  function pickChallengeIndices() {
    const indices = new Set();
    while (indices.size < 3) {
      indices.add(Math.floor(Math.random() * 24));
    }
    return [...indices].sort((a, b) => a - b);
  }

  btnBackupNoted.addEventListener("click", () => {
    const challenge = pickChallengeIndices();
    mnemonicVerifyFields.innerHTML = "";
    challenge.forEach((idx) => {
      const row = document.createElement("div");
      row.className = "mnemonic-verify-field";
      const label = document.createElement("label");
      label.textContent = `Mot n°${idx + 1}`;
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.dataset.index = String(idx);
      row.append(label, input);
      mnemonicVerifyFields.appendChild(row);
    });
    setStatus(backupVerifyStatus, "");
    showBackupStep(backupStepVerify);
  });

  btnBackupVerify.addEventListener("click", () => {
    const inputs = [...mnemonicVerifyFields.querySelectorAll("input")];
    const allCorrect = inputs.every((input) => {
      const idx = Number(input.dataset.index);
      return input.value.trim().toLowerCase() === backupWords[idx];
    });
    if (!allCorrect) {
      setStatus(backupVerifyStatus, "Un ou plusieurs mots ne correspondent pas. Vérifiez votre papier.", "error");
      return;
    }
    backupDoneUsername.textContent = currentUsername;
    backupWords = null;
    mnemonicRevealGrid.innerHTML = "";
    showBackupStep(backupStepDone);
  });

  btnBackupDone.addEventListener("click", closeBackupModal);

  // ---------------------------------------------------------------------
  // Restauration depuis une phrase de récupération
  // ---------------------------------------------------------------------
  const btnOpenImport = document.querySelector("#btn-open-import");
  const importOverlay = document.querySelector("#import-modal-overlay");
  const btnCloseImport = document.querySelector("#btn-close-import");
  const importUsernameEl = document.querySelector("#import-username");
  const importPhraseGrid = document.querySelector("#import-phrase-grid");
  const importStatus = document.querySelector("#import-status");
  const btnImportConfirm = document.querySelector("#btn-import-confirm");

  let importWordInputs = [];

  function buildImportPhraseGrid() {
    importPhraseGrid.innerHTML = "";
    importWordInputs = [];
    for (let i = 0; i < 24; i++) {
      const wrap = document.createElement("div");
      wrap.className = "mnemonic-input-word";

      const index = document.createElement("span");
      index.className = "index";
      index.textContent = `${i + 1}.`;

      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;

      // Coller la phrase entière dans une case la distribue automatiquement
      // sur les cases suivantes, plutôt que de forcer une saisie mot par mot.
      input.addEventListener("paste", (e) => {
        const text = e.clipboardData.getData("text");
        const words = text.trim().split(/\s+/).filter(Boolean);
        if (words.length <= 1) return;
        e.preventDefault();
        words.forEach((word, offset) => {
          const target = importWordInputs[i + offset];
          if (target) target.value = word;
        });
        const next = importWordInputs[Math.min(i + words.length, 23)];
        next?.focus();
      });

      // Espace ou Entrée passe au mot suivant, pour une saisie manuelle rapide.
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || (e.key === " " && input.value.trim())) {
          e.preventDefault();
          importWordInputs[i + 1]?.focus();
        }
      });

      wrap.append(index, input);
      importPhraseGrid.appendChild(wrap);
      importWordInputs.push(input);
    }
  }

  function openImportModal() {
    importUsernameEl.value = usernameEl.value.trim();
    buildImportPhraseGrid();
    setStatus(importStatus, "");
    show(importOverlay);
    importWordInputs[0]?.focus();
  }

  function closeImportModal() {
    hide(importOverlay);
    importPhraseGrid.innerHTML = "";
    importWordInputs = [];
  }

  btnOpenImport.addEventListener("click", openImportModal);
  btnCloseImport.addEventListener("click", closeImportModal);

  btnImportConfirm.addEventListener("click", () =>
    withBusy(btnImportConfirm, async () => {
      const username = importUsernameEl.value.trim();
      const words = importWordInputs.map((input) => input.value.trim());
      const phrase = words.join(" ");
      if (!username || words.some((word) => !word)) {
        setStatus(importStatus, "Renseignez le nom et les 24 mots.", "error");
        return;
      }
      try {
        const publicHex = await invoke("import_mnemonic", { username, phrase });
        applyIdentity(username, publicHex);
        closeImportModal();
        setStatus(identityStatus, `Identité « ${username} » restaurée.`, "ok");
      } catch (err) {
        setStatus(importStatus, String(err), "error");
      }
    })
  );

  // ---------------------------------------------------------------------
  // Aide / onboarding
  // ---------------------------------------------------------------------
  const btnOpenHelp = document.querySelector("#btn-open-help");
  const helpOverlay = document.querySelector("#help-modal-overlay");
  const btnCloseHelp = document.querySelector("#btn-close-help");
  const btnHelpDone = document.querySelector("#btn-help-done");

  function openHelp() {
    show(helpOverlay);
  }
  function closeHelp() {
    hide(helpOverlay);
    localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  }

  btnOpenHelp.addEventListener("click", openHelp);
  btnCloseHelp.addEventListener("click", closeHelp);
  btnHelpDone.addEventListener("click", closeHelp);

  if (!localStorage.getItem(ONBOARDING_SEEN_KEY)) {
    openHelp();
  }

  // Fermeture communes : clic sur le fond, touche Échap
  [backupOverlay, importOverlay, helpOverlay].forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target !== overlay) return;
      if (overlay === backupOverlay) closeBackupModal();
      else if (overlay === importOverlay) closeImportModal();
      else closeHelp();
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!backupOverlay.classList.contains("hidden")) closeBackupModal();
    if (!importOverlay.classList.contains("hidden")) closeImportModal();
    if (!helpOverlay.classList.contains("hidden")) closeHelp();
  });

  renderKnownChips();
  refreshIdentityGates();

  // ---------------------------------------------------------------------
  // Navigation principale (Signer / Vérifier)
  // ---------------------------------------------------------------------
  const panelSign = document.querySelector("#panel-sign");
  const panelVerify = document.querySelector("#panel-verify");

  setupSegmented(document.querySelector("#main-tabs"), document.querySelector("#main-thumb"), (dataset) => {
    activeMainPanel = dataset.panel;
    if (activeMainPanel === "sign") {
      show(panelSign);
      hide(panelVerify);
    } else {
      hide(panelSign);
      show(panelVerify);
    }
  });

  // ---------------------------------------------------------------------
  // Signer : texte
  // ---------------------------------------------------------------------
  const textContentEl = document.querySelector("#text-content");
  const textSignResult = document.querySelector("#text-sign-result");
  const textSignatureValue = document.querySelector("#text-signature-value");
  const textSignBlock = document.querySelector("#text-sign-block");
  const btnCopyTextBlock = document.querySelector("#btn-copy-text-block");
  const btnExportTextBlock = document.querySelector("#btn-export-text-block");

  const signTextMode = document.querySelector("#sign-text-mode");
  const signFileMode = document.querySelector("#sign-file-mode");

  setupSegmented(document.querySelector("#sign-sub-tabs"), document.querySelector("#sign-sub-thumb"), (dataset) => {
    activeSignMode = dataset.mode;
    if (activeSignMode === "text") {
      show(signTextMode);
      hide(signFileMode);
    } else {
      hide(signTextMode);
      show(signFileMode);
    }
  });

  btnSignText.addEventListener("click", () =>
    withBusy(btnSignText, async () => {
      const content = textContentEl.value;
      if (!content.trim()) {
        setStatus(identityStatus, "Le contenu à signer est vide.", "error");
        return;
      }
      try {
        const signatureHex = await invoke("sign_text", { username: currentUsername, content });
        textSignatureValue.textContent = signatureHex;
        textSignBlock.value =
          `${content}\n\n--- signature Kleido ---\n` +
          `identite: ${currentUsername}\n` +
          `cle_publique: ${currentPublicKey}\n` +
          `signature: ${signatureHex}\n`;
        show(textSignResult);
      } catch (err) {
        alert(err);
      }
    })
  );

  btnCopyTextBlock.addEventListener("click", () => copyWithFeedback(btnCopyTextBlock, textSignBlock.value));
  btnExportTextBlock.addEventListener("click", () => exportText("contenu-signe.txt", textSignBlock.value));

  document.querySelectorAll("[data-copy-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      copyWithFeedback(btn, target.textContent);
    });
  });

  // ---------------------------------------------------------------------
  // Signer : fichier
  // ---------------------------------------------------------------------
  const signDropzone = document.querySelector("#sign-dropzone");
  const signPickedFile = document.querySelector("#sign-picked-file");
  const signFileNameEl = document.querySelector("#sign-file-name");
  const btnClearSignFile = document.querySelector("#btn-clear-sign-file");
  const fileSignResult = document.querySelector("#file-sign-result");
  const fileHashValue = document.querySelector("#file-hash-value");
  const fileSignatureValue = document.querySelector("#file-signature-value");
  const btnExportFileSig = document.querySelector("#btn-export-file-sig");

  function setSignFile(path) {
    signFilePath = path;
    signFileNameEl.textContent = basename(path);
    signFileNameEl.title = path;
    show(signPickedFile);
    hide(fileSignResult);
    refreshIdentityGates();
  }

  function clearSignFile() {
    signFilePath = null;
    hide(signPickedFile);
    hide(fileSignResult);
    refreshIdentityGates();
  }

  async function pickSignFile() {
    const selected = await openDialog({ multiple: false, directory: false });
    const path = typeof selected === "string" ? selected : selected?.path ?? null;
    if (path) setSignFile(path);
  }

  signDropzone.addEventListener("click", pickSignFile);
  signDropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickSignFile();
    }
  });
  btnClearSignFile.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSignFile();
  });

  btnSignFile.addEventListener("click", () =>
    withBusy(btnSignFile, async () => {
      try {
        const { hash_hex, signature_hex } = await invoke("sign_file", {
          username: currentUsername,
          filePath: signFilePath,
        });
        fileHashValue.textContent = hash_hex;
        fileSignatureValue.textContent = signature_hex;
        show(fileSignResult);
      } catch (err) {
        alert(err);
      }
    })
  );

  btnExportFileSig.addEventListener("click", () => {
    const block =
      `fichier: ${basename(signFilePath || "")}\n` +
      `sha256: ${fileHashValue.textContent}\n` +
      `identite: ${currentUsername}\n` +
      `cle_publique: ${currentPublicKey}\n` +
      `signature: ${fileSignatureValue.textContent}\n`;
    exportText("signature-fichier.txt", block);
  });

  // ---------------------------------------------------------------------
  // Vérifier
  // ---------------------------------------------------------------------
  const verifyPubkeyEl = document.querySelector("#verify-pubkey");
  const verifyTextContentEl = document.querySelector("#verify-text-content");
  const verifySignatureEl = document.querySelector("#verify-signature");
  const btnVerify = document.querySelector("#btn-verify");
  const verifyResult = document.querySelector("#verify-result");
  const verifyOutcomeIcon = document.querySelector("#verify-outcome-icon use");
  const verifyOutcomeTitle = document.querySelector("#verify-outcome-title");
  const verifyOutcomeDetail = document.querySelector("#verify-outcome-detail");
  const verifyTextMode = document.querySelector("#verify-text-mode");
  const verifyFileMode = document.querySelector("#verify-file-mode");
  const verifyDropzone = document.querySelector("#verify-dropzone");
  const verifyPickedFile = document.querySelector("#verify-picked-file");
  const verifyFileNameEl = document.querySelector("#verify-file-name");
  const btnClearVerifyFile = document.querySelector("#btn-clear-verify-file");

  setupSegmented(document.querySelector("#verify-sub-tabs"), document.querySelector("#verify-sub-thumb"), (dataset) => {
    activeVerifyMode = dataset.mode;
    if (activeVerifyMode === "text") {
      show(verifyTextMode);
      hide(verifyFileMode);
    } else {
      hide(verifyTextMode);
      show(verifyFileMode);
    }
    hide(verifyResult);
  });

  function setVerifyFile(path) {
    verifyFilePath = path;
    verifyFileNameEl.textContent = basename(path);
    verifyFileNameEl.title = path;
    show(verifyPickedFile);
    hide(verifyResult);
  }

  function clearVerifyFile() {
    verifyFilePath = null;
    hide(verifyPickedFile);
  }

  async function pickVerifyFile() {
    const selected = await openDialog({ multiple: false, directory: false });
    const path = typeof selected === "string" ? selected : selected?.path ?? null;
    if (path) setVerifyFile(path);
  }

  verifyDropzone.addEventListener("click", pickVerifyFile);
  verifyDropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickVerifyFile();
    }
  });
  btnClearVerifyFile.addEventListener("click", (e) => {
    e.stopPropagation();
    clearVerifyFile();
  });

  [verifyPubkeyEl, verifyTextContentEl, verifySignatureEl].forEach((el) =>
    el.addEventListener("input", () => hide(verifyResult))
  );

  function showVerifyOutcome(valid, detail) {
    verifyResult.classList.remove("valid", "invalid");
    verifyResult.classList.add(valid ? "valid" : "invalid");
    verifyOutcomeIcon.setAttribute("href", valid ? "#i-check" : "#i-x");
    verifyOutcomeTitle.textContent = valid ? "Signature valide" : "Signature invalide";
    verifyOutcomeDetail.textContent = detail || "";
    show(verifyResult);
  }

  btnVerify.addEventListener("click", () =>
    withBusy(btnVerify, async () => {
      const publicKeyHex = verifyPubkeyEl.value.trim();
      const signatureHex = verifySignatureEl.value.trim();
      if (!publicKeyHex || !signatureHex) {
        setStatus(identityStatus, "Renseignez la clé publique et la signature.", "error");
        return;
      }

      try {
        if (activeVerifyMode === "text") {
          const valid = await invoke("verify_text", {
            publicKeyHex,
            content: verifyTextContentEl.value,
            signatureHex,
          });
          showVerifyOutcome(valid, valid ? "" : "Le contenu ou la clé publique ne correspondent pas à cette signature.");
        } else {
          if (!verifyFilePath) {
            setStatus(identityStatus, "Choisissez un fichier à vérifier.", "error");
            return;
          }
          const outcome = await invoke("verify_file", {
            publicKeyHex,
            filePath: verifyFilePath,
            signatureHex,
          });
          showVerifyOutcome(outcome.valid, `sha256: ${outcome.hash_hex}`);
        }
      } catch (err) {
        showVerifyOutcome(false, String(err));
      }
    })
  );

  // ---------------------------------------------------------------------
  // Glisser-déposer natif (fenêtre Tauri) — vient en complément du clic
  // ---------------------------------------------------------------------
  if (TAURI?.webview) {
    TAURI.webview.getCurrentWebview().onDragDropEvent((event) => {
      const zones = [signDropzone, verifyDropzone];
      if (event.payload.type === "over") {
        zones.forEach((z) => z.classList.add("drag-over"));
        return;
      }
      zones.forEach((z) => z.classList.remove("drag-over"));
      if (event.payload.type === "drop") {
        const path = event.payload.paths?.[0];
        if (!path) return;
        if (activeMainPanel === "sign" && activeSignMode === "file") {
          setSignFile(path);
        } else if (activeMainPanel === "verify" && activeVerifyMode === "file") {
          setVerifyFile(path);
        }
      }
    });
  }
});
