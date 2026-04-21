#!/bin/bash
# ============================================================
#  BIDZON — Install k6 on All 6 AWS Machines
#  Usage: bash install-k6.sh
#  Requirements: .pem file, AWS machine IPs
# ============================================================

# ── STEP 1: Set your .pem file path ─────────────────────────
PEM_FILE="./k6m.pem"        # ← change to your .pem filename

# ── STEP 2: Set your AWS machine IPs ────────────────────────
MACHINES=(
  "ubuntu@3.79.166.180"            # ← replace with real IP
  "ubuntu@3.126.240.20"            # ← replace with real IP
  "ubuntu@54.93.239.187"            # ← replace with real IP
  "ubuntu@3.79.149.95"            # ← replace with real IP
  "ubuntu@18.199.99.202"            # ← replace with real IP
  "ubuntu@3.79.186.252"            # ← replace with real IP
)

# ── Colors for output ────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Pre-flight checks ────────────────────────────────────────
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  BIDZON — k6 Install on 6 AWS Machines${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check .pem file exists
if [ ! -f "$PEM_FILE" ]; then
  echo -e "${RED}❌ .pem file not found: $PEM_FILE${NC}"
  echo -e "${YELLOW}   Fix: update PEM_FILE path at top of this script${NC}"
  exit 1
fi

# Fix .pem permissions (AWS requires 400)
chmod 400 "$PEM_FILE"
echo -e "${GREEN}✅ .pem file found and permissions set (chmod 400)${NC}"

# Check IPs are set
for M in "${MACHINES[@]}"; do
  if [[ "$M" == *"MACHINE_"* ]]; then
    echo -e "${RED}❌ IPs not set — update MACHINES array at top of script${NC}"
    exit 1
  fi
done
echo -e "${GREEN}✅ All 6 machine IPs configured${NC}"
echo ""

# ── Install k6 on all machines in parallel ───────────────────
echo -e "${CYAN}Installing k6 on all 6 machines simultaneously...${NC}"
echo ""

declare -A PIDS

for M in "${MACHINES[@]}"; do
  (
    echo -e "${YELLOW}[$(date +%H:%M:%S)] Starting install on $M...${NC}"

    ssh -i "$PEM_FILE" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=30 \
        "$M" "
      # Add k6 GPG key
      sudo gpg --no-default-keyring \
        --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
        --keyserver hkp://keyserver.ubuntu.com:80 \
        --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 2>/dev/null

      # Add k6 apt repo
      echo 'deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main' \
        | sudo tee /etc/apt/sources.list.d/k6.list > /dev/null

      # Update and install
      sudo apt-get update -q 2>/dev/null
      sudo apt-get install -y k6 2>/dev/null

      # Verify
      K6_VER=\$(k6 version 2>/dev/null)
      if [ \$? -eq 0 ]; then
        echo '✅ SUCCESS: '\$K6_VER
      else
        echo '❌ FAILED: k6 not installed'
        exit 1
      fi
    "

    if [ $? -eq 0 ]; then
      echo -e "${GREEN}[$(date +%H:%M:%S)] ✅ $M — k6 installed successfully${NC}"
    else
      echo -e "${RED}[$(date +%H:%M:%S)] ❌ $M — installation FAILED${NC}"
    fi
  ) &
  PIDS[$M]=$!
done

# Wait for all installs to finish
wait

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  All machines done — verifying k6 versions...${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Verify k6 version on all machines ────────────────────────
for i in "${!MACHINES[@]}"; do
  M="${MACHINES[$i]}"
  NUM=$((i + 1))
  VERSION=$(ssh -i "$PEM_FILE" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$M" "k6 version 2>/dev/null" 2>/dev/null)
  if [ -n "$VERSION" ]; then
    echo -e "${GREEN}  Machine ${NUM}: ✅ $VERSION${NC}"
  else
    echo -e "${RED}  Machine ${NUM}: ❌ k6 not found on $M${NC}"
  fi
done

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  k6 installation complete on all machines!${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Next step: copy your k6 scripts to each machine"
echo -e "  Run: ${YELLOW}bash copy-scripts.sh${NC}"
echo ""
