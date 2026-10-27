import { hashDomain, hashStruct, hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import vectors from "../../contracts/test/vectors.json";
import { CAPTURE_TYPES, CaptureShapeError, parseTypedData, recoverPlayer } from "../src/eip712";

const typedData = (message: unknown) => ({
  domain: vectors.domain,
  types: vectors.types,
  primaryType: vectors.primaryType,
  message,
});

describe("eip712 against contracts/test/vectors.json", () => {
  it("uses the contract's types", () => {
    expect(JSON.stringify(vectors.types)).toBe(JSON.stringify(CAPTURE_TYPES));
  });

  it("hashes the domain as the contract does", () => {
    const { domain } = parseTypedData(typedData(vectors.vectors[0].message));
    expect(hashDomain({ domain: { ...domain, chainId: BigInt(domain.chainId) }, types: CAPTURE_TYPES })).toBe(vectors.domainSeparator);
  });

  it.each(vectors.vectors.map((v) => [v.robotKey, v] as const))("%s: hashes and recovers", async (_, v) => {
    const { domain, message } = parseTypedData(typedData(v.message));
    const { EIP712Domain: _d, ...types } = CAPTURE_TYPES;
    expect(hashStruct({ data: message, primaryType: "Capture", types })).toBe(v.structHash);
    expect(hashTypedData({ domain, types, primaryType: "Capture", message })).toBe(v.digest);
    expect(await recoverPlayer(domain, message, v.signature as `0x${string}`)).toBe(vectors.signer.toLowerCase());
  });

  it("rejects extra types", () => {
    const td = typedData(vectors.vectors[0].message);
    expect(() => parseTypedData({ ...td, types: { ...td.types, Extra: [] } })).toThrow(CaptureShapeError);
  });
});
