use std::process::Command;

fn main() {
    // Embarque le commit git pour que `/healthz`, `/api/health` et
    // `cst-server --version` puissent le reporter. Priorite :
    //   1. CST_GIT_COMMIT (injecte par le packaging/CI ; seul cas fiable la ou
    //      il n'y a pas de .git, ex. la machine de build Oracle),
    //   2. `git rev-parse --short HEAD` (confort dev),
    //   3. "unknown".
    let commit = std::env::var("CST_GIT_COMMIT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(git_short_commit)
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=CST_GIT_COMMIT={commit}");

    // Recompile quand le commit injecte change, ou quand HEAD bouge en dev.
    println!("cargo:rerun-if-env-changed=CST_GIT_COMMIT");
    if std::path::Path::new("../.git/HEAD").exists() {
        println!("cargo:rerun-if-changed=../.git/HEAD");
    }

    // Build Tauri standard : regenere les manifestes ACL (gen/schemas), embarque
    // l'icône et (sur Windows) le manifeste Common-Controls v6 via resource.lib.
    // Indispensable : sans lui, event.listen est refuse ("Plugin not found") et
    // l'exe peut planter au lancement (TaskDialogIndirect v6 non resolu -> 0xC0000139).
    tauri_build::build();
}

fn git_short_commit() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}
