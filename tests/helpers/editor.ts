import { Page, expect } from '@playwright/test';

/**
 * The event form's description box, which is MyBB's BBCode editor.
 *
 * sceditor hides the textarea it binds to and puts its own container beside it, so
 * `fill()` cannot reach the box any more - it is display:none, and Playwright refuses.
 * The value therefore goes in through the editor's own API, which is what typing into it
 * ends up calling, and `updateOriginal()` writes it back into the textarea the form
 * posts. `val()` takes BBCode source, so a fixture reads the same as it did before.
 *
 * The fallback is not dead code: the editor is off when the board's BBCode inserter is,
 * and the javaScriptEnabled:false specs run against the plain textarea the server still
 * renders. One helper covers both, so a spec does not have to know which it is on.
 */
export async function fillDescription(page: Page, textareaId: string, value: string) {
  await page.locator(`#${textareaId}`).waitFor({ state: 'attached' });

  // Waited for rather than assumed: the editor is only on the page when the board's
  // BBCode inserter is turned on, and when it is, the script attaching it runs before
  // load - so the wait costs nothing on the path it is there for.
  const hasEditor = await page
    .waitForFunction(
      (id) => !!document.getElementById(id)?.parentElement?.querySelector('.sceditor-container'),
      textareaId,
      { timeout: 2_000 },
    )
    .then(() => true, () => false);

  if (!hasEditor) {
    await page.locator(`#${textareaId}`).fill(value);
    return;
  }

  await page.evaluate(
    ({ v }) => {
      const editor = (window as unknown as { MyBBEditor: { val: (s: string) => void; updateOriginal: () => void } }).MyBBEditor;
      editor.val(v);
      editor.updateOriginal();
    },
    { v: value },
  );
}

/** What the editor currently holds, as BBCode - the value the form would post. */
export async function descriptionValue(page: Page, textareaId: string): Promise<string> {
  return page.evaluate(
    (id) => (document.getElementById(id) as HTMLTextAreaElement).value,
    textareaId,
  );
}

/**
 * Wait until sceditor has taken the textarea over.
 *
 * Its container is inserted *before* the box it replaces, so this looks inside the
 * field rather than at the textarea's following siblings.
 */
export async function expectEditorAttached(page: Page, textareaId: string) {
  const field = page.locator(`#${textareaId}`).locator('xpath=..');
  await expect(field.locator('.sceditor-container')).toHaveCount(1);
  await expect(page.locator(`#${textareaId}`)).toBeHidden();
}
