FROM e2bdev/code-interpreter:latest

RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    jq \
    ripgrep \
    unzip \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh

# Vercel CLI
RUN npm install -g vercel

# Google Cloud SDK
RUN curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz | tar -xz -C /opt \
    && /opt/google-cloud-sdk/install.sh --quiet
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"
