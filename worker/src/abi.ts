/**
 * The parts of `CaptureFlag` (contracts/src/CaptureFlag.sol) this Worker calls. Kept by
 * hand rather than imported from `contracts/out`, which is a gitignored build output.
 */
export const captureFlagAbi = [
  {
    type: "function",
    name: "captureBySig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "c",
        type: "tuple",
        components: [
          { name: "robotId", type: "bytes32" },
          { name: "player", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "lastCapture",
    stateMutability: "view",
    inputs: [{ name: "robotId", type: "bytes32" }, { name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "captureCount",
    stateMutability: "view",
    inputs: [{ name: "robotId", type: "bytes32" }, { name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalCaptures",
    stateMutability: "view",
    inputs: [{ name: "robotId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "uniqueCapturers",
    stateMutability: "view",
    inputs: [{ name: "robotId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mostCaptures",
    stateMutability: "view",
    inputs: [{ name: "robotId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "topCapturer",
    stateMutability: "view",
    inputs: [{ name: "robotId", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "playerTotal",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "cooldown",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "relayer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  { type: "error", name: "NotRelayer", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "NonceUsed", inputs: [] },
  { type: "error", name: "Cooldown", inputs: [{ name: "remaining", type: "uint256" }] },
  { type: "error", name: "BadSignature", inputs: [] },
] as const;
