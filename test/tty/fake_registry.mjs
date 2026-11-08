// A stand-in for the npm registry on 127.0.0.1, run as a child process (the
// tests block in spawnSync, so a server in the test process could not answer).
//   node fake_registry.mjs <mode> <log file>
// Prints its port, logs each request as one JSON line, and answers by <mode>:
//   body:<text>   200 with that body
//   status:<n>    that status
//   hang          never answers
//   stall         sends the headers and half a body, then nothing
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const [mode, log] = process.argv.slice(2);
const server = createServer((req, res) => {
  appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, headers: req.headers }) + "\n");
  if (mode === "hang") return;
  if (mode === "stall") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"lat');
    return;
  }
  if (mode.startsWith("status:")) {
    res.writeHead(Number(mode.slice("status:".length)));
    res.end("{}");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(mode.slice("body:".length));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
