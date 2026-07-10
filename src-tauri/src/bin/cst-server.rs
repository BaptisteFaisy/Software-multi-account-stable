use codex_switch_terminal_lib::server;

#[tokio::main]
async fn main() {
    // `cst-server --version` : self-check d'artefact (l'updater compare cette
    // valeur a la version attendue) et sonde de secours pour l'orchestrateur.
    // Doit fonctionner sans CST_ADMIN_TOKEN, donc avant run_from_env().
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "--version" || arg == "-V")
    {
        println!("cst-server {} ({})", server::VERSION, server::COMMIT);
        return;
    }

    if let Err(error) = server::run_from_env().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
