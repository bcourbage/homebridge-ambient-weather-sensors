/**
 * Angular bootstrap for the sensor-map editor (GA task #69, PR A).
 *
 * The app mounts onto the <awn-root> element inside the HANDWRITTEN
 * fragment homebridge-ui/public/index.html — Angular's own index
 * generation is disabled (HB UI X requires a document-tag-free
 * fragment). Zoneless change detection: no zone.js dependency.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { AwnRootComponent } from './awn-root.component';

bootstrapApplication(AwnRootComponent, {
  providers: [provideZonelessChangeDetection()],
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[awn-editor] bootstrap failed:', err);
});
