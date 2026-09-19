FROM public.ecr.aws/debian/debian:bookworm-slim@sha256:833d7afe7d42e2fc552740ebdb947218770eb6f0a533927ed2a04b4d453e4f0a

ARG MISE_VERSION=2026.9.6
ARG NODE_VERSION=24.21.0
ARG DEV_VERSION=1.5.2
ARG QMD_VERSION=2.8.3
ARG SKILLS_REVISION=d5cdb657ea95ab27c6233e959c08af5eb3806092

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl fzf git zsh \
    && rm -rf /var/lib/apt/lists/*
ARG SPACESHIP_VERSION=4.22.5
ARG HERDR_VERSION=0.9.1
ARG OMP_VERSION=18.2.6

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
ENV PATH=/home/demo/.local/bin:/home/demo/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
ENV SHELL=/bin/zsh
ENV MISE_DISABLE_UPDATE_WARNING=true
ENV SSL_CERT_FILE=/home/demo/.cache/certs/ca-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/home/demo/.cache/certs/ca-bundle.pem
ENV GIT_SSL_CAINFO=/home/demo/.cache/certs/ca-bundle.pem

RUN --mount=type=secret,id=extra_ca,required=false,uid=1000,gid=1000,mode=0444 \
    --mount=type=secret,id=npm_registry,required=false,uid=1000,gid=1000,mode=0444 \
    set -eu; \
    mkdir -p "$HOME/.cache/certs"; \
    cat /etc/ssl/certs/ca-certificates.crt > "$SSL_CERT_FILE"; \
    if [ -f /run/secrets/extra_ca ]; then cat /run/secrets/extra_ca >> "$SSL_CERT_FILE"; fi; \
    if [ -f /run/secrets/npm_registry ]; then \
      NPM_CONFIG_REGISTRY="$(cat /run/secrets/npm_registry)"; export NPM_CONFIG_REGISTRY; \
    fi; \
    mise use --global "node@${NODE_VERSION}"; \
    mise use --global "npm:@tobilu/qmd@${QMD_VERSION}"; \
    mise use --global "github:ogulcancelik/herdr@${HERDR_VERSION}"; \
    mise use --global "github:can1357/oh-my-pi@${OMP_VERSION}"; \
    mise use --global "github:gabrielmoreira/dev-cli@${DEV_VERSION}"; \
    mkdir -p "$HOME/.cache/omp-docs"; \
    curl --fail --silent --show-error --location \
      "https://raw.githubusercontent.com/can1357/oh-my-pi/v${OMP_VERSION}/docs/models.md" \
      --output "$HOME/.cache/omp-docs/models.md"; \
    curl --fail --silent --show-error --location \
      "https://raw.githubusercontent.com/can1357/oh-my-pi/v${OMP_VERSION}/docs/providers.md" \
      --output "$HOME/.cache/omp-docs/providers.md"; \
    mkdir -p "$HOME/.cache/skills/skills/debugging-by-evidence"; \
    curl --fail --silent --show-error --location \
      "https://raw.githubusercontent.com/gabrielmoreira/skills/${SKILLS_REVISION}/skills/debugging-by-evidence/SKILL.md" \
      --output "$HOME/.cache/skills/skills/debugging-by-evidence/SKILL.md"; \
    git clone --quiet --depth 1 --branch "v${SPACESHIP_VERSION}" \
      https://github.com/spaceship-prompt/spaceship-prompt.git "$HOME/.local/share/spaceship"; \
    rm --recursive --force "$HOME/.local/share/spaceship/.git"

RUN set -eu; \
    mkdir -p /tmp/qmd-warmup; \
    printf '# QMD warmup\n' > /tmp/qmd-warmup/README.md; \
    qmd collection add /tmp/qmd-warmup --name demo-warmup; \
    qmd embed -c demo-warmup; \
    qmd collection remove demo-warmup; \
    rm -rf /tmp/qmd-warmup

COPY --chown=demo:demo --chmod=755 docs/demo/entrypoint.zsh /opt/demo/entrypoint.zsh
COPY --chown=demo:demo --chmod=755 docs/demo/omp /home/demo/.local/bin/omp
COPY --chown=demo:demo docs/demo/spaceship.zsh /home/demo/.config/spaceship.zsh
COPY --chown=demo:demo docs/demo/zshrc /home/demo/.zshrc
COPY --chown=demo:demo docs/demo/herdr.toml /home/demo/.config/herdr/config.toml
COPY --chown=demo:demo docs/demo/workset.yaml /opt/demo/workset.yaml

WORKDIR /demo
ENTRYPOINT ["/opt/demo/entrypoint.zsh"]
