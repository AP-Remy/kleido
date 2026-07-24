//! Génération de clés, signature et vérification (ed25519-dalek).
//!
//! La clé privée ne transite jamais en clair vers le frontend JS : elle est
//! générée, stockée et utilisée entièrement côté Rust. Le frontend ne reçoit
//! que des clés publiques, des hachages et des signatures.

use bip39::Mnemonic;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::keystore;

#[derive(Serialize)]
pub struct SignFileOutput {
    pub hash_hex: String,
    pub signature_hex: String,
}

#[derive(Serialize)]
pub struct VerifyFileOutput {
    pub hash_hex: String,
    pub valid: bool,
}

/// Reconstruit une `SigningKey` à partir de sa représentation hex, en
/// effaçant chaque tampon intermédiaire contenant du matériel de clé.
fn signing_key_from_hex(mut key_hex: String) -> Result<SigningKey, String> {
    let decoded = hex::decode(&key_hex);
    key_hex.zeroize();
    let mut key_bytes = decoded.map_err(|e| e.to_string())?;

    if key_bytes.len() != 32 {
        key_bytes.zeroize();
        return Err("clé privée invalide".to_string());
    }

    let mut array = [0u8; 32];
    array.copy_from_slice(&key_bytes);
    key_bytes.zeroize();

    let signing_key = SigningKey::from_bytes(&array);
    array.zeroize();

    Ok(signing_key)
}

/// Génère une nouvelle paire de clés, stocke la clé privée dans le trousseau
/// système sous `username`, et renvoie uniquement la clé publique (hex).
#[tauri::command]
pub fn generate_identity(username: String) -> Result<String, String> {
    if keystore::key_exists(&username) {
        return Err(format!(
            "Une identité « {username} » existe déjà. Supprimez-la d'abord si vous voulez la régénérer."
        ));
    }

    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let public_hex = hex::encode(signing_key.verifying_key().to_bytes());

    let mut secret_bytes = signing_key.to_bytes();
    let mut key_hex = hex::encode(secret_bytes);
    secret_bytes.zeroize();

    let store_result = keystore::store_private_key(&username, &key_hex);
    key_hex.zeroize();
    store_result?;

    Ok(public_hex)
}

/// Redérive la clé publique d'une identité déjà stockée (pour ré-affichage).
#[tauri::command]
pub fn get_public_key(username: String) -> Result<String, String> {
    let key_hex = keystore::retrieve_private_key(&username)?;
    let signing_key = signing_key_from_hex(key_hex)?;
    Ok(hex::encode(signing_key.verifying_key().to_bytes()))
}

#[tauri::command]
pub fn identity_exists(username: String) -> bool {
    keystore::key_exists(&username)
}

#[tauri::command]
pub fn delete_identity(username: String) -> Result<(), String> {
    keystore::delete_private_key(&username)
}

/// Exporte l'identité sous forme de phrase de récupération BIP-39 (24 mots
/// pour nos clés 256 bits) — même principe qu'un portefeuille matériel type
/// Ledger. Le frontend est responsable de ne jamais persister cette phrase
/// (pas de localStorage, pas de copier-coller).
#[tauri::command]
pub fn export_mnemonic(username: String) -> Result<String, String> {
    let mut key_hex = keystore::retrieve_private_key(&username)?;
    let decoded = hex::decode(&key_hex);
    key_hex.zeroize();
    let mut entropy = decoded.map_err(|e| e.to_string())?;

    if entropy.len() != 32 {
        entropy.zeroize();
        return Err("clé privée invalide".to_string());
    }

    let mut mnemonic = Mnemonic::from_entropy(&entropy).map_err(|e| e.to_string())?;
    entropy.zeroize();
    let phrase = mnemonic.to_string();
    mnemonic.zeroize();

    Ok(phrase)
}

/// Restaure une identité à partir d'une phrase de récupération BIP-39.
/// Refuse d'écraser une identité existante (comme `generate_identity`).
#[tauri::command]
pub fn import_mnemonic(username: String, phrase: String) -> Result<String, String> {
    if keystore::key_exists(&username) {
        return Err(format!(
            "Une identité « {username} » existe déjà. Supprimez-la d'abord si vous voulez la restaurer."
        ));
    }

    let mut mnemonic = Mnemonic::parse_normalized(phrase.trim()).map_err(|_| {
        "Phrase de récupération invalide (mot incorrect ou somme de contrôle invalide)."
            .to_string()
    })?;
    let mut entropy = mnemonic.to_entropy();
    mnemonic.zeroize();

    if entropy.len() != 32 {
        entropy.zeroize();
        return Err("Cette phrase ne correspond pas à une clé Kleido (24 mots attendus).".to_string());
    }

    let mut key_hex = hex::encode(&entropy);
    entropy.zeroize();

    let store_result = keystore::store_private_key(&username, &key_hex);
    key_hex.zeroize();
    store_result?;

    get_public_key(username)
}

/// Signe un contenu texte avec la clé privée de `username`.
#[tauri::command]
pub fn sign_text(username: String, content: String) -> Result<String, String> {
    let key_hex = keystore::retrieve_private_key(&username)?;
    let signing_key = signing_key_from_hex(key_hex)?;
    let signature: Signature = signing_key.sign(content.as_bytes());
    Ok(hex::encode(signature.to_bytes()))
}

/// Hache un fichier (SHA-256) sans le signer — utile côté vérification.
///
/// ATTENTION frontière de confiance : `file_path` est une chaîne fournie par
/// le frontend et n'est pas contrainte par le scope de `tauri-plugin-fs`
/// (cette commande fait son propre `std::fs::read`, hors du plugin). Dans
/// l'usage normal, ce chemin provient toujours d'un dialogue natif
/// (`dialog:allow-open`) ou d'un glisser-déposer OS — jamais d'une saisie
/// libre côté UI. Cette commande ne renvoie qu'un hachage, jamais le
/// contenu du fichier ; elle ne constitue donc pas une primitive
/// d'exfiltration, mais reste un oracle de hachage sur tout fichier lisible
/// par l'utilisateur si jamais du JS non fiable s'exécutait dans la webview
/// (ce qui supposerait déjà un XSS — inexistant à ce jour, aucun contenu
/// distant n'étant jamais chargé).
#[tauri::command]
pub fn hash_file(file_path: String) -> Result<String, String> {
    let data = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(hex::encode(hasher.finalize()))
}

/// Hache un fichier média puis signe ce hachage avec la clé de `username`.
#[tauri::command]
pub fn sign_file(username: String, file_path: String) -> Result<SignFileOutput, String> {
    let hash_hex = hash_file(file_path)?;
    let signature_hex = sign_text(username, hash_hex.clone())?;
    Ok(SignFileOutput {
        hash_hex,
        signature_hex,
    })
}

/// Vérifie une signature sur un contenu texte avec une clé publique donnée.
#[tauri::command]
pub fn verify_text(
    public_key_hex: String,
    content: String,
    signature_hex: String,
) -> Result<bool, String> {
    let pub_bytes = hex::decode(&public_key_hex).map_err(|e| e.to_string())?;
    let pub_array: [u8; 32] = pub_bytes
        .try_into()
        .map_err(|_| "clé publique invalide".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&pub_array).map_err(|e| e.to_string())?;

    let sig_bytes = hex::decode(&signature_hex).map_err(|e| e.to_string())?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "signature invalide".to_string())?;
    let signature = Signature::from_bytes(&sig_array);

    // verify_strict (plutôt que verify) rejette en plus les signatures
    // malléables par composante de petit ordre — appropriée pour un outil
    // qui se positionne explicitement comme un outil de sécurité.
    Ok(verifying_key
        .verify_strict(content.as_bytes(), &signature)
        .is_ok())
}

/// Hache un fichier puis vérifie la signature de ce hachage.
#[tauri::command]
pub fn verify_file(
    public_key_hex: String,
    file_path: String,
    signature_hex: String,
) -> Result<VerifyFileOutput, String> {
    let hash_hex = hash_file(file_path)?;
    let valid = verify_text(public_key_hex, hash_hex.clone(), signature_hex)?;
    Ok(VerifyFileOutput { hash_hex, valid })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Identité de test unique, supprimée automatiquement à la fin du test
    /// (même en cas de panique) pour ne pas polluer le trousseau système
    /// réel de la machine qui exécute `cargo test`.
    struct TestIdentity(String);

    impl TestIdentity {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(format!("__kleido_test_{tag}_{nanos}__"))
        }
    }

    impl Drop for TestIdentity {
        fn drop(&mut self) {
            let _ = keystore::delete_private_key(&self.0);
        }
    }

    /// Fichier temporaire de test, supprimé à la fin du test.
    struct TestFile(std::path::PathBuf);

    impl TestFile {
        fn new(tag: &str, content: &[u8]) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("kleido_test_{tag}_{nanos}.bin"));
            std::fs::write(&path, content).unwrap();
            Self(path)
        }

        fn path_string(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn generate_then_sign_then_verify_text_round_trip() {
        let id = TestIdentity::new("sign_verify");
        let public_hex = generate_identity(id.0.clone()).unwrap();

        let content = "Ceci est un test — été, café, naïve.".to_string();
        let signature_hex = sign_text(id.0.clone(), content.clone()).unwrap();

        assert!(verify_text(public_hex, content, signature_hex).unwrap());
    }

    #[test]
    fn verify_text_rejects_tampered_content() {
        let id = TestIdentity::new("tamper_content");
        let public_hex = generate_identity(id.0.clone()).unwrap();

        let signature_hex = sign_text(id.0.clone(), "contenu original".to_string()).unwrap();

        let valid = verify_text(public_hex, "contenu modifié".to_string(), signature_hex).unwrap();
        assert!(!valid);
    }

    #[test]
    fn verify_text_rejects_wrong_public_key() {
        let id_a = TestIdentity::new("wrong_key_a");
        let id_b = TestIdentity::new("wrong_key_b");
        generate_identity(id_a.0.clone()).unwrap();
        let public_b = generate_identity(id_b.0.clone()).unwrap();

        let content = "contenu signé par A".to_string();
        let signature_hex = sign_text(id_a.0.clone(), content.clone()).unwrap();

        // Vérifié avec la clé publique de B : ne doit jamais être valide.
        let valid = verify_text(public_b, content, signature_hex).unwrap();
        assert!(!valid);
    }

    #[test]
    fn verify_text_rejects_malformed_hex() {
        let err = verify_text(
            "pas-du-hex".to_string(),
            "contenu".to_string(),
            "pas-du-hex-non-plus".to_string(),
        );
        assert!(err.is_err());
    }

    #[test]
    fn sign_and_verify_file_round_trip() {
        let id = TestIdentity::new("sign_verify_file");
        let public_hex = generate_identity(id.0.clone()).unwrap();

        let file = TestFile::new("sign_verify", b"contenu binaire de test Kleido");
        let signed = sign_file(id.0.clone(), file.path_string()).unwrap();

        let outcome = verify_file(public_hex, file.path_string(), signed.signature_hex).unwrap();
        assert!(outcome.valid);
        assert_eq!(outcome.hash_hex, signed.hash_hex);
    }

    #[test]
    fn verify_file_rejects_modified_file() {
        let id = TestIdentity::new("tamper_file");
        let public_hex = generate_identity(id.0.clone()).unwrap();

        let file = TestFile::new("tamper", b"contenu original");
        let signed = sign_file(id.0.clone(), file.path_string()).unwrap();

        // On modifie le fichier après signature : le hachage (et donc la
        // vérification) doit changer.
        std::fs::write(&file.0, b"contenu modifie").unwrap();

        let outcome = verify_file(public_hex, file.path_string(), signed.signature_hex).unwrap();
        assert!(!outcome.valid);
    }

    #[test]
    fn generate_identity_refuses_to_overwrite() {
        let id = TestIdentity::new("no_overwrite");
        generate_identity(id.0.clone()).unwrap();
        assert!(generate_identity(id.0.clone()).is_err());
    }

    #[test]
    fn delete_identity_then_operations_fail() {
        let id = TestIdentity::new("delete_lifecycle");
        generate_identity(id.0.clone()).unwrap();
        assert!(identity_exists(id.0.clone()));

        delete_identity(id.0.clone()).unwrap();
        assert!(!identity_exists(id.0.clone()));
        assert!(get_public_key(id.0.clone()).is_err());
        assert!(sign_text(id.0.clone(), "x".to_string()).is_err());
    }

    #[test]
    fn export_then_import_mnemonic_round_trip() {
        let original = TestIdentity::new("mnemonic_export");
        let restored = TestIdentity::new("mnemonic_import");

        let original_public = generate_identity(original.0.clone()).unwrap();
        let phrase = export_mnemonic(original.0.clone()).unwrap();
        assert_eq!(phrase.split_whitespace().count(), 24);

        let restored_public = import_mnemonic(restored.0.clone(), phrase).unwrap();
        assert_eq!(restored_public, original_public);
    }

    #[test]
    fn import_mnemonic_rejects_invalid_phrase() {
        let id = TestIdentity::new("mnemonic_invalid");
        let err = import_mnemonic(
            id.0.clone(),
            "pas une phrase de recuperation valide du tout".to_string(),
        );
        assert!(err.is_err());
    }

    #[test]
    fn import_mnemonic_refuses_to_overwrite_existing_identity() {
        let id = TestIdentity::new("mnemonic_no_overwrite");
        generate_identity(id.0.clone()).unwrap();
        let phrase = export_mnemonic(id.0.clone()).unwrap();

        // Reproposer un import sous le même nom doit être refusé, comme
        // pour generate_identity.
        assert!(import_mnemonic(id.0.clone(), phrase).is_err());
    }
}
