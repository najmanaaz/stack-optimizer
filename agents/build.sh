#!/usr/bin/env bash
# Builds the AgentCore Runtime direct-code package into agents/dist:
# Linux ARM64 (Graviton) wheels for the runtime's Python version, plus the
# agent sources and the shared pricing catalog. No Docker required.
# infra/lib/agent-stack.ts deploys this directory.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON_VERSION=3.13

rm -rf dist
mkdir -p dist
uv pip install \
  --quiet \
  --target dist \
  --python-version "$PYTHON_VERSION" \
  --python-platform aarch64-manylinux2014 \
  --only-binary=:all: \
  -r requirements.txt
cp src/*.py dist/
cp ../lib/stack-optimizer/pricing-catalog.json dist/
find dist -name '__pycache__' -type d -prune -exec rm -rf {} +
echo "Built agents/dist ($(du -sh dist | cut -f1))"
