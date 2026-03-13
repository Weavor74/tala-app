const fs = require("fs");

const stamp = "TOOLCHAIN_PROBE_OK";
const outPath = "scripts/_toolchain_probe_output.txt";

fs.writeFileSync(outPath, stamp + "\n", "utf8");
console.log(stamp);
console.log("WROTE:" + outPath);