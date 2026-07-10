//! Validation LIVE : un vrai client MCP `codex` accepte le serveur « Agent
//! Room » implemente a la main. Ignore par defaut (necessite le binaire codex,
//! le reseau et un `auth.json` connecte).
//!
//! Lancer explicitement :
//!   CODEX_BIN="C:/.../codex.exe" cargo test --test live_codex_room -- --ignored --nocapture
//!
//! Variables d'env :
//!   CODEX_BIN            chemin du binaire codex (defaut: "codex" sur le PATH)
//!   CST_TEST_CODEX_HOME  home source pour copier auth.json (defaut: ~/.codex)
//!   CST_TEST_MODEL       modele a forcer (optionnel)

use std::{fs, path::PathBuf, time::Duration};

use codex_switch_terminal_lib::agent_room::{router, AgentMeta, RoomState};

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .expect("home dir")
}

fn uid() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requiert le binaire codex + auth ; lancer avec --ignored"]
async fn codex_client_handshakes_and_calls_tools() {
    // 1) Salon + agent enregistre (token secret = identite/auth).
    let room = RoomState::new();
    let token = room.register(AgentMeta {
        agent_id: "codex".into(),
        account_id: "test".into(),
        label: "Tester".into(),
        cwd: None,
    });

    // 2) Serveur MCP sur un port loopback ephemere.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = router(room.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service()).await;
    });
    let url = format!("http://127.0.0.1:{port}/mcp");

    // 3) CODEX_HOME temporaire avec auth.json copie.
    let src_home = std::env::var("CST_TEST_CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".codex"));
    let auth = src_home.join("auth.json");
    assert!(auth.exists(), "auth.json introuvable: {}", auth.display());

    let tmp = std::env::temp_dir().join(format!("cst-live-{}", uid()));
    let home = tmp.join("home");
    let work = tmp.join("work");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&work).unwrap();
    fs::copy(&auth, home.join("auth.json")).unwrap();

    let codex = std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".into());

    // 4) Provisioning via le vrai CLI (le chemin merge-safe qu'on livre en Phase 3).
    let add = tokio::process::Command::new(&codex)
        .args([
            "mcp",
            "add",
            "agent_room",
            "--url",
            &url,
            "--bearer-token-env-var",
            "CST_ROOM_TOKEN",
        ])
        .env("CODEX_HOME", &home)
        .output()
        .await
        .expect("run codex mcp add");
    assert!(
        add.status.success(),
        "codex mcp add a echoue: {}",
        String::from_utf8_lossy(&add.stderr)
    );

    // 5) Demander a l'agent d'appeler send_message avec un marqueur unique.
    let nonce = format!("LIVE_OK_{}", uid());
    let prompt = format!(
        "You are connected to an MCP server named 'agent_room'. \
         Call its tool `send_message` with the argument `text` set exactly to \"{nonce}\". \
         Do not do anything else. Then end your turn."
    );

    let mut cmd = tokio::process::Command::new(&codex);
    cmd.arg("exec")
        .arg("--dangerously-bypass-approvals-and-sandbox")
        .arg("-C")
        .arg(&work);
    if let Ok(model) = std::env::var("CST_TEST_MODEL") {
        cmd.arg("-m").arg(model);
    }
    cmd.arg(&prompt)
        .env("CODEX_HOME", &home)
        .env("CST_ROOM_TOKEN", &token);

    let run = tokio::time::timeout(Duration::from_secs(240), cmd.output())
        .await
        .expect("codex exec a depasse le delai")
        .expect("run codex exec");

    eprintln!(
        "--- codex exec stdout ---\n{}\n--- stderr ---\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );

    // Preuve deterministe : le client rmcp de codex a fait initialize PUIS
    // tools/list (il ne liste les outils que si l'initialize a reussi).
    let (inits, lists) = room.handshake_counts();
    eprintln!("handshake counts: initialize={inits}, tools/list={lists}");
    assert!(inits >= 1, "codex n'a pas envoye initialize (handshake echoue)");
    assert!(
        lists >= 1,
        "codex n'a pas liste les outils (notre initialize a ete rejete ?)"
    );

    // Preuve secondaire (dependante du modele) : l'appel d'outil a fait
    // l'aller-retour. Une diffusion salon (to=None) est visible par n'importe
    // quel ident, on peut donc scanner avec un ident quelconque.
    let delivered = room
        .messages_for("operator", 0)
        .iter()
        .any(|m| m.text.contains(&nonce));
    if delivered {
        eprintln!("OK: l'agent a bien appele send_message (marqueur recu).");
    } else {
        eprintln!("NOTE: handshake OK mais l'agent n'a pas (encore) appele send_message.");
    }

    let _ = fs::remove_dir_all(&tmp);
}
