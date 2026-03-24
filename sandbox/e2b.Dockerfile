# Aura sandbox template — single source of truth for the sandbox image.
#
# Build:  pnpm --filter aura-sandbox build:prod
# After:  set E2B_TEMPLATE_ID=<id> in Vercel env vars
#
# The build script reads this file via E2B's fromDockerfile() API.
# USER root / USER user are required so the E2B SDK builder (which
# defaults to a non-root user) runs install commands with privileges.

FROM ubuntu:22.04
USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# System packages
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    postgresql-client \
    jq \
    ripgrep \
    sqlite3 \
    curl \
    git \
    wget \
    gnupg \
    lsb-release \
    ca-certificates \
    unzip \
    sudo \
    fuse3 \
    poppler-utils \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Python packages
RUN pip3 install --quiet --no-cache-dir psycopg2-binary google-cloud-bigquery

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update -qq && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Google Cloud SDK (gcloud + bq)
RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    | tee /etc/apt/sources.list.d/google-cloud-sdk.list > /dev/null \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && apt-get update -qq && apt-get install -y google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# Vercel CLI
RUN npm install -g vercel@latest

# pnpm (monorepo package manager)
RUN npm install -g pnpm

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

# gcsfuse (GCS bucket mounts) — signed keyring for proper APT auth
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/gcsfuse.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/gcsfuse.gpg] https://packages.cloud.google.com/apt gcsfuse-jammy main" \
    | tee /etc/apt/sources.list.d/gcsfuse.list > /dev/null \
    && apt-get update -qq && apt-get install -y gcsfuse \
    && rm -rf /var/lib/apt/lists/*

# Working dirs
RUN mkdir -p /home/user/downloads /home/user/data /home/user/aura \
    && chown -R user:user /home/user

USER user
WORKDIR /home/user
