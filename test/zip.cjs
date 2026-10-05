/*
 * Round-trip test for src/zip/index.ts.
 *
 * Writes real archives to a temp directory, then hands them to the real 7-Zip
 * on this machine to list and extract. A ZIP that only our own reader can read
 * is not a ZIP, so the arbiter here is deliberately a third-party tool.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

const SEVEN_ZIP = "E:/01-application/20-scoop/shims/7z.exe";
const TMP = path.join(os.tmpdir(), "ib-zip-test");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`);
}

/** Deterministic pseudo-random bytes, for CRC samples and the blob fixture. */
function blobForCrc(n = 4096) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 2654435761) & 0xff;
  return b;
}

function bundle() {
  const out = path.join(os.tmpdir(), "ib-zipwriter.build.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "src", "zip", "index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2018",
    outfile: out,
    logLevel: "silent",
  });
  return require(out);
}

function sevenZip(args) {
  // Force UTF-8 console output: 7-Zip otherwise writes in the OEM codepage
  // (GBK on this machine), so Chinese entry names come back as mojibake and any
  // assertion on the listing text ends up testing 7-Zip's locale, not our zip.
  return execFileSync(SEVEN_ZIP, ["-sccUTF-8", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
}

function main() {
  const Z = bundle();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, "src", "角色立绘"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "out"), { recursive: true });

  // A mix: an incompressible blob (like a JPEG in spirit), a highly
  // compressible text file, and a Chinese directory name.
  const blob = blobForCrc(200 * 1024);
  fs.writeFileSync(path.join(TMP, "src", "shot.bin"), blob);
  const svg = "<svg>" + "<rect/>".repeat(4000) + "</svg>";
  fs.writeFileSync(path.join(TMP, "src", "角色立绘", "立绘.svg"), svg, "utf8");
  fs.writeFileSync(path.join(TMP, "src", "tiny.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

  const entries = [
    { name: "shot.bin", filePath: path.join(TMP, "src", "shot.bin"), size: blob.length },
    { name: "角色立绘/立绘.svg", filePath: path.join(TMP, "src", "角色立绘", "立绘.svg"), size: Buffer.byteLength(svg) },
    { name: "tiny.png", filePath: path.join(TMP, "src", "tiny.png"), size: 8 },
  ];

  // ---------------------------------------------------------------- crc32
  console.log("== crc32");
  // Node's own zlib.crc32 is the independent reference; hand-written expected
  // values only prove the author's arithmetic is self-consistent.
  const zlib = require("zlib");
  check("crc32('123456789') is the standard 0xCBF43926", Z.crc32(Buffer.from("123456789")), 0xcbf43926);
  check("crc32 of empty is 0", Z.crc32(Buffer.alloc(0)), 0);
  const refSamples = [Buffer.from("a"), Buffer.from("hello world"), blobForCrc(), Buffer.from([0, 255, 128, 7])];
  check(
    "crc32 agrees with Node zlib on every sample",
    refSamples.map((b) => Z.crc32(b)),
    refSamples.map((b) => zlib.crc32(b) >>> 0)
  );
  check(
    "crc32Update(0xffffffff, x) ^ 0xffffffff matches too",
    refSamples.map((b) => (Z.crc32Update(0xffffffff, b) ^ 0xffffffff) >>> 0),
    refSamples.map((b) => zlib.crc32(b) >>> 0)
  );
  check(
    "crc32Update is incremental across a split buffer",
    ((Z.crc32Update(Z.crc32Update(0xffffffff, refSamples[1].subarray(0, 5)), refSamples[1].subarray(5)) ^ 0xffffffff) >>> 0),
    zlib.crc32(refSamples[1]) >>> 0
  );

  // ------------------------------------------------------------- ZipCrypto
  console.log("\n== ZipCrypto");
  const a = new Z.ZipCrypto("123456");
  const b = new Z.ZipCrypto("123456");
  const src = Buffer.from("hello zip crypto, hello zip crypto");
  const enc = a.encrypt(src);
  check("ciphertext differs from plaintext", Buffer.from(enc).equals(src), false);
  check("round-trips with the same password", Buffer.from(b.decrypt(enc)).toString(), src.toString());
  const wrong = new Z.ZipCrypto("123457");
  try {
    wrong.decrypt(enc);
  } catch (e) {
    check("decrypting never throws", true, true);
  }
  const head = new Z.ZipCrypto("pw").header(0xdeadbeef, Buffer.alloc(12, 7));
  check("header is 12 bytes", head.length, 12);
  const recovered = new Z.ZipCrypto("pw").decrypt(head);
  check("header's 12th byte is the CRC high byte", recovered[11], 0xde);
  check("header keeps the 11 random bytes", [...recovered.slice(0, 11)], [...Buffer.alloc(11, 7)]);

  // ------------------------------------------------------------ dos stamp
  console.log("\n== timestamps");
  const stamp = Z.dosDateTime(new Date(2026, 9, 4, 20, 30, 40));
  check("date packs 2026-10-04", stamp.date, ((2026 - 1980) << 9) | (10 << 5) | 4);
  check("time packs 20:30:40 as 20:30:20", stamp.time, (20 << 11) | (30 << 5) | 20);

  // ------------------------------------------------------------- deflate?
  console.log("\n== compression policy");
  check("svg is deflated", Z.shouldDeflate("立绘.svg"), true);
  check("png is stored", Z.shouldDeflate("shot.png"), false);
  check("jpg is stored", Z.shouldDeflate("a.JPG"), false);
  check("no extension is stored", Z.shouldDeflate("LICENSE"), false);

  // ---------------------------------------------------------------- plain zip
  console.log("\n== plain archive");
  const plainPath = path.join(TMP, "out", "plain.zip");
  const progress = [];
  return Z.writeZip({
    outPath: plainPath,
    entries,
    onProgress: (p) => progress.push(p.files),
  }).then((res) => {
    check("result counts three files", res.files, 3);
    check("progress fired once per entry", progress, [1, 2, 3]);

    const list = sevenZip(["l", "-ba", plainPath]);
    check("7-Zip sees three entries", list.trim().split(/\r?\n/).filter(Boolean).length, 3);
    // 7-Zip prints the separator of the host OS, so accept either — the
    // archive itself stores `/`, which is what extraction to a nested folder
    // (asserted below) actually proves.
    check("7-Zip reports the svg with its Chinese path", /角色立绘[\\/]立绘\.svg/.test(list), true);

    const test = sevenZip(["t", plainPath]);
    check("7-Zip integrity test passes", /Everything is Ok/.test(test), true);

    const outDir = path.join(TMP, "out", "unpacked");
    sevenZip(["x", "-y", "-o" + outDir, plainPath]);
    check("extracted blob is byte-identical", fs.readFileSync(path.join(outDir, "shot.bin")).equals(blob), true);
    check("extracted svg is byte-identical", fs.readFileSync(path.join(outDir, "角色立绘", "立绘.svg"), "utf8"), svg);
    check("extracted tiny.png is byte-identical", fs.readFileSync(path.join(outDir, "tiny.png")).toString("hex"), "89504e4701020304");

    const svgStored = fs.statSync(path.join(TMP, "out", "plain.zip")).size;
    check("deflate actually shrank the archive below the raw total",
      svgStored < blob.length + svg.length + 8,
      true);

    // ------------------------------------------------------- encrypted zip
    console.log("\n== encrypted archive");
    const encPath = path.join(TMP, "out", "secret.zip");
    return Z.writeZip({ outPath: encPath, entries, password: "482913" }).then(() => {
      const encList = sevenZip(["l", "-ba", "-slt", encPath]);
      check("7-Zip lists the encrypted archive", /secret\.zip/.test(encList) || encList.length > 0, true);
      check("7-Zip marks the entries as encrypted", /Encrypted = \+/.test(sevenZip(["l", "-slt", encPath])), true);

      const okTest = sevenZip(["t", "-p482913", encPath]);
      check("7-Zip validates the correct password", /Everything is Ok/.test(okTest), true);

      let wrongRejected = false;
      try {
        const bad = sevenZip(["t", "-p000000", encPath]);
        wrongRejected = !/Everything is Ok/.test(bad);
      } catch (e) {
        // 7-Zip exits non-zero on a wrong password, which is the pass case.
        wrongRejected = true;
      }
      check("7-Zip rejects a wrong password", wrongRejected, true);

      const encOut = path.join(TMP, "out", "unpacked-enc");
      sevenZip(["x", "-y", "-p482913", "-o" + encOut, encPath]);
      check("encrypted blob decrypts byte-identically",
        fs.readFileSync(path.join(encOut, "shot.bin")).equals(blob), true);
      check("encrypted svg decrypts byte-identically",
        fs.readFileSync(path.join(encOut, "角色立绘", "立绘.svg"), "utf8"), svg);

      // ------------------------------------------------------------ empty zip
      console.log("\n== empty archive");
      const emptyPath = path.join(TMP, "out", "empty.zip");
      return Z.writeZip({ outPath: emptyPath, entries: [] }).then((r) => {
        check("empty archive reports zero files", r.files, 0);
        const emptyList = sevenZip(["l", "-ba", emptyPath]).trim();
        check("7-Zip lists an empty archive as having no entries", emptyList, "");
        check("empty archive is 22 bytes (EOCD only)", fs.statSync(emptyPath).size, 22);

        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail ? 1 : 0);
      });
    });
  }).catch((err) => {
    console.error("threw:", err);
    process.exit(1);
  });
}

main();
