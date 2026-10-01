# syntax=docker/dockerfile:1
# One image per workspace binary: BIN=prisma-web-server or BIN=prisma-mock.
FROM rust:1-bookworm AS build
ARG BIN
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p ${BIN} \
 && cp target/release/${BIN} /app

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /app /app
USER nonroot
ENTRYPOINT ["/app"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["/app", "healthcheck"]
