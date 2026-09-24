import { Page } from '@playwright/test';

/**
 * Post a form on the current page several times at once, the way a double-click does.
 *
 * The requests go out from the page itself with fetch(), so they carry the member's
 * cookies and the Sec-Fetch-Site: same-origin a real submit would - verify_post_check()
 * refuses anything else. They are started together and awaited together, so the server
 * sees them overlap rather than one after the other, which is the whole point: a click
 * followed by a click after the first page has loaded is just two submits.
 *
 * `overrides` replaces fields in the posted data. A BBCode editor only copies its content
 * back into the textarea on a real submit, so a form bound to one needs its value set here.
 *
 * Returns each response's body, in the order the requests were started.
 */
export async function submitFormAtOnce(
  page: Page,
  formSelector: string,
  { times = 2, overrides = {} }: { times?: number; overrides?: Record<string, string> } = {},
): Promise<string[]> {
  return page.evaluate(
    async ({ formSelector, times, overrides }) => {
      const form = document.querySelector<HTMLFormElement>(formSelector);
      if (!form) {
        throw new Error(`No form matches ${formSelector}`);
      }

      const data = new FormData(form);
      for (const [name, value] of Object.entries(overrides)) {
        data.set(name, value);
      }

      // Not form.action: a form with an input named "action" (the troop report's has one)
      // answers that with the input.
      const url = new URL(form.getAttribute('action') ?? '', document.baseURI).href;

      const responses = await Promise.all(
        Array.from({ length: times }, () =>
          fetch(url, { method: 'POST', body: data, credentials: 'same-origin' }),
        ),
      );

      return Promise.all(responses.map((response) => response.text()));
    },
    { formSelector, times, overrides },
  );
}
