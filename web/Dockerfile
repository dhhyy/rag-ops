FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM rust:1.94-bookworm AS backend
WORKDIR /app
COPY server ./server
RUN cargo build --release --locked --manifest-path server/Cargo.toml

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=backend /app/server/target/release/rag-ops-server /usr/local/bin/rag-ops-server
COPY --from=frontend /app/dist ./dist
ENV RAG_BIND=0.0.0.0:4173 RAG_DIST=/app/dist
USER 65534:65534
EXPOSE 4173
CMD ["rag-ops-server"]
