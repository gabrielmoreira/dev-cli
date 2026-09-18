import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const FIXTURE_WORK_ITEM_TITLE = "Implement payment processing webhook idempotency";
const FIXTURE_WRITE_CONFIRMATION = "true";

function fixtureSetting(content: string, name: string): string | undefined {
  const fromEnvironment = process.env[name]?.trim();
  if (fromEnvironment) return fromEnvironment;
  return content.match(new RegExp(`^#?\\s*${name}=(.+)$`, "m"))?.[1]?.trim();
}

function requiredFixtureSetting(content: string, name: string): string {
  const value = fixtureSetting(content, name);
  if (!value) {
    throw new Error(`${name} must be configured through the environment or .env`);
  }
  return value;
}

function assertFixtureWritesEnabled(content: string): void {
  if (fixtureSetting(content, "AZURE_DEVOPS_FIXTURE_ALLOW_WRITES") !== FIXTURE_WRITE_CONFIRMATION) {
    throw new Error(
      "Refusing Azure DevOps fixture writes without AZURE_DEVOPS_FIXTURE_ALLOW_WRITES=true",
    );
  }
}

export interface AdoFixtureConfig {
  organization: string;
  project: string;
  repoName: string;
  gitUrl: string;
  pat: string;
  openPrId?: number;
  workItemId?: number;
}

export function getAdoFixtureConfig(): AdoFixtureConfig {
  const envPath = join(process.cwd(), ".env");
  const content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  assertFixtureWritesEnabled(content);

  const pat = requiredFixtureSetting(content, "AZURE_DEVOPS_FIXTURE_PAT");
  const organization = requiredFixtureSetting(content, "AZURE_DEVOPS_FIXTURE_ORGANIZATION");
  const project = requiredFixtureSetting(content, "AZURE_DEVOPS_FIXTURE_PROJECT");
  const repoName = requiredFixtureSetting(content, "AZURE_DEVOPS_FIXTURE_REPOSITORY");
  const gitUrl = `https://dev.azure.com/${organization}/${project}/_git/${repoName}`;

  return {
    organization,
    project,
    repoName,
    gitUrl,
    pat,
  };
}

export async function ensureAdoFixture(): Promise<AdoFixtureConfig> {
  const config = getAdoFixtureConfig();

  const basic = Buffer.from(`:${config.pat}`).toString("base64");
  const headers = {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
  };

  // Check or create repository
  const repoRes = await fetch(
    `https://dev.azure.com/${config.organization}/${config.project}/_apis/git/repositories/${config.repoName}?api-version=7.1-preview.1`,
    { headers },
  );

  if (repoRes.status === 404) {
    const createRes = await fetch(
      `https://dev.azure.com/${config.organization}/${config.project}/_apis/git/repositories?api-version=7.1-preview.1`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name: config.repoName }),
      },
    );
    if (!createRes.ok) {
      throw new Error(`Failed to create fixture repository: ${await createRes.text()}`);
    }
  }

  // Check branches
  const refsRes = await fetch(
    `https://dev.azure.com/${config.organization}/${config.project}/_apis/git/repositories/${config.repoName}/refs?api-version=7.1-preview.1`,
    { headers },
  );

  let hasMain = false;
  let hasFeature = false;

  if (refsRes.ok) {
    const data = (await refsRes.json()) as { value: Array<{ name: string }> };
    hasMain = data.value.some((r) => r.name === "refs/heads/main");
    hasFeature = data.value.some((r) => r.name === "refs/heads/feature/payments");
  }

  if (!hasMain || !hasFeature) {
    const tempDir = await mkdtemp(join(tmpdir(), "seed-alpha-"));
    const extraHeader = `http.extraheader=AUTHORIZATION: basic ${basic}`;

    try {
      await Bun.spawn(["git", "init", "-b", "main"], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "config", "user.name", "Dev Lab Agent"], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "config", "user.email", "dev-lab@example.com"], { cwd: tempDir })
        .exited;

      await Bun.write(join(tempDir, "README.md"), "# Alpha Service\n\nInitial fixture commit.\n");
      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "feat: initial alpha-service commit"], {
        cwd: tempDir,
      }).exited;

      await Bun.write(join(tempDir, "service.ts"), "export const service = 'alpha';\n");
      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "feat: add service export"], { cwd: tempDir }).exited;

      await Bun.spawn(["git", "remote", "add", "origin", config.gitUrl], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "-c", extraHeader, "push", "-u", "origin", "main"], { cwd: tempDir })
        .exited;

      await Bun.spawn(["git", "checkout", "-b", "feature/payments"], { cwd: tempDir }).exited;
      await Bun.write(join(tempDir, "payments.ts"), "export const payments = true;\n");
      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "feat: add payments feature branch"], {
        cwd: tempDir,
      }).exited;

      await Bun.spawn(["git", "-c", extraHeader, "push", "-u", "origin", "feature/payments"], {
        cwd: tempDir,
      }).exited;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  // Ensure an open fixture pull request exists
  const prsRes = await fetch(
    `https://dev.azure.com/${config.organization}/${config.project}/_apis/git/repositories/${config.repoName}/pullrequests?searchCriteria.status=active&api-version=7.0`,
    { headers },
  );

  let openPrId: number | undefined;
  if (prsRes.ok) {
    const prsData = (await prsRes.json()) as {
      value: Array<{ pullRequestId: number; sourceRefName: string }>;
    };
    const existing = prsData.value.find((p) => p.sourceRefName === "refs/heads/feature/payments");
    if (existing) {
      openPrId = existing.pullRequestId;
    }
  }

  if (!openPrId) {
    const createPrRes = await fetch(
      `https://dev.azure.com/${config.organization}/${config.project}/_apis/git/repositories/${config.repoName}/pullrequests?api-version=7.0`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceRefName: "refs/heads/feature/payments",
          targetRefName: "refs/heads/main",
          title: "Feature: Implement payments processing",
          description: "Adds payments processing capabilities to alpha-service.",
        }),
      },
    );
    if (createPrRes.ok) {
      const createdPr = (await createPrRes.json()) as { pullRequestId: number };
      openPrId = createdPr.pullRequestId;
    }
  }

  config.openPrId = openPrId;

  // Ensure an issue work item exists
  const wiRes = await fetch(
    `https://dev.azure.com/${config.organization}/${config.project}/_apis/wit/wiql?api-version=7.0`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${config.project}' AND [System.Title] = '${FIXTURE_WORK_ITEM_TITLE}'`,
      }),
    },
  );

  let workItemId: number | undefined;
  if (wiRes.ok) {
    const wiData = (await wiRes.json()) as { workItems: Array<{ id: number }> };
    if (wiData.workItems && wiData.workItems.length > 0) {
      workItemId = wiData.workItems[0].id;
    }
  }

  if (!workItemId) {
    const createWiRes = await fetch(
      `https://dev.azure.com/${config.organization}/${config.project}/_apis/wit/workitems/$Issue?api-version=7.0`,
      {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "Content-Type": "application/json-patch+json",
        },
        body: JSON.stringify([
          {
            op: "add",
            path: "/fields/System.Title",
            value: FIXTURE_WORK_ITEM_TITLE,
          },
          {
            op: "add",
            path: "/fields/System.Description",
            value: "Ensure webhook event processing is strictly idempotent.",
          },
        ]),
      },
    );
    if (createWiRes.ok) {
      const createdWi = (await createWiRes.json()) as { id: number };
      workItemId = createdWi.id;
    }
  }

  config.workItemId = workItemId;
  return config;
}
