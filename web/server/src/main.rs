use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use std::{env, path::PathBuf, time::Duration};
use tower_http::services::{ServeDir, ServeFile};

// Python 엔진(FastAPI)으로 요청을 넘길 때 쓰는 연결 정보.
#[derive(Clone)]
struct Engine {
    client: reqwest::Client,
    base: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = env::var("RAG_BIND").unwrap_or_else(|_| "127.0.0.1:4173".into());
    let assets = env::var("RAG_DIST").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
    });
    if !assets.join("index.html").is_file() {
        return Err("Frontend build missing. Run npm install && npm run build first.".into());
    }
    // 전체 시간 제한은 두지 않는다 (진행 스트림은 작업이 끝날 때까지 열려 있다).
    // 대신 연결은 5초, 응답이 한 번도 오지 않는 구간은 5분까지만 기다린다.
    let engine = Engine {
        client: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(300))
            .build()?,
        base: env::var("ENGINE_URL").unwrap_or_else(|_| "http://127.0.0.1:8000".into()),
    };
    let app = Router::new()
        .route("/api/health", get(|| async { "{\"status\":\"ok\",\"mode\":\"ui-preview\"}" }))
        // /api/rag/* 는 Python 엔진으로 그대로 넘긴다. 나중에 권한 확인·추적 ID를 붙일 자리.
        .route("/api/rag/{*rest}", any(proxy_rag))
        .with_state(engine)
        .fallback_service(ServeDir::new(&assets).not_found_service(ServeFile::new(assets.join("index.html"))));
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("rag-ops · http://{address}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await?;
    Ok(())
}

// /api/rag/<경로> 요청을 엔진의 /<경로>로 보내고, 상태 코드·Content-Type·본문을 그대로 돌려준다.
// 본문은 모았다가 넘기지 않고 받는 대로 흘려보낸다. 그래야 진행 스트림(SSE) 이벤트가 바로 브라우저에 닿는다.
async fn proxy_rag(State(engine): State<Engine>, req: Request) -> Response {
    let path_query = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let rest = path_query.strip_prefix("/api/rag").unwrap_or(path_query);
    let url = format!("{}{}", engine.base, rest);
    let method = req.method().clone();
    let content_type = req.headers().get(header::CONTENT_TYPE).cloned();
    // 요청 본문은 1MB까지만 받는다. 경로·메타데이터만 오가므로 이보다 클 일이 없다.
    let body = match to_bytes(req.into_body(), 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response(),
    };

    let mut upstream = engine.client.request(method, &url).body(body);
    if let Some(ct) = content_type {
        upstream = upstream.header(header::CONTENT_TYPE, ct);
    }
    match upstream.send().await {
        Ok(res) => {
            let mut out = Response::builder().status(res.status());
            for name in [header::CONTENT_TYPE, header::CACHE_CONTROL] {
                if let Some(value) = res.headers().get(&name) {
                    out = out.header(name, value.clone());
                }
            }
            out.body(Body::from_stream(res.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        // 엔진이 꺼져 있거나 시간 초과면 502로 알려 준다.
        Err(e) => (StatusCode::BAD_GATEWAY, format!("engine unreachable: {e}")).into_response(),
    }
}
