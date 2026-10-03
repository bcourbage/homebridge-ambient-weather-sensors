/** Run the configured editor builder without the CLI's package-install tooling. */
import { Architect } from '@angular-devkit/architect';
import { WorkspaceNodeModulesArchitectHost } from '@angular-devkit/architect/node/index.js';
import { schema, workspaces } from '@angular-devkit/core';
import { createConsoleLogger, NodeJsSyncHost } from '@angular-devkit/core/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep workspace loading, option validation and defaults in Angular's runner. */
export async function runEditorBuild(workspaceRoot) {
  const host = workspaces.createWorkspaceHost(new NodeJsSyncHost());
  const { workspace } = await workspaces.readWorkspace(workspaceRoot, host);
  const logger = createConsoleLogger();
  const registry = new schema.CoreSchemaRegistry();
  // Match ng build's @angular/build path: do not invent empty array options.
  registry.addPostTransform(schema.transforms.addUndefinedObjectDefaults);
  registry.useXDeprecatedProvider(message => logger.warn(message));
  const architect = new Architect(new WorkspaceNodeModulesArchitectHost(workspace, workspaceRoot), registry);
  const run = await architect.scheduleTarget({ project: 'awn-editor', target: 'build' }, {}, { logger });
  try {
    const result = await run.lastOutput;
    if (result.success !== true) throw new Error(result.error || 'Editor build failed.');
    return result;
  } finally {
    await run.stop();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../homebridge-ui');
  await runEditorBuild(root);
}
