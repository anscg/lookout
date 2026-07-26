fn main() {
    // Link CoreGraphics on macOS for screen capture permission APIs
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        // Native menu-bar item: compiles swift/lookout-tray (SwiftUI with the
        // numericText digit-roll animation) and links it into the binary.
        swift_rs::SwiftLinker::new("10.15")
            .with_package("lookout-tray", "./swift/lookout-tray")
            .link();
    }

    tauri_build::build()
}
