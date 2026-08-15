fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::default().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "open_file",
                "write_chunk",
                "close_file",
                "abort_file",
                "resolve_save_path",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
