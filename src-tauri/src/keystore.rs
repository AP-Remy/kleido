//! Stockage de la clé privée dans le trousseau système (Keychain / Credential
//! Manager / Secret Service) via `keyring-rs`. La clé privée n'est jamais
//! écrite sur disque en clair par ce module.

use keyring::Entry;
use zeroize::Zeroize;

const SERVICE: &str = "kleido";

fn entry_for(username: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, username).map_err(|e| e.to_string())
}

/// Enregistre la clé privée (hex) sous l'identité `username`.
/// Écrase silencieusement une éventuelle entrée existante.
pub fn store_private_key(username: &str, key_hex: &str) -> Result<(), String> {
    let entry = entry_for(username)?;
    entry.set_password(key_hex).map_err(|e| e.to_string())
}

/// Récupère la clé privée (hex) associée à `username`.
pub fn retrieve_private_key(username: &str) -> Result<String, String> {
    let entry = entry_for(username)?;
    entry
        .get_password()
        .map_err(|_| format!("Aucune identité « {username} » trouvée dans le trousseau système"))
}

/// Indique si une identité `username` est déjà stockée.
///
/// Le trousseau système n'expose pas de méthode "exists" dédiée : on est
/// obligé de lire le mot de passe pour tester sa présence. On l'efface donc
/// explicitement plutôt que de le laisser traîner en mémoire jusqu'au
/// prochain déplacement du tas.
pub fn key_exists(username: &str) -> bool {
    match entry_for(username) {
        Ok(entry) => match entry.get_password() {
            Ok(mut password) => {
                password.zeroize();
                true
            }
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// Supprime définitivement l'identité `username` du trousseau système.
pub fn delete_private_key(username: &str) -> Result<(), String> {
    let entry = entry_for(username)?;
    entry.delete_credential().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Nom d'utilisateur de test unique, pour ne pas entrer en collision
    /// avec d'autres tests exécutés en parallèle sur le même trousseau
    /// système. Supprime automatiquement l'entrée à la fin du test (même
    /// en cas de panique), pour ne pas polluer le trousseau réel de la
    /// machine qui exécute `cargo test`.
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
            let _ = delete_private_key(&self.0);
        }
    }

    #[test]
    fn store_then_retrieve_round_trip() {
        let id = TestIdentity::new("store_retrieve");
        assert!(!key_exists(&id.0));

        store_private_key(&id.0, "deadbeef").unwrap();
        assert!(key_exists(&id.0));
        assert_eq!(retrieve_private_key(&id.0).unwrap(), "deadbeef");
    }

    #[test]
    fn retrieve_missing_identity_fails() {
        let id = TestIdentity::new("missing");
        assert!(retrieve_private_key(&id.0).is_err());
        assert!(!key_exists(&id.0));
    }

    #[test]
    fn delete_removes_identity() {
        let id = TestIdentity::new("delete");
        store_private_key(&id.0, "cafebabe").unwrap();
        assert!(key_exists(&id.0));

        delete_private_key(&id.0).unwrap();
        assert!(!key_exists(&id.0));
    }

    #[test]
    fn store_overwrites_existing_value() {
        let id = TestIdentity::new("overwrite");
        store_private_key(&id.0, "first").unwrap();
        store_private_key(&id.0, "second").unwrap();
        assert_eq!(retrieve_private_key(&id.0).unwrap(), "second");
    }
}
