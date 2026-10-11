// The stand-ins scripts/try-ci-templates.sh puts beside a CI job, run inside a node container on the job's docker
// network (so it works the same with Docker Desktop and on Linux, where a container cannot reach the host's
// 127.0.0.1):
//
//   - the fake cloud (@sponson/sim, installed from the tarball packed from this checkout) on 0.0.0.0:4777;
//   - an npm registry on 0.0.0.0:4873 that serves the tarballs it is given (the packages packed from this checkout:
//     sponson, @sponson/*) and forwards every other request to registry.npmjs.org, so a template's
//     `npx -y sponson@<version>` installs this checkout's code exactly the way it would install a release;
//   - on the registry's port, under /_circleci/, the two CircleCI API reads the CircleCI template makes to find who
//     approved the hold job (jobs.ts points the job's curl there).
//
// Usage (inside the container): node fakes.mjs <dir with *.tgz> <base URL the jobs use for the registry>
// It writes nothing; GET /_state on the sim port is the fake cloud's state, for the script's checks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createSimServer, SimState } from "@sponson/sim";

const [pkgDir, registryUrl] = process.argv.slice(2);
if (!pkgDir || !registryUrl) throw new Error("usage: node fakes.mjs <dir with *.tgz> <registry base URL>");

createSimServer(new SimState()).listen(4777, "0.0.0.0", () => console.log("fake cloud on :4777"));

/** name -> packument, for every tarball in pkgDir. */
const local = new Map();
const files = new Map();
for (const file of readdirSync(pkgDir).filter((f) => f.endsWith(".tgz"))) {
  const path = join(pkgDir, file);
  const data = readFileSync(path);
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" }));
  files.set(file, data);
  local.set(manifest.name, {
    name: manifest.name,
    "dist-tags": { latest: manifest.version },
    versions: {
      [manifest.version]: {
        ...manifest,
        _id: `${manifest.name}@${manifest.version}`,
        dist: {
          tarball: `${registryUrl}/-/files/${file}`,
          integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
          shasum: createHash("sha1").update(data).digest("hex"),
        },
      },
    },
  });
}
console.log(`registry serves ${[...local.keys()].join(", ")} from ${pkgDir}`);

// CircleCI's API v2, the two reads the template's approver step makes, answered with the shapes CircleCI documents:
// GET /workflow/{id}/job (the approval job carries `approved_by`, a user id) and GET /user/{id} (with `login`).
const APPROVER = "5f3c2a1b-0000-4000-8000-00000000a11c";
function circleApi(userId) {
  if (userId !== undefined) return userId === APPROVER ? { id: APPROVER, login: "alice", name: "Alice" } : { message: "User not found" };
  return {
    items: [
      { name: "hold", type: "approval", status: "success", approved_by: APPROVER, approval_request_id: "00000000-0000-4000-8000-0000000000a1", dependencies: [] },
      { name: "sponson-production", type: "build", status: "running", dependencies: ["00000000-0000-4000-8000-0000000000a1"] },
    ],
    next_page_token: null,
  };
}

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const file = /^\/-\/files\/([^/]+)$/.exec(path)?.[1];
  if (file !== undefined && files.has(file)) {
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(files.get(file));
    return;
  }
  const circle = /^\/_circleci\/api\/v2\/(?:workflow\/[^/]+\/job|user\/([^/]+))$/.exec(path);
  if (circle) {
    res.writeHead(req.headers["circle-token"] ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(circleApi(circle[1])));
    return;
  }
  const packument = local.get(path.slice(1));
  if (packument) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packument));
    return;
  }
  // Everything else (the dependencies' metadata) comes from npm; their tarball URLs point at npm directly.
  fetch(`https://registry.npmjs.org${req.url}`, { headers: { accept: req.headers.accept ?? "application/json" } })
    .then(async (r) => res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await r.arrayBuffer())))
    .catch((e) => res.writeHead(502).end(String(e)));
}).listen(4873, "0.0.0.0", () => console.log("npm registry on :4873"));
