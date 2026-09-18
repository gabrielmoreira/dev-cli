import { defineCommand } from "citty";
import { inspectEnvironment, inspectHardware } from "../doctor.ts";
import { ui } from "../ui.ts";
import { getActiveConfig } from "./context.ts";

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Inspect runtime environment, dependencies, and git configuration",
  },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const report = await inspectEnvironment(config);

    ui.result({
      data: report,
      json: args.json,
      text: () => {
        let out = "Diagnostic Report\n";
        out += `Status:   ${report.status.toUpperCase()}\n`;
        out += `Dev Root: ${report.root.path} (${report.root.exists ? "exists" : "missing"}, .dev/: ${
          report.root.hasDevDir ? "yes" : "no"
        })\n\n`;
        out += "Tools:\n";
        for (const tool of report.tools) {
          const status = tool.available
            ? tool.version
              ? `available (${tool.version})`
              : "available"
            : `not found (${tool.message || "missing"})`;
          out += `  - ${tool.name}: ${status}\n`;
        }

        if (report.providerList.length === 0) {
          out += "\nProviders: none configured (run 'dev provider add <type>')\n";
        } else {
          const maxIdLen = Math.max(...report.providerList.map((p) => p.id.length));
          out += "\nProviders:\n";
          for (const p of report.providerList) {
            const id = p.id.padEnd(maxIdLen);
            const typeLabel = p.type === "azure_devops" ? "ado   " : "github";
            const credStatus = p.configured
              ? `configured (${p.credentialSource || "token"})`
              : "credentials not found";
            out += `  - ${id}  [${typeLabel}]  ${p.target}  —  ${credStatus}\n`;
          }
        }

        if (report.messages.length > 0) {
          out += "\nMessages:\n";
          for (const msg of report.messages) {
            out += `  ! ${msg}\n`;
          }
        }
        return out.trimEnd();
      },
    });

    return report.status === "error" ? 1 : 0;
  },
});

export const hardwareCommand = defineCommand({
  meta: {
    name: "hardware",
    description: "Inspect hardware capabilities and recommend local LLM tiers",
  },
  args: {
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  run({ args }) {
    const report = inspectHardware();

    ui.result({
      data: report,
      json: args.json,
      text: () => {
        let out = "Hardware Profile & Model Recommendations\n";
        out += `Platform:         ${report.platform}\n`;
        out += `Architecture:     ${report.arch}\n`;
        out += `CPU:              ${report.cpu.model} (${report.cpu.cores} cores @ ${report.cpu.speedMHz} MHz)\n`;
        out += `Memory:           ${report.memory.totalGB} GB total (${report.memory.freeGB} GB free)\n`;
        out += `Profile:          ${report.profile.toUpperCase()}\n`;
        out += `Recommended Tier: ${report.recommendations.recommendedModelTier}\n`;
        out += `Max Context:      ${report.recommendations.maxContextWindow.toLocaleString()} tokens\n`;
        out += "Suggested Models:\n";
        for (const model of report.recommendations.suggestedModels) {
          out += `  - ${model}\n`;
        }
        if (report.recommendations.notes.length > 0) {
          out += "Notes:\n";
          for (const note of report.recommendations.notes) {
            out += `  * ${note}\n`;
          }
        }
        return out.trimEnd();
      },
    });

    return 0;
  },
});
