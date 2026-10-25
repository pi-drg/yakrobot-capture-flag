#!/usr/bin/env bash
# One capture by hand (execution plan F2 step 4): the player signs the EIP-712 Capture,
# the relayer submits captureBySig, then the counters are read back.
#
#   CONTRACT=0x… ROBOT_KEY=<gateway-host>/<robot> RPC_URL=https://sepolia.base.org \
#   PLAYER_FLAGS="--account capture-flag-player" \
#   RELAYER_FLAGS="--account capture-flag-relayer" \
#     script/capture.sh [nonce]
#
# PLAYER_FLAGS / RELAYER_FLAGS are cast wallet options (--account, --ledger, …); the
# player needs no ETH. Keys stay in their keystores; only addresses are printed.
set -euo pipefail

: "${CONTRACT:?}" "${ROBOT_KEY:?}" "${RPC_URL:?}" "${PLAYER_FLAGS:?}" "${RELAYER_FLAGS:?}"
nonce="${1:-$(date +%s)}"

# shellcheck disable=SC2086 # the *_FLAGS are word lists on purpose
player="$(cast wallet address $PLAYER_FLAGS)"
chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
robot_id="$(cast keccak "$ROBOT_KEY")"
# From chain time, not this machine's clock: the contract compares block.timestamp.
deadline="$(( $(cast block latest -f timestamp --rpc-url "$RPC_URL") + 600 ))"

typed="$(mktemp)"
trap 'rm -f "$typed"' EXIT
cat >"$typed" <<EOF
{
  "types": {
    "EIP712Domain": [
      {"name": "name", "type": "string"},
      {"name": "version", "type": "string"},
      {"name": "chainId", "type": "uint256"},
      {"name": "verifyingContract", "type": "address"}
    ],
    "Capture": [
      {"name": "robotId", "type": "bytes32"},
      {"name": "player", "type": "address"},
      {"name": "nonce", "type": "uint256"},
      {"name": "deadline", "type": "uint256"}
    ]
  },
  "primaryType": "Capture",
  "domain": {"name": "yakrobot-capture-flag", "version": "1", "chainId": $chain_id,
             "verifyingContract": "$CONTRACT"},
  "message": {"robotId": "$robot_id", "player": "$player", "nonce": "$nonce",
              "deadline": "$deadline"}
}
EOF

# shellcheck disable=SC2086
sig="$(cast wallet sign --data --from-file "$typed" $PLAYER_FLAGS)"
echo "player   $player"
echo "robotId  $robot_id ($ROBOT_KEY)"

# cast --json prints the receipt on success, and {success: false, errors} on failure; a
# revert such as Cooldown(430) is in errors[].message.
# shellcheck disable=SC2086
out="$(cast send "$CONTRACT" "captureBySig((bytes32,address,uint256,uint256),bytes)" \
  "($robot_id,$player,$nonce,$deadline)" "$sig" --rpc-url "$RPC_URL" $RELAYER_FLAGS \
  --json || true)"
if [ "$(jq -r '.success' <<<"$out")" = "false" ] || [ -z "$out" ]; then
  jq -r '.errors[]?.message' <<<"$out" >&2
  exit 1
fi
jq '{transactionHash, blockNumber, status, gasUsed, l1Fee, effectiveGasPrice}' <<<"$out"

read_u() { cast call "$CONTRACT" "$1" "${@:2}" --rpc-url "$RPC_URL"; }
echo "captureCount     $(read_u 'captureCount(bytes32,address)(uint256)' "$robot_id" "$player")"
echo "totalCaptures    $(read_u 'totalCaptures(bytes32)(uint256)' "$robot_id")"
echo "uniqueCapturers  $(read_u 'uniqueCapturers(bytes32)(uint256)' "$robot_id")"
echo "topCapturer      $(read_u 'topCapturer(bytes32)(address)' "$robot_id")"
