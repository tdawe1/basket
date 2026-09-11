# Small sidecar for the shared-passwords section: polls Proton Pass and pushes
# a cache into Basket. No token is baked in; configure it at runtime.
FROM node:24-bookworm-slim
WORKDIR /app
ARG PASS_CLI_VERSION=2.3.3
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists \
  && curl -fsSL "https://github.com/protonpass/pass-cli/releases/download/${PASS_CLI_VERSION}/pass-cli-linux-x86_64" -o /usr/local/bin/pass-cli \
  && chmod +x /usr/local/bin/pass-cli \
  && curl -fsSL "https://github.com/protonpass/pass-cli/releases/download/${PASS_CLI_VERSION}/pass-cli-linux-x86_64.sha256" -o /tmp/pass-cli.sha256 \
  && [ "$(sha256sum /usr/local/bin/pass-cli | cut -d' ' -f1)" = "$(cut -d' ' -f1 /tmp/pass-cli.sha256)" ] \
  && rm /tmp/pass-cli.sha256
COPY sync.mjs ./
ENV PROTON_PASS_VAULT=Shared
ENV PASS_CLI_BIN=pass-cli
ENV SYNC_INTERVAL_S=300
CMD ["node", "sync.mjs"]
