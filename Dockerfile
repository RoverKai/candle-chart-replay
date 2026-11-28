# syntax=docker/dockerfile:1
# 构建：Alpine 上的 Rust（musl 静态二进制）；运行：scratch，只带二进制 + 前端 + 样例数据。

FROM rust:1.92-alpine AS builder
WORKDIR /build

# 先只复制清单做依赖层缓存；dummy main 让 cargo 只编译第三方依赖
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir -p src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src

COPY server/src ./src
RUN cargo build --release --locked

FROM scratch
COPY --from=builder /build/target/release/kline-replay /app/kline-replay
COPY --chown=10001:10001 web /app/web
COPY --chown=10001:10001 data /app/data

WORKDIR /app
USER 10001:10001
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/app/kline-replay", "--healthcheck", "127.0.0.1:8888"]

CMD ["/app/kline-replay", "--host", "0.0.0.0", "--port", "8888"]
