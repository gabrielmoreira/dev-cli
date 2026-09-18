FROM public.ecr.aws/debian/debian:bookworm-slim@sha256:833d7afe7d42e2fc552740ebdb947218770eb6f0a533927ed2a04b4d453e4f0a

ARG MISE_VERSION=2026.9.6
ARG NODE_VERSION=24.21.0
ARG DEV_VERSION=1.5.2
ARG QMD_VERSION=2.8.3

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git zsh \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=secret,id=extra_ca,required=false set -eu; \
    if [ -f /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    curl --fail --silent --show-error --location --output /tmp/mise-install.sh https://mise.run; \
    MISE_VERSION="v${MISE_VERSION}" MISE_INSTALL_PATH=/usr/local/bin/mise sh /tmp/mise-install.sh; \
    rm /tmp/mise-install.sh

RUN useradd --create-home --shell /bin/zsh --uid 1000 demo \
    && mkdir --parents /demo /opt/demo \
    && chown --recursive demo:demo /demo /opt/demo

USER demo
ENV HOME=/home/demo
ENV PATH=/home/demo/.local/share/mise/shims:/home/demo/.local/bin:/usr/local/bin:/usr/bin:/bin
ENV SHELL=/bin/zsh
ENV PS1='demo@dev:%~%# '
ENV MISE_DISABLE_UPDATE_WARNING=true

RUN --mount=type=secret,id=extra_ca,required=false,uid=1000,gid=1000,mode=0444 \
    --mount=type=secret,id=npm_registry,required=false,uid=1000,gid=1000,mode=0444 \
    set -eu; \
    if [ -f /run/secrets/extra_ca ]; then \
      export SSL_CERT_FILE=/run/secrets/extra_ca NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca GIT_SSL_CAINFO=/run/secrets/extra_ca; \
    fi; \
    if [ -f /run/secrets/npm_registry ]; then \
      NPM_CONFIG_REGISTRY="$(cat /run/secrets/npm_registry)"; export NPM_CONFIG_REGISTRY; \
    fi; \
    mise use --global "node@${NODE_VERSION}"; \
    mise use --global "npm:@tobilu/qmd@${QMD_VERSION}"; \
    mise use --global "github:gabrielmoreira/dev-cli@${DEV_VERSION}"

COPY --chown=demo:demo --chmod=755 docs/demo/entrypoint.zsh /opt/demo/entrypoint.zsh
COPY --chown=demo:demo docs/demo/mcp-query.mjs /opt/demo/mcp-query.mjs

WORKDIR /demo
ENTRYPOINT ["/opt/demo/entrypoint.zsh"]
