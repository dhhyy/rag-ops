use axum::{Router, routing::get};
use std::{env, path::PathBuf};
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = env::var("RAG_BIND").unwrap_or_else(|_| "127.0.0.1:4173".into());
    let assets = env::var("RAG_DIST").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
    });
    if !assets.join("index.html").is_file() {
        return Err("Frontend build missing. Run npm install && npm run build first.".into());
    }
    let app = Router::new()
        .route("/api/health", get(|| async { "{\"status\":\"ok\",\"mode\":\"ui-preview\"}" }))
        .fallback_service(ServeDir::new(&assets).not_found_service(ServeFile::new(assets.join("index.html"))));
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("rag-ops · http://{address}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await?;
    Ok(())
}
