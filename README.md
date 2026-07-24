
# Kleido 

> Outil de signature cryptographique offline pour créateurs de contenu, destiné à prouver l'authenticité de leurs publications face à la montée des deepfakes.

Nom : **Kleido** (du grec _kleidí_, clé).

## Principe

Le créateur publie sa clé publique en amont (bio, DNS). Il signe ensuite ses publications avec sa clé privée, offline. Le spectateur vérifie la signature avec la clé publique connue.

Pas de CA, pas de Trust List (contrairement à C2PA/Content Credentials). Modèle proche de Nostr : une paire de clés par identité, un contenu signé, une clé publique distribuée de façon redondante.

## Positionnement

- **C2PA / Content Credentials** : standard lourd, infrastructure de CA, casse dès qu'une plateforme réencode. Moins de 1% des médias publiés en sont porteurs (2026).
- **Nostr** : modèle le plus proche — paire de clés secp256k1/Ed25519, contenu signé, clé publique rattachée via lien externe.

## Stack technique

|Couche|Techno|Rôle|
|---|---|---|
|Shell app|**Tauri 2.x**|Binaire natif, webview système (pas de Chromium embarqué)|
|Frontend|HTML/CSS/JS|UI de génération de clés et de signature|
|Crypto EC|`ed25519-dalek`|Génération de paire de clés, signature, vérification|
|Hash|`sha2`|Hash des fichiers médias avant signature|
|Effacement mémoire|`zeroize` / `zeroize_derive`|Efface la clé privée de la RAM dès qu'elle sort de scope|
|Stockage clé privée|`keyring-rs`|Trousseau système (Keychain macOS / Credential Manager Windows / Secret Service Linux)|
|Accès fichiers|API Tauri `fs` scopée|Périmètre de lecture/écriture limité et déclaré|
|Réseau|**aucun plugin réseau**|`tauri-plugin-http` volontairement absent — pas de code capable de faire une requête réseau|
|IPC|Commands Tauri + capabilities|Chaque commande exposée au frontend est listée explicitement|

### Pourquoi ce choix

Le offline n'est pas une discipline de code (« ne jamais appeler `fetch` ») mais une contrainte **structurelle** : sans plugin réseau déclaré dans `Cargo.toml`, le binaire ne peut physiquement pas faire de requête, quel que soit le JS exécuté côté frontend.

La clé privée vit en mémoire Rust, jamais exposée au contexte JS/DOM. Le calcul crypto se fait côté Rust ; le frontend ne reçoit que le résultat signé.

## Prérequis

- [Rust](https://www.rust-lang.org/tools/install) (édition 2021+, via `rustup`)
- Node.js (pour le tooling frontend, npm suffit)
- Dépendances système Tauri selon l'OS : voir [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
- `cargo install create-tauri-app` (optionnel, pour le scaffold initial) ou `cargo install tauri-cli`

## Structure du projet

```
kleido/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          → point d'entrée, setup Tauri, enregistrement des commands
│   │   ├── crypto.rs        → génération de clés, signature, vérification (ed25519-dalek)
│   │   └── keystore.rs      → stockage/lecture clé privée via keyring-rs
│   ├── capabilities/
│   │   └── default.json     → permissions explicites (fs scopé, PAS de http)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── index.html
│   ├── style.css
│   └── main.js               → appels aux commands Tauri (invoke)
└── package.json
```

## Dépendances Rust (`src-tauri/Cargo.toml`)

```toml
[dependencies]
tauri = { version = "2", features = [] }
ed25519-dalek = { version = "2", features = ["rand_core"] }
sha2 = "0.10"
zeroize = { version = "1", features = ["derive"] }
keyring = "3"
rand_core = { version = "0.6", features = ["std"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Ne pas ajouter `tauri-plugin-http`, `reqwest`, ou toute autre lib réseau — c'est une contrainte de sécurité, pas un oubli.

## Capabilities (`src-tauri/capabilities/default.json`)

Modèle de permissions Tauri 2 : tout est interdit par défaut, on autorise explicitement.

```json
{
  "identifier": "default",
  "description": "Permissions minimales Anté-Kleido",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "fs:allow-read-file",
    "fs:allow-write-file",
    "dialog:allow-open",
    "dialog:allow-save"
  ]
}
```

Aucune permission réseau, aucun accès shell, aucun accès filesystem non scopé.

## Plan par étapes

### 1. Scaffold du projet

```bash
cargo create-tauri-app kleido --template vanilla
cd kleido
```

Choisir le template vanilla JS (pas besoin de framework frontend pour cet outil).

### 2. Verrouiller les capabilities

Éditer `src-tauri/capabilities/default.json` comme ci-dessus **avant** d'écrire la moindre ligne de logique métier. Vérifier qu'aucun plugin réseau n'apparaît dans `Cargo.toml`.

### 3. Génération de clé (`crypto.rs`)

Fonction Rust exposée en command Tauri :

```rust
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng;

#[tauri::command]
fn generate_keypair() -> (String, String) {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key: VerifyingKey = signing_key.verifying_key();

    let private_hex = hex::encode(signing_key.to_bytes());
    let public_hex = hex::encode(verifying_key.to_bytes());

    (private_hex, public_hex)
}
```

À adapter pour stocker la clé privée directement via `keystore.rs` plutôt que de la faire transiter en clair vers le frontend.

### 4. Stockage sécurisé (`keystore.rs`)

```rust
use keyring::Entry;

const SERVICE: &str = "kleido";

#[tauri::command]
fn store_private_key(username: String, key_hex: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &username).map_err(|e| e.to_string())?;
    entry.set_password(&key_hex).map_err(|e| e.to_string())
}

#[tauri::command]
fn retrieve_private_key(username: String) -> Result<String, String> {
    let entry = Entry::new(SERVICE, &username).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}
```

La clé privée ne devrait idéalement jamais transiter en clair vers le JS — signer côté Rust et ne renvoyer que la signature (voir étape 5).

### 5. Signature

```rust
use ed25519_dalek::{Signature, Signer, SigningKey};

#[tauri::command]
fn sign_content(username: String, content: String) -> Result<String, String> {
    let key_hex = retrieve_private_key(username)?;
    let key_bytes = hex::decode(key_hex).map_err(|e| e.to_string())?;
    let signing_key = SigningKey::from_bytes(
        &key_bytes.try_into().map_err(|_| "clé invalide")?
    );

    let signature: Signature = signing_key.sign(content.as_bytes());
    Ok(hex::encode(signature.to_bytes()))
}
```

### 6. Effacement mémoire

Appliquer `zeroize` sur toute variable contenant du matériel de clé une fois son usage terminé :

```rust
use zeroize::Zeroize;

let mut key_bytes = /* ... */;
// usage
key_bytes.zeroize();
```

### 7. Vérification

```rust
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

#[tauri::command]
fn verify_signature(public_key_hex: String, content: String, signature_hex: String) -> Result<bool, String> {
    let pub_bytes = hex::decode(public_key_hex).map_err(|e| e.to_string())?;
    let verifying_key = VerifyingKey::from_bytes(
        &pub_bytes.try_into().map_err(|_| "clé publique invalide")?
    ).map_err(|e| e.to_string())?;

    let sig_bytes = hex::decode(signature_hex).map_err(|e| e.to_string())?;
    let signature = Signature::from_bytes(
        &sig_bytes.try_into().map_err(|_| "signature invalide")?
    );

    Ok(verifying_key.verify(content.as_bytes(), &signature).is_ok())
}
```

### 8. UI frontend

Dans `src/main.js`, appeler les commands via l'API `invoke` de Tauri :

```js
import { invoke } from '@tauri-apps/api/core';

async function generateAndStore(username) {
  const [privateHex, publicHex] = await invoke('generate_keypair');
  await invoke('store_private_key', { username, keyHex: privateHex });
  return publicHex; // à afficher/publier
}

async function sign(username, content) {
  return await invoke('sign_content', { username, content });
}
```

### 9. Export/sauvegarde

Utiliser le plugin `tauri-plugin-dialog` pour `save`/`open`, pas d'accès filesystem libre.

## Stratégie de signature

- **Texte pur** (article, post) : signer le texte directement, signature en fin de contenu.
- **Fichier média** (image, vidéo) : hasher le fichier (`sha2`), signer le hash, donner la signature en texte dans la description/commentaire.
- Pas de watermarking perceptuel (façon SynthID) — hors de portée, complexité disproportionnée.

## Distribution de la clé publique

- Publier le fingerprint sur 5-6 réseaux détenus par le créateur (bio X, description YouTube, site perso) — redondance = falsification coûteuse.
- **Ancrage fort recommandé** : enregistrement DNS TXT (`pubkey.tondomaine.fr`) comme point de vérité canonique.

## Sécurité supply-chain (à intégrer au CI)

```bash
cargo install cargo-audit cargo-deny
cargo audit          # CVE connues sur les dépendances
cargo deny check      # licences problématiques, dépendances dupliquées/non maintenues
```

- Minimiser le nombre de crates tierces.
- Build reproductible + binaire signé (notarization macOS, Authenticode Windows) pour que les utilisateurs puissent vérifier l'intégrité du logiciel lui-même — cohérent avec l'objectif anti-deepfake du projet.

