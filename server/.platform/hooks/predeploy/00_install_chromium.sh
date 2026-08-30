#!/bin/bash
# Installs a headless Chromium (via Playwright) for server-side rendering of
# JS-only job-posting pages (Workday/ADP/etc) that a plain fetch in main.py
# can't read. This box is a t3.micro (1GB RAM) -- deliberately best-effort
# and NON-FATAL: if any step here fails, the deploy still succeeds and the
# app still runs. main.py's _fetch_rendered_text() already treats a missing
# or broken Chromium install as "just use the plain-fetch result" rather
# than an error, so a failed setup here degrades that one feature, not the
# whole service.
#
# Runs as root, after `pip install -r requirements.txt` (predeploy hooks run
# after the platform installs dependencies, before the app restarts).
set -x

# This hook runs as root, but the app itself runs as a different user
# (webapp) with a different $HOME -- Playwright's default browser cache path
# is ~/.cache/ms-playwright, which would put the browser somewhere the app
# process can never see. Force both install and runtime lookup (main.py sets
# the same var before importing playwright) to one shared, absolute path
# instead of relying on either user's HOME.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

VENV_PY="$(ls /var/app/venv/*/bin/python3 2>/dev/null | head -1)"
if [ -z "$VENV_PY" ]; then
  echo "chromium-setup: couldn't find the app venv's python, skipping" >&2
  exit 0
fi

# Amazon Linux 2023 (dnf/RHEL-family) package names for headless Chromium's
# runtime shared libraries. Playwright's own `install --with-deps` doesn't
# support AL2023, so this list is assembled from the known RHEL/Fedora
# equivalents of what Chromium needs (nss/atk/gtk/mesa/X11/fonts).
dnf install -y \
  nss nspr atk at-spi2-atk at-spi2-core cups-libs \
  mesa-libgbm alsa-lib pango cairo libdrm libxkbcommon \
  libX11 libXcomposite libXdamage libXext libXfixes libXrandr \
  libxcb libxshmfence liberation-fonts \
  || echo "chromium-setup: dnf install had failures, continuing anyway" >&2

"$VENV_PY" -m playwright install chromium \
  || echo "chromium-setup: playwright install failed -- URL-scrape will fall back to plain fetch" >&2

# Whatever user the app runs as needs to read+execute this -- it was just
# installed as root.
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || true

exit 0
