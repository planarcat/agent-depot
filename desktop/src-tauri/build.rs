fn main() {
    println!("cargo:rerun-if-env-changed=AGENT_DEPOT_PROFILE");
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "desktop_profile",
                "desktop_get_settings",
                "desktop_set_settings",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
