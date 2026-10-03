# syntax=docker/dockerfile:1
FROM node:24-trixie-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-trixie-slim AS api
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=256
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY server ./server
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/app.cjs"]

FROM node:24-trixie-slim AS worker
ENV NODE_ENV=production FLUX_SERVER=1 HOME=/tmp QT_QPA_PLATFORM=offscreen PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MAGICK_THREAD_LIMIT=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg imagemagick libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
    pandoc qpdf ghostscript libjpeg-turbo-progs optipng webp p7zip-full tesseract-ocr tesseract-ocr-eng \
    calibre blender python3 python3-venv libglib2.0-0 libgl1 fonts-dejavu fonts-liberation \
    libseccomp2 libseccomp-dev gcc libc6-dev ca-certificates file && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY electron ./electron
COPY server ./server
COPY tests/container-smoke.cjs ./tests/container-smoke.cjs
COPY native/archive.py native/advanced.py native/models.py resources/office-formats.json resources/requirements.txt ./resources/
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r resources/requirements.txt \
    && gcc -O2 -Wall -Wextra server/sandbox.c -lseccomp -o /usr/local/bin/flux-sandbox \
    && install -m755 server/linux-pdf.py /app/resources/pdf-tool \
    && install -m755 server/compat.py /usr/local/bin/magick \
    && install -m755 server/compat.py /usr/local/bin/oxipng \
    && install -m755 server/compat.py /usr/bin/ditto \
    && install -m755 server/compat.py /usr/bin/sips \
    && ln -s /usr/bin/7z /usr/local/bin/7zz
# The policy is copied separately so it cannot be silently omitted from a build.
COPY deploy/imagemagick-policy.xml /etc/ImageMagick-6/policy.xml
RUN node server/build-catalog.cjs && apt-get purge -y gcc libc6-dev libseccomp-dev && apt-get autoremove -y && rm -rf /root/.cache /tmp/*
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/worker.cjs"]

FROM debian:trixie-slim AS antivirus
RUN apt-get update && apt-get install -y --no-install-recommends clamav-daemon clamav-freshclam ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /var/lib/clamav && chown 10001:10001 /var/lib/clamav
COPY deploy/clamd.conf /etc/clamav/clamd.conf
COPY deploy/freshclam.conf /etc/clamav/freshclam.conf
USER 10001:10001
EXPOSE 3310
CMD ["clamd", "--foreground=true", "--config-file=/etc/clamav/clamd.conf"]
