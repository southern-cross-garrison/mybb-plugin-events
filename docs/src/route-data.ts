import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import pluginInfo from '../../plugin/inc/plugins/events.php?raw';

// The plugin's version, read from events_info() so the guide's front page names the
// release it documents without anybody having to remember to update it.
const version = pluginInfo.match(/"version"\s*=>\s*"([^"]+)"/)?.[1];

export const onRequest = defineRouteMiddleware(({ locals }) => {
  const { data } = locals.starlightRoute.entry;
  if (!version || !data.hero) return;
  data.hero.title = `${data.hero.title ?? data.title} <span class="hero-version">(v${version})</span>`;
});
