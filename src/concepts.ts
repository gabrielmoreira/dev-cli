export const CONCEPTS: readonly { name: string; job: string; contrast: string }[] = [
  {
    name: "root",
    job: "The folder where dev keeps your workspaces, mirrors and settings, `~/dev` by default.",
    contrast: "Most people need one; add another to keep one client's work apart.",
  },
  {
    name: "provider",
    job: "A connection to GitHub or Azure DevOps, so dev knows your repositories and pull requests.",
    contrast: "Without one, you work from repository URLs.",
  },
  {
    name: "repository",
    job: "A Git repository on GitHub, Azure DevOps or any URL.",
    contrast: "dev never changes where it lives; it copies it into a workspace or a mirror.",
  },
  {
    name: "workspace",
    job: "A folder for one task: notes in `ws.md`, plus the repositories the task needs.",
    contrast: "A workset is a recipe; a workspace is what you work in.",
  },
  {
    name: "mount",
    job: "One repository inside a workspace, on its own branch. You edit and commit here.",
    contrast: "A mirror is for reading; a mount is for changing.",
  },
  {
    name: "workset",
    job: "A saved recipe for a workspace: which repositories, on which branches, and why.",
    contrast: "Start a workspace from it with `dev ws init --workset <name>`.",
  },
  {
    name: "label",
    job: "A name for a group of repositories, like `team:payments`.",
    contrast:
      "A label groups repositories; a workset says what one task needs from them. `index:` labels also keep their repositories mirrored and searchable.",
  },
  {
    name: "mirror",
    job: "A reference copy of a repository that dev keeps up to date, for reading, search and agents.",
    contrast: "Do task work in a workspace mount, not in a mirror.",
  },
];
