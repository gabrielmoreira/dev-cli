import { appendFileSync } from "node:fs";

/**
 * Bun preload for child-process CLI tests: every Azure DevOps work item request is
 * answered locally and appended to $STUB_FETCH_LOG, so tests can prove which
 * organization and project a command contacted. Any other URL fails the request.
 */
const log = process.env.STUB_FETCH_LOG;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input instanceof Request ? input.url : input);
  if (log) appendFileSync(log, `${url}\n`);
  const match =
    /^https:\/\/dev\.azure\.com\/([^/]+)\/(?:([^/]+)\/)?_apis\/wit\/workitems\/(\d+)/.exec(url);
  if (!match) return new Response("unexpected request", { status: 404 });
  const organization = decodeURIComponent(match[1]!);
  const project = match[2] ? decodeURIComponent(match[2]) : undefined;
  const id = Number(match[3]);
  return Response.json({
    id,
    url,
    fields: {
      "System.Title": `Live ${organization}/${project ?? "-"}/${id}`,
      "System.WorkItemType": "Task",
      "System.State": "New",
      ...(project ? { "System.TeamProject": project } : {}),
    },
  });
}) as typeof fetch;
