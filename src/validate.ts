import { readFileSync } from "node:fs";
import Ajv from "ajv";

interface Script {
  name: string;
  url: string;
}

const errors: string[] = [];

const validateManifest = new Ajv().compile<{ main: string }>(
  JSON.parse(readFileSync("src/package.schema.json", "utf8")),
);

async function main() {
  const registry = JSON.parse(readFileSync("registry.json", "utf8")) as {
    scripts: Script[];
  };

  checkUniqueness(registry.scripts);
  for (const script of registry.scripts) {
    await checkRepo(script);
  }

  if (errors.length > 0) {
    console.error(`Registry validation failed:\n`);
    for (const error of errors) {
      if (process.env.GITHUB_ACTIONS === "true") {
        console.log(`::error file=registry.json::${error}`);
      } else {
        console.error(`  - ${error}`);
      }
    }
    process.exit(1);
  }
  console.log(
    `Registry is valid (${registry.scripts.length} scripts checked).`,
  );
}

main().catch((error) => {
  console.error(`Registry validation crashed: ${error}`);
  process.exit(1);
});

function checkUniqueness(scripts: Script[]) {
  const names = new Set<string>();
  const urls = new Set<string>();

  for (const script of scripts) {
    const name = script.name.toLowerCase();
    if (names.has(name)) {
      errors.push(`Duplicate name: ${script.name}`);
    }
    names.add(name);

    const url = normalizeUrl(script.url);
    if (urls.has(url)) {
      errors.push(`Duplicate url: ${script.url}`);
    }
    urls.add(url);
  }
}

async function checkRepo(script: Script) {
  const repo = parseRepo(script.url);
  if (!repo) {
    errors.push(`${script.name}: url is not a GitHub repo: ${script.url}`);
    return;
  }

  const packageJson = await getFile(repo, "package.json");
  if (!packageJson) {
    errors.push(
      `${script.name}: repo is unreachable or has no package.json: ${script.url}`,
    );
    return;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    errors.push(`${script.name}: package.json is not valid JSON`);
    return;
  }

  if (!validateManifest(manifest)) {
    for (const error of validateManifest.errors ?? []) {
      errors.push(
        `${script.name}: package.json ${error.instancePath || "/"} ${error.message}`,
      );
    }
    return;
  }

  const mainFile = await getFile(repo, manifest.main);
  if (!mainFile) {
    errors.push(
      `${script.name}: main file "${manifest.main}" does not exist in the repo`,
    );
  }
}

// Pulls "owner/repo" out of a GitHub url, ignoring a trailing ".git" or slash.
function parseRepo(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

// Fetches a file from a repo's default branch, or null if it isn't there.
async function getFile(repo: string, path: string): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
  };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    { headers },
  );
  return response.ok ? response.text() : null;
}
