import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initChildOwnsProcPort } from "../../src/lib/init-spawn-attribution.js";
import { tempDir } from "../helpers/temp-dir.ts";

function procFixture(table: "tcp" | "tcp6", inodes: number[], owned: number[], state = "0A") {
  const root = tempDir("init-proc-");
  mkdirSync(join(root, "net"));
  mkdirSync(join(root, "123", "fd"), { recursive: true });
  for (const name of ["tcp", "tcp6"]) {
    const address = name === "tcp" ? "0100007F" : "00000000000000000000000001000000";
    const rows = name === table ? inodes.map(inode =>
      `0: ${address}:5207 ${address}:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`) : [];
    writeFileSync(join(root, "net", name), `header\n${rows.join("\n")}\n`);
  }
  for (const inode of owned) symlinkSync(`socket:[${inode}]`, join(root, "123", "fd", String(inode)));
  return root;
}

for (const table of ["tcp", "tcp6"] as const) {
  test(`synthetic /proc ${table} rows and matching fd links attribute the simulated child`, () => {
    expect(initChildOwnsProcPort(123, 20999, procFixture(table, [700], [700]))).toBe(true);
  });
  test(`synthetic /proc ${table} rows and mismatched fd links refuse`, () => {
    expect(initChildOwnsProcPort(123, 20999, procFixture(table, [700], [800]))).toBe(false);
  });
  test(`synthetic /proc ${table} rows with an extra socket inode refuse`, () => {
    expect(initChildOwnsProcPort(123, 20999, procFixture(table, [700, 701], [700]))).toBe(false);
  });
}

test("missing or empty synthetic /proc evidence refuses", () => {
  expect(initChildOwnsProcPort(123, 20999, tempDir("init-proc-unknown-"))).toBe(false);
  expect(initChildOwnsProcPort(123, 20999, procFixture("tcp", [], []))).toBe(false);
  expect(initChildOwnsProcPort(456, 20999, procFixture("tcp", [700], [700]))).toBe(false);
});

test("synthetic /proc rows with a non-listening state or another port do not attribute the simulated child", () => {
  expect(initChildOwnsProcPort(123, 20999, procFixture("tcp", [700], [700], "01"))).toBe(false);
  expect(initChildOwnsProcPort(123, 21000, procFixture("tcp", [700], [700]))).toBe(false);
});
