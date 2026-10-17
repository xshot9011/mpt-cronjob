FROM public.ecr.aws/lambda/python:3.13

# Install the AL2023 shared libraries Playwright's Chromium needs at runtime.
RUN dnf install -y \
    atk at-spi2-atk at-spi2-core cups-libs gtk3 pango cairo \
    alsa-lib nss nspr mesa-libgbm libdrm libxkbcommon \
    libXcomposite libXcursor libXdamage libXext libXfixes libXi \
    libXrandr libXScrnSaver libXtst libXt \
    xorg-x11-server-Xvfb xorg-x11-xauth dbus-glib dbus-glib-devel jq && \
    dnf clean all

# Bake the Chromium build into the image at a fixed, read-only-safe location.
# (Lambda's task dir is read-only at runtime, so the browser must live here and
# HOME must point at the writable /tmp for Chromium's scratch/crashpad files.)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HOME=/tmp

# Install python dependencies
COPY requirements.txt ${LAMBDA_TASK_ROOT}
RUN pip3 install --no-cache-dir -r requirements.txt

# Download the Chromium revision that matches the pinned Playwright version.
RUN python -m playwright install chromium

# Copy source code
COPY scraper.py ${LAMBDA_TASK_ROOT}
COPY lambda_function.py ${LAMBDA_TASK_ROOT}

CMD ["lambda_function.lambda_handler"]
