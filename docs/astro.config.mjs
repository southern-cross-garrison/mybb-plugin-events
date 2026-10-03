// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightThemeVintage from 'starlight-theme-vintage';
import starlightImageZoom from 'starlight-image-zoom';

// Published by .github/workflows/docs.yml to GitHub Pages, served on the garrison's own
// domain (set under the repo's Settings -> Pages -> Custom domain, with a CNAME record in
// 501scg.org's DNS). It is the root of that domain, so there is no `base`.
export default defineConfig({
  site: 'https://events-guide.501scg.org',

  integrations: [
    starlight({
      title: 'Events Guide',
      description: 'How to use the events system on the Southern Cross Garrison forums.',
      logo: { src: './src/assets/scg-logo.svg', alt: 'Southern Cross Garrison' },
      plugins: [starlightThemeVintage(), starlightImageZoom()],
      customCss: ['./src/styles/custom.css'],
      social: [
        {
          icon: 'github',
          label: 'Source code',
          href: 'https://github.com/southern-cross-garrison/mybb-plugin-events',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/southern-cross-garrison/mybb-plugin-events/edit/main/docs/',
      },
      lastUpdated: true,

      // One group per audience. Pages inside each folder are listed automatically, ordered
      // by `sidebar.order` in their frontmatter.
      sidebar: [
        { label: 'Troopers & wranglers', items: [{ autogenerate: { directory: 'members' } }] },
        { label: 'Event coordinators', items: [{ autogenerate: { directory: 'coordinators' } }] },
        { label: 'Administrators', items: [{ autogenerate: { directory: 'admins' } }] },
        {
          label: 'Webmasters',
          collapsed: true,
          items: [{ autogenerate: { directory: 'webmasters' } }],
        },
      ],
    }),
  ],
});
