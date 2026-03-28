FROM public.ecr.aws/lambda/python:3.13 AS build

# Fetch the exact linux64 Chromium binaries via multi-stage
RUN dnf install -y unzip && \
    curl -Lo "/tmp/chromedriver-linux64.zip" "https://storage.googleapis.com/chrome-for-testing-public/147.0.7727.24/linux64/chromedriver-linux64.zip" && \
    curl -Lo "/tmp/chrome-headless-shell-linux64.zip" "https://storage.googleapis.com/chrome-for-testing-public/147.0.7727.24/linux64/chrome-headless-shell-linux64.zip" && \
    unzip -q /tmp/chromedriver-linux64.zip -d /opt/ && \
    unzip -q /tmp/chrome-headless-shell-linux64.zip -d /opt/

FROM public.ecr.aws/lambda/python:3.13

# Install necessary AL2023 OS shared libraries for Chrome
RUN dnf install -y atk cups-libs gtk3 libXcomposite alsa-lib \
    libXcursor libXdamage libXext libXi libXrandr libXScrnSaver \
    libXtst pango at-spi2-atk libXt xorg-x11-server-Xvfb \
    xorg-x11-xauth dbus-glib dbus-glib-devel nss mesa-libgbm jq unzip

# Copy from build stage and place them exactly where your scraper.py expects them:
# /opt/bin/headless-chromium/chrome-headless-shell and /opt/bin/chromedriver
RUN mkdir -p /opt/bin/headless-chromium
COPY --from=build /opt/chrome-headless-shell-linux64/ /opt/bin/headless-chromium/
COPY --from=build /opt/chromedriver-linux64/chromedriver /opt/bin/chromedriver

RUN chmod +x /opt/bin/headless-chromium/chrome-headless-shell /opt/bin/chromedriver

# Intall python dependencies
COPY requirements.txt ${LAMBDA_TASK_ROOT}
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy source code
COPY scraper.py ${LAMBDA_TASK_ROOT}
COPY lambda_function.py ${LAMBDA_TASK_ROOT}
COPY config.json ${LAMBDA_TASK_ROOT}

CMD ["lambda_function.lambda_handler"]
