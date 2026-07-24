mod crypto;
mod keystore;

// Aucun plugin réseau n'est enregistré ici (pas de tauri-plugin-http) —
// contrainte structurelle : le binaire ne peut physiquement pas faire de
// requête réseau, quel que soit le JS exécuté côté frontend.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            crypto::generate_identity,
            crypto::get_public_key,
            crypto::identity_exists,
            crypto::delete_identity,
            crypto::export_mnemonic,
            crypto::import_mnemonic,
            crypto::sign_text,
            crypto::hash_file,
            crypto::sign_file,
            crypto::verify_text,
            crypto::verify_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
