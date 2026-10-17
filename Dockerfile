# AWS Lambda Node.js base image (Amazon Linux 2023).
# For tamper-evident, reproducible builds pin the digest rather than the tag:
#   FROM public.ecr.aws/lambda/nodejs:24@sha256:<digest>
FROM public.ecr.aws/lambda/nodejs:24

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
