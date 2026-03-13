const fs = require("fs");

const stamp = "R1_OK";
const outPath = "scripts/_r1_out.txt";

fs.writeFileSync(outPath, stamp + "\n", "utf8");
console.log(stamp);
console.log("WROTE:" + outPath);