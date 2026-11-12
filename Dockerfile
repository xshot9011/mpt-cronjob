# AWS Lambda Node.js 24 (Amazon Linux 2023)
# AWS image release: 24.2026.11.12.19
# Node.js version: v24.22.3
# Pinned by SHA256 digest for reproducible builds.
FROM public.ecr.aws/lambda/nodejs:24.2026.11.12.19@sha256:64864c65f7de029833a0a5e6b054c5102a65c67aa1e3105a060ec6891e239670


# Install the AL2023 shared libraries Playwright's Chromium needs at runtime.
RUN dnf install -y \
    atk at-spi2-atk at-spi2-core cups-libs gtk3 pango cairo \
    alsa-lib nss nspr mesa-libgbm libdrm libxkbcommon \
    libXcomposite libXcursor libXdamage libXext libXfixes libXi \
    libXrandr libXScrnSaver libXtst libXt \
    xorg-x11-server-Xvfb xorg-x11-xauth dbus-glib dbus-glib-devel jq && \
    dnf clean all

WORKDIR ${LAMBDA_TASK_ROOT}

# Bake the Chromium build into the image at a fixed, read-only-safe location.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install exactly what package-lock.json pins (integrity-hash checked), without
# running any dependency lifecycle scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# Download the Chromium revision that matches the pinned Playwright version.
RUN ./node_modules/.bin/playwright install chromium

# Lambda's task dir is read-only at runtime, so HOME must point at the writable
# /tmp for Chromium's scratch/crashpad files.
ENV HOME=/tmp

# Copy source code
COPY src/ ./src/

CMD ["src/lambda.handler"]
