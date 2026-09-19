export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      { releaseRules: [{ header: "initial version", release: "major" }] },
    ],
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/exec",
      {
        prepareCmd: "mise run build:release -- ${nextRelease.version}",
        successCmd: "mise run verify:install -- ${nextRelease.version}",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [
          { path: "dist/dev-darwin-arm64.tar.gz", label: "dev for macOS ARM64" },
          { path: "dist/dev-darwin-x64.tar.gz", label: "dev for macOS x64" },
          { path: "dist/dev-linux-arm64.tar.gz", label: "dev for Linux ARM64 (glibc)" },
          { path: "dist/dev-linux-x64.tar.gz", label: "dev for Linux x64 (glibc)" },
          { path: "dist/dev-linux-arm64-musl.tar.gz", label: "dev for Linux ARM64 (musl)" },
          { path: "dist/dev-linux-x64-musl.tar.gz", label: "dev for Linux x64 (musl)" },
          { path: "dist/dev-windows-arm64.zip", label: "dev for Windows ARM64" },
          { path: "dist/dev-windows-x64.zip", label: "dev for Windows x64" },
          { path: "dist/SHA256SUMS", label: "SHA-256 checksums" },
          { path: "dist/dev-installer.sh", label: "Installer for macOS and Linux" },
          { path: "dist/dev-installer.ps1", label: "Installer for Windows" },
        ],
        successComment: false,
        failComment: false,
        releasedLabels: false,
      },
    ],
  ],
};
