// Portable regression fixture for public RouteTok base 5982efe. These five
// assertions reproduce four original failures before the one-file repair.
import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress } from "../../src/net-address.js";

test("equivalent expanded IPv6 loopback addresses remain private", () => {
  for (const address of ["0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001"]) {
    assert.equal(isPrivateAddress(address), true, `${address} is the IPv6 loopback address`);
  }
});
test("expanded IPv6 unspecified address remains non-public", () => {
  assert.equal(isPrivateAddress("0:0:0:0:0:0:0:0"), true);
});
test("hexadecimal IPv4-mapped private addresses retain IPv4 classification", () => {
  for (const address of ["::ffff:7f00:1", "0:0:0:0:0:ffff:0a00:0001", "::FFFF:c0a8:0101"]) {
    assert.equal(isPrivateAddress(address), true, `${address} maps to private IPv4`);
  }
});
test("hexadecimal IPv4-mapped public addresses remain public", () => {
  assert.equal(isPrivateAddress("::ffff:0808:0808"), false);
});
test("invalid prefix-lookalikes are not classified as private IP addresses", () => {
  for (const address of ["fc-not-an-ip", "fd-invalid", "fe80-not-an-ip"]) {
    assert.equal(isPrivateAddress(address), false, `${address} is not an IP address`);
  }
});
