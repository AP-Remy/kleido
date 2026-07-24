# Kleido

> Outil de signature cryptographique offline pour créateurs de contenu, destiné à prouver l'authenticité de leurs publications face aux faux comptes et à la montée des deepfakes.


## Principe

Le créateur publie sa clé publique en amont (bio, DNS). Il signe ensuite ses publications avec sa clé privée, offline. Le spectateur vérifie la signature avec la clé publique connue.

Pas de CA, pas de Trust List (contrairement à C2PA/Content Credentials). Modèle proche de Nostr : une paire de clés par identité, un contenu signé, une clé publique distribuée de façon redondante.

## Positionnement

- **C2PA / Content Credentials** : standard lourd, infrastructure de CA, casse dès qu'une plateforme réencode. Moins de 1% des médias publiés en sont porteurs (2026).
- **Nostr** : modèle le plus proche — paire de clés secp256k1/Ed25519, contenu signé, clé publique rattachée via lien externe.
- **Kleido** : hybride simple, léger, portable, aucune coopération de plateforme requise.

## Stack technique

|Couche|Techno|Rôle|
|---|---|---|
|Shell app|**Tauri 2.x**|Binaire natif, webview système (pas de Chromium embarqué)|
|Frontend|HTML/CSS/JS (vanilla, sans bundler)|UI de génération de clés et de signature|
|Crypto EC|`ed25519-dalek`|Génération de paire de clés, signature (`verify_strict`), vérification|
|Hash|`sha2`|Hash des fichiers médias avant signature|
|Sauvegarde de clé|`bip39`|Export/import de la clé privée en phrase de 24 mots|
|Effacement mémoire|`zeroize`|Efface la clé privée de la RAM dès qu'elle sort de scope|
|Stockage clé privée|`keyring-rs`|Trousseau système (Keychain macOS / Credential Manager Windows / Secret Service Linux)|
|Accès fichiers|`tauri-plugin-fs` + `tauri-plugin-dialog`|Périmètre de lecture/écriture limité et déclaré|
|Réseau|**aucun plugin réseau**|`tauri-plugin-http` volontairement absent|
|IPC|Commands Tauri + capabilities|Chaque commande exposée au frontend est listée explicitement|

### Pourquoi l'offline est structurel, pas une discipline

Sans plugin réseau déclaré dans `Cargo.toml`, le binaire ne peut physiquement pas faire de requête, quel que soit le JS exécuté côté frontend — ce n'est pas une règle de code (« ne jamais appeler `fetch` ») qu'on pourrait oublier de respecter, c'est une impossibilité au niveau du binaire compilé.

La clé privée vit en mémoire Rust, jamais exposée au contexte JS/DOM. Le calcul crypto se fait côté Rust ; le frontend ne reçoit que le résultat signé (jamais la clé privée elle-même).

## Architecture

```
kleido/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          → point d'entrée, appelle kleido_lib::run()
│   │   ├── lib.rs           → setup Tauri, enregistrement des commands, plugins (fs, dialog — pas de http)
│   │   ├── crypto.rs        → toutes les commands : clés, signature/vérification, export/import BIP-39
│   │   └── keystore.rs      → wrapper fin autour de keyring-rs (store/retrieve/exists/delete)
│   ├── capabilities/
│   │   └── default.json     → permissions explicites (fs scopé, PAS de http)
│   ├── icons/                → icônes de l'app (générées depuis logo-source.png)
│   ├── Cargo.toml
│   ├── deny.toml             → config cargo-deny (licences, deps non maintenues)
│   └── tauri.conf.json
├── src/
│   ├── index.html
│   ├── styles.css
│   ├── logo.png
│   └── main.js               → appelle les commands via window.__TAURI__.core.invoke
└── package.json
```

Le frontend n'utilise pas de bundler : `withGlobalTauri: true` dans `tauri.conf.json` expose l'API sur `window.__TAURI__`, appelée directement dans `main.js` (pas d'`import` ES). Choix volontaire pour rester sur du HTML/CSS/JS simple, sans étape de build côté frontend.

### Commands exposées (`crypto.rs`)

| Command | Rôle |
|---|---|
| `generate_identity(username)` | Génère une paire de clés, stocke la privée dans le trousseau, renvoie la publique |
| `get_public_key(username)` | Redérive la clé publique d'une identité déjà stockée |
| `identity_exists(username)` | Vérifie si une identité existe déjà |
| `delete_identity(username)` | Supprime une identité du trousseau système |
| `sign_text(username, content)` | Signe un texte |
| `hash_file(file_path)` | SHA-256 d'un fichier (sans signer) |
| `sign_file(username, file_path)` | Hash un fichier puis signe le hash |
| `verify_text(public_key_hex, content, signature_hex)` | Vérifie une signature de texte (`verify_strict`) |
| `verify_file(public_key_hex, file_path, signature_hex)` | Hash un fichier puis vérifie |
| `export_mnemonic(username)` | Exporte la clé privée en phrase BIP-39 (24 mots) |
| `import_mnemonic(username, phrase)` | Restaure une identité depuis une phrase de 24 mots |

La clé privée ne transite jamais en clair vers le JS : ces commands ne renvoient que des clés publiques, des hachages, des signatures, ou (pour l'export) la phrase de récupération elle-même — jamais la clé privée brute.

## Capabilities (`src-tauri/capabilities/default.json`)

Modèle de permissions Tauri 2 : tout est interdit par défaut, on autorise explicitement.

```json
{
  "identifier": "default",
  "description": "Permissions minimales Kleido",
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

## Stratégie de signature

- **Texte pur** (article, post) : signer le texte directement, signature en fin de contenu.
- **Fichier média** (image, vidéo) : hasher le fichier (`sha2`), signer le hash (comme du texte), donner la signature en texte dans la description/commentaire.
- Pas de watermarking perceptuel (façon SynthID) — hors de portée, complexité disproportionnée.

## Sauvegarde et restauration d'identité

La clé privée n'est stockée que dans le trousseau système de la machine — sans sauvegarde, une réinstallation Windows ou un changement de machine fait perdre l'identité définitivement.

- **Sauvegarde** (`export_mnemonic`) : encode la clé privée (32 octets) en phrase BIP-39 de 24 mots, avec somme de contrôle. Flux guidé façon Ledger dans l'UI : avertissement → révélation des 24 mots (jamais copiables, à noter à la main) → vérification de 3 mots choisis au hasard → confirmation.
- **Restauration** (`import_mnemonic`) : ressaisie des 24 mots (une case par mot, collage intelligent qui distribue une phrase complète sur toutes les cases), reconstitue la clé privée et la clé publique dérivée pour confirmation.

## Distribution de la clé publique

- Publier le fingerprint sur 5-6 réseaux détenus par le créateur (bio X, description YouTube, site perso) — redondance = falsification coûteuse.
- **Ancrage fort recommandé** : enregistrement DNS TXT (`pubkey.tondomaine.fr`) comme point de vérité canonique.
- **Révocation** : pas de mécanisme centralisé (cohérent avec « pas de CA, pas de Trust List ») — en cas de compromission, le créateur republie une nouvelle clé publique sur les mêmes canaux.

## Vérification côté spectateur

[`kleido-verify/`](../kleido-verify) est une page web statique séparée (HTML/CSS/JS, zéro dépendance, zéro backend) qui vérifie une signature Kleido directement dans le navigateur via l'API Web Crypto (Ed25519 + SHA-256) — aucune installation requise pour le spectateur. Dépôt et déploiement indépendants du binaire de l'application.

## Sécurité

- **Zeroize** : toute variable contenant du matériel de clé (bytes bruts, hex intermédiaire) est effacée explicitement dès qu'elle sort de scope, y compris dans les chemins d'erreur.
- **CSP stricte** (`default-src 'self'`) sur `kleido` et `kleido-verify`.
- **Pas de binaire signé** (Authenticode/notarization) — démarche d'achat de certificat + vérification d'identité, hors du périmètre du code. Windows SmartScreen avertit donc au premier lancement, attendu pour un binaire non signé.
- **Supply-chain** : `cargo audit` (CVE connues) + `cargo deny check` (licences, dépendances dupliquées/non maintenues), intégrés à la CI (`.github/workflows/ci.yml`) sur chaque push/PR. Voir `src-tauri/deny.toml` pour la liste des licences autorisées.
- Onboarding intégré (clé publique vs privée expliquées simplement), affiché au premier lancement.

